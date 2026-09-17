import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PauseControl } from '../../src/core/pause-control.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { DesktopServer } from '../../src/desktop/server.ts';
import { soundSamples } from '../../src/desktop/sounds.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { Segmenter, FRAME_SAMPLES } from '../../src/sensors/audio/segmenter.ts';

test('SQLite retains all transcripts and original intent, with linked recovery outcomes across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-db-test-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);

  try {
    await history.open();

    for (let id = 1; id <= 105; id++) {
      history.add({
        id,
        observedAt: id,
        utterance: `Speech ${id}`,
        application: { app: 'editor', title: 'Document', address: '0x123' },
      });
      history.setIntent(id, 'IGNORE');
      history.setOutcome(id, 'ignored');
      history.finish(id);
    }

    assert.equal(history.snapshot().length, 100);
    const latest = history.snapshot()[0];
    assert.equal(latest.utterance, 'Speech 105');
    const pasteId = history.beginPaste(latest.id, '0x456');
    history.finishPaste(pasteId, 'sent', 'terminal');
    history.beginPaste(latest.id, '0x789');
    history.add({ id: 106, observedAt: 106, utterance: 'Unfinished' });
    history.close();
    await history.open();

    assert.equal(history.find(latest.id)?.intent, 'IGNORE');
    assert.equal(history.find(latest.id)?.outcome, 'ignored');
    assert.equal(history.snapshot()[0].outcome, 'cancelled');

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT count(*) AS count FROM utterances').get()?.count, 106);
      const recovered = database
        .prepare(
          `SELECT u.transcript, u.application, u.recognized_intent,
        p.target_application FROM utterances u JOIN paste_events p ON u.id = p.utterance_id
        WHERE p.outcome = 'sent'`,
        )
        .get();
      assert.deepEqual(
        { ...recovered },
        {
          transcript: 'Speech 105',
          application: 'editor',
          recognized_intent: 'IGNORE',
          target_application: 'terminal',
        },
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS count FROM paste_events WHERE outcome = 'interrupted'")
          .get()?.count,
        1,
      );
    } finally {
      database.close();
    }

    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pause aborts the old period permanently and shutdown wakes a paused listener', async () => {
  const pause = new PauseControl();
  const oldSignal = pause.signal;
  pause.toggle();
  assert.equal(oldSignal.aborted, true);
  const shutdown = new AbortController();
  const waiting = pause.waitUntilResumed(shutdown.signal);
  pause.toggle();
  await waiting;
  assert.equal(oldSignal.aborted, true);
  assert.equal(pause.signal.aborted, false);
  assert.notEqual(pause.signal, oldSignal);

  pause.toggle();
  const stopping = pause.waitUntilResumed(shutdown.signal);
  shutdown.abort();
  await assert.rejects(stopping, /abort/i);
  assert.equal(pause.listenerCount('change'), 0);
});

test('private socket handles split JSON, reconnects, and refuses a second owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-socket-test-'));
  const path = join(directory, 'runtime/control.sock');
  const received: unknown[] = [];
  const server = new DesktopServer(
    path,
    () => ({ protocol: 1, paused: false }),
    async (request) => {
      received.push(request);
      return 'paused';
    },
  );
  const other = new DesktopServer(
    path,
    () => ({}),
    async () => '',
  );

  try {
    await server.start();
    await assert.rejects(other.start(), /already running/);
    await other.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const client = createConnection(path);
    client.setEncoding('utf8');
    let messages = '';
    const replied = new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('data', (chunk) => {
        messages += chunk;
        if (messages.includes('"type":"result"')) {
          resolve();
        }
      });
    });
    client.write('{"action":"toggle-');
    client.write('pause"}\n');
    await replied;
    client.destroy();
    assert.deepEqual(received, [{ action: 'toggle-pause' }]);
    assert.ok(messages.includes('"type":"state"'));
    await server.close();
    await server.start();
  } finally {
    await other.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sound cues are distinct and do not produce an utterance through the real VAD', async () => {
  const detector = await VoiceActivityDetector.create(
    new URL('../../assets/silero_vad_v5.onnx', import.meta.url).pathname,
  );
  const cues = ['processing', 'sent', 'ignored'] as const;

  try {
    assert.notDeepEqual(soundSamples('sent'), soundSamples('ignored'));

    for (const cue of cues) {
      detector.reset();
      const segmenter = new Segmenter();
      const sound = soundSamples(cue);
      const padded = new Float32Array(
        Math.ceil(sound.length / FRAME_SAMPLES) * FRAME_SAMPLES + 16000,
      );
      padded.set(sound);

      for (let offset = 0; offset + FRAME_SAMPLES <= padded.length; offset += FRAME_SAMPLES) {
        const frame = padded.slice(offset, offset + FRAME_SAMPLES);
        assert.equal(segmenter.push(await detector.probability(frame), frame), undefined);
      }

      assert.equal(segmenter.finish(), undefined);
    }
  } finally {
    await detector.close();
  }
});
