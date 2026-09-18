import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { PauseControl } from '../../src/core/pause-control.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';

test('media pause cancels a listening period permanently and resumes with a fresh signal', () => {
  const pause = new PauseControl();
  const first = pause.signal;
  let changes = 0;
  pause.on('change', () => changes++);

  pause.setMediaPlaying(true);
  assert.equal(pause.paused, true);
  assert.equal(pause.reason, 'media');
  assert.equal(first.aborted, true);

  pause.setMediaPlaying(true);
  assert.equal(changes, 1, 'Repeated reports must not churn listening periods');

  pause.setMediaPlaying(false);
  assert.equal(pause.paused, false);
  assert.equal(pause.reason, '');
  assert.equal(first.aborted, true);
  assert.equal(pause.signal.aborted, false);
  assert.notEqual(pause.signal, first);
});

test('ending playback never clears a manual pause', () => {
  const pause = new PauseControl();
  pause.toggle();
  pause.setMediaPlaying(true);
  pause.setMediaPlaying(false);
  assert.equal(pause.reason, 'manual');
  assert.equal(pause.signal.aborted, true);

  pause.toggle();
  assert.equal(pause.paused, false);
});

test('explicit resume overrides only the current playback period', () => {
  const pause = new PauseControl();
  pause.setMediaPlaying(true);
  pause.toggle();
  const resumed = pause.signal;

  pause.setMediaPlaying(true);
  assert.equal(pause.paused, false);
  assert.equal(pause.signal, resumed);

  pause.setMediaPlaying(false);
  pause.setMediaPlaying(true);
  assert.equal(pause.reason, 'media');
  assert.equal(resumed.aborted, true);

  // After overriding, a second toggle is an ordinary manual pause.
  pause.toggle();
  pause.toggle();
  pause.setMediaPlaying(false);
  assert.equal(pause.reason, 'manual');
});

test('media pause wakes on playback ending or shutdown while still paused', async () => {
  const pause = new PauseControl();
  const shutdown = new AbortController();
  pause.setMediaPlaying(true);
  const resumed = pause.waitUntilResumed(shutdown.signal);
  pause.setMediaPlaying(false);
  await resumed;

  pause.setMediaPlaying(true);
  const stopped = pause.waitUntilResumed(shutdown.signal);
  shutdown.abort();
  await assert.rejects(stopped, { name: 'AbortError' });
  assert.equal(pause.listenerCount('change'), 0);
});

test('private socket validates playback reports and broadcasts why listening paused', async (context) => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'));
  context.after(() => desktop.close());

  desktop.send({ action: 'media-playback', playing: 'Playing' });
  assert.equal((await desktop.reply('media-playback')).type, 'error');
  assert.equal(desktop.pause.paused, false);

  desktop.send({ action: 'media-playback', playing: true });
  assert.equal((await desktop.reply('media-playback')).result, 'media-recorded');
  assert.equal(desktop.pause.reason, 'media');
  assert.ok(desktop.messages.some((message) => message.pauseReason === 'media'));

  desktop.send({ action: 'toggle-pause' });
  assert.equal((await desktop.reply('toggle-pause')).result, 'listening');
  desktop.send({ action: 'media-playback', playing: true });
  await desktop.reply('media-playback');
  assert.equal(desktop.pause.paused, false);

  desktop.send({ action: 'toggle-pause' });
  await desktop.reply('toggle-pause');
  desktop.send({ action: 'media-playback', playing: false });
  await desktop.reply('media-playback');
  assert.equal(desktop.pause.reason, 'manual');
});

test('adapter disconnect releases only its playback report; reconnect can report current state', async (context) => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'));
  context.after(() => desktop.close());
  const other = createConnection(desktop.socketPath);
  const lines = createInterface({ input: other });
  let mediaRecorded = false;
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.action === 'media-playback' && message.type === 'result') {
      mediaRecorded = true;
    }
  });
  context.after(() => lines.close());
  context.after(() => other.destroy());
  await once(other, 'connect');

  desktop.send({ action: 'media-playback', playing: true });
  await desktop.reply('media-playback');
  other.write(JSON.stringify({ action: 'media-playback', playing: true }) + '\n');
  await waitFor(() => mediaRecorded);

  desktop.send({ action: 'media-playback', playing: false });
  await desktop.reply('media-playback');
  assert.equal(desktop.pause.reason, 'media', 'The other adapter is still playing');

  other.destroy();
  await waitFor(() => !desktop.pause.paused);
  desktop.send({ action: 'media-playback', playing: true });
  await desktop.reply('media-playback');
  assert.equal(desktop.pause.reason, 'media');

  desktop.client.destroy();
  await waitFor(() => !desktop.pause.paused);
});

test('file and supplied-text desktop modes can disable playback pausing', async (context) => {
  const desktop = await desktopFixture(async () => assert.fail('No desktop commands'), undefined, {
    mediaPause: false,
  });
  context.after(() => desktop.close());
  desktop.send({ action: 'media-playback', playing: true });
  await desktop.reply('media-playback');
  assert.equal(desktop.pause.paused, false);
  assert.ok(desktop.messages.some((message) => message.mediaPauseAvailable === false));
});
