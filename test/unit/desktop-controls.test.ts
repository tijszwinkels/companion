import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { PauseControl } from '../../src/core/pause-control.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { SoundFeedback } from '../../src/desktop/sounds.ts';
import { deferred } from '../helpers.ts';

interface ControlMessage {
  type: string;
  paused?: boolean;
  soundsEnabled?: boolean;
  speaking?: boolean;
  processing?: number;
  result?: string;
  message?: string;
}

/** Read the actual socket contract, including broadcasts before action replies. */
async function exchange(socket: string, action?: string): Promise<ControlMessage[]> {
  const client = createConnection({ path: socket, signal: AbortSignal.timeout(2000) });
  const lines = createInterface({ input: client });
  const messages: ControlMessage[] = [];

  try {
    if (action) {
      client.write(JSON.stringify({ action }) + '\n');
    }

    for await (const line of lines) {
      const message = JSON.parse(line) as ControlMessage;
      messages.push(message);

      if (!action || message.type === 'result' || message.type === 'error') {
        return messages;
      }
    }

    throw Error('Desktop socket closed before replying');
  } finally {
    lines.close();
    client.destroy();
  }
}

test('desktop sound controls work from a muted start independently of listening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-controls-test-'));
  const socket = join(directory, 'control.sock');
  const pause = new PauseControl();
  const controller = new AbortController();
  const runtime = new DesktopRuntime(pause, () => {}, controller.signal, {
    database: join(directory, 'utterances.sqlite'),
    socket,
    sounds: false,
    preview: false,
  });

  try {
    await runtime.start();
    assert.equal((await exchange(socket))[0].soundsEnabled, false);

    const enabled = await exchange(socket, 'toggle-sounds');
    assert.equal(enabled.at(-1)?.result, 'sounds-enabled');
    assert.ok(enabled.some((message) => message.soundsEnabled === true));
    assert.equal(pause.paused, false);

    await exchange(socket, 'toggle-pause');
    assert.equal(pause.paused, true);
    assert.equal((await exchange(socket))[0].soundsEnabled, true);

    const muted = await exchange(socket, 'toggle-sounds');
    assert.equal(muted.at(-1)?.result, 'sounds-muted');
    assert.ok(muted.some((message) => message.soundsEnabled === false));
    assert.equal(pause.paused, true);

    await exchange(socket, 'toggle-pause');
    assert.equal(pause.paused, false);
    assert.equal((await exchange(socket))[0].soundsEnabled, false);
  } finally {
    controller.abort();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview cannot enable audible feedback through desktop controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-preview-test-'));
  const socket = join(directory, 'control.sock');
  const controller = new AbortController();
  const runtime = new DesktopRuntime(new PauseControl(), () => {}, controller.signal, {
    database: join(directory, 'utterances.sqlite'),
    socket,
    sounds: true,
    preview: true,
  });

  try {
    await runtime.start();
    assert.equal((await exchange(socket))[0].soundsEnabled, false);
    const reply = (await exchange(socket, 'toggle-sounds')).at(-1);
    assert.equal(reply?.type, 'error');
    assert.match(reply?.message ?? '', /preview/);
    assert.equal((await exchange(socket))[0].soundsEnabled, false);
  } finally {
    controller.abort();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('speech state reaches the desktop independently of processing and clears on pause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-speech-test-'));
  const socket = join(directory, 'control.sock');
  const pause = new PauseControl();
  const controller = new AbortController();
  const runtime = new DesktopRuntime(pause, () => {}, controller.signal, {
    database: join(directory, 'utterances.sqlite'),
    socket,
    sounds: false,
    preview: true,
  });

  try {
    await runtime.start();
    assert.equal((await exchange(socket))[0].speaking, false);

    runtime.activity.processing?.(1);
    runtime.activity.speechChanged?.(true);
    const speaking = (await exchange(socket))[0];
    assert.equal(speaking.speaking, true);
    assert.equal(speaking.processing, 1);

    runtime.activity.speechChanged?.(false);
    const silence = (await exchange(socket))[0];
    assert.equal(silence.speaking, false);
    assert.equal(silence.processing, 1);

    runtime.activity.speechChanged?.(true);
    await exchange(socket, 'toggle-pause');
    assert.equal((await exchange(socket))[0].speaking, false);
    runtime.activity.speechChanged?.(true);
    assert.equal(
      (await exchange(socket))[0].speaking,
      false,
      'Late speech cannot revive paused state',
    );

    await exchange(socket, 'toggle-pause');
    runtime.activity.finished?.(1);
    const resumed = (await exchange(socket))[0];
    assert.equal(resumed.speaking, false);
    assert.equal(resumed.processing, 0);
  } finally {
    controller.abort();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'muting aborts playback and discards queued cues even after immediate unmute',
  { timeout: 3000 },
  async () => {
    const firstStarted = deferred<void>();
    const nextStarted = deferred<void>();
    const played: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    let firstSignal: AbortSignal | undefined;
    const sounds = new SoundFeedback(
      (_stage, message) => errors.push(message),
      controller.signal,
      true,
      async (_file, args, signal) => {
        played.push(basename(args[0]));

        if (played.length === 1) {
          firstSignal = signal;
          firstStarted.resolve();

          // Simulate a playing process that finishes only after cancellation.
          return new Promise<Buffer>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }

        nextStarted.resolve();
        return Buffer.alloc(0);
      },
    );

    try {
      await sounds.initialize();
      sounds.play('processing');
      sounds.play('ignored');
      await firstStarted.promise;

      sounds.setEnabled(false);
      assert.equal(firstSignal?.aborted, true);
      sounds.play('ignored');
      sounds.setEnabled(true);
      sounds.play('sent');
      await nextStarted.promise;

      assert.deepEqual(played, ['processing.wav', 'sent.wav']);
      assert.deepEqual(errors, []);
    } finally {
      controller.abort();
      await sounds.close();
    }
  },
);
