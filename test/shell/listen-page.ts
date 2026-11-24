import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestBrowser, type TestPage } from '../mobile/browser.ts';
import { microphonesFixture } from '../microphones-fixture.ts';
import { remoteFixture, waitFor } from '../remote-fixture.ts';
import { appDirectory, click, desktopPage, online, type Fixture } from './page.ts';

/**
 * Shared helpers of the Listen here browser suites (listen-here.test.ts,
 * listen-soak.test.ts): the built shell in headless Chromium with its fake
 * audio device playing a synthetic WAV, against the real gateway (with or
 * without `--allow-microphone`) and a real listener control socket whose
 * microphones are composed as in src/cli.ts (test/microphones-fixture.ts:
 * synthetic voice detector, the test recogniser). No real microphone is
 * used; everything runs on loopback in temporary directories.
 */

/**
 * A mono 16-bit 16 kHz WAV of "speech": bursts of a 200 Hz square wave at
 * `amplitude`, with silence between them. Chromium plays it in a loop as
 * the fake microphone. The browser's processing (gain, noise suppression)
 * changes its levels, so the test recogniser's words vary; tests only
 * check that utterances arrive.
 */
export async function writeSpeechWav(
  path: string,
  options: { amplitude?: number; burstMs?: number; silenceMs?: number; seconds?: number } = {},
): Promise<void> {
  const amplitude = options.amplitude ?? 0.3;
  const burstMs = options.burstMs ?? 700;
  const silenceMs = options.silenceMs ?? 900;
  const seconds = options.seconds ?? 6;
  const rate = 16_000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  const period = burstMs + silenceMs;

  for (let index = 0; index < samples; index++) {
    const milliseconds = ((index / rate) * 1000) % period;
    let value = 0;
    if (milliseconds >= silenceMs) {
      const high = Math.floor((index / rate) * 400) % 2 === 0;
      value = high ? amplitude : -amplitude;
    }
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

/**
 * Recorded by each page itself, before its own scripts run:
 * - `__liveTracks()`: microphone tracks still live (0 once released);
 * - `__binarySent`: binary WebSocket messages the page sent (audio pieces);
 * - `__audioStarts`: `audio-start` requests the page sent;
 * - `__holdAudioStart`: set to true to keep `audio-start` requests from
 *   leaving the page, as if the gateway had not answered yet;
 * - `__holdPermission`: set to true to make the next microphone request
 *   wait forever, as a browser does while its permission prompt is open.
 */
const pageProbe = `
  window.__streams = [];
  window.__binarySent = 0;
  window.__holdPermission = false;
  window.__holdAudioStart = false;
  window.__liveTracks = () => window.__streams
    .flatMap((stream) => stream.getTracks())
    .filter((track) => track.readyState === 'live').length;
  const devices = navigator.mediaDevices;
  if (devices && devices.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (window.__holdPermission) {
        return new Promise(() => {});
      }
      const stream = await original(constraints);
      window.__streams.push(stream);
      return stream;
    };
  }
  window.__audioStarts = 0;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data !== 'string') {
      window.__binarySent++;
    } else if (data.includes('"action":"audio-start"')) {
      window.__audioStarts++;
      if (window.__holdAudioStart) {
        return undefined;
      }
    }
    return send.call(this, data);
  };
`;

export async function listenSetup(
  context: { after(callback: () => Promise<void>): void },
  options: { allowMicrophone?: boolean } = {},
) {
  // Each resource's cleanup is registered as soon as it exists, so a setup
  // that fails halfway leaves nothing behind. `after` callbacks run in
  // registration order; each one only releases what it owns.
  const directory = await mkdtemp(join(tmpdir(), 'companion-listen-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const wav = join(directory, 'speech.wav');
  await writeSpeechWav(wav);

  const fixture = await remoteFixture({
    appDirectory,
    gateway: { allowMicrophone: options.allowMicrophone ?? true },
  });
  const microphones = microphonesFixture(fixture.desktop.runtime, fixture.desktop.pause);
  context.after(async () => {
    await microphones.close();
    await fixture.close();
  });

  const browser = new TestBrowser([
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
  ]);
  context.after(async () => {
    await browser.close();
  });
  await browser.start();
  return { fixture, microphones, browser };
}

/**
 * A paired page with the probe and the given microphone permission for the
 * gateway's origin (`granted`, `denied`, or `prompt`). `sharedContext`
 * opens another tab of an existing browser context (same pairing).
 */
export async function listeningPage(
  fixture: Fixture,
  browser: TestBrowser,
  options: {
    width?: number;
    height?: number;
    permission?: 'granted' | 'denied' | 'prompt';
    sharedContext?: string;
  } = {},
) {
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const opened = await desktopPage(browser, width, height, options.sharedContext ?? '');
  const { page, browserContextId } = opened;
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: pageProbe });
  await browser.call('Browser.setPermission', {
    permission: { name: 'microphone' },
    setting: options.permission ?? 'granted',
    origin: fixture.origin,
    browserContextId,
  });

  await page.navigate(`${fixture.origin}/`);
  if (!options.sharedContext) {
    await page.waitFor(`document.querySelector('#code')`);
    const { code } = await fixture.devices.createPairingCode();
    await click(page, '#code');
    await page.type(code);
    await click(page, 'button[type=submit]');
  }
  await page.waitFor(online, 8000);
  return opened;
}

/** Show the Activity column (if hidden) and wait for its microphone rows. */
export async function showActivity(page: TestPage): Promise<void> {
  const shown = await page.evaluate<boolean>(`Boolean(document.querySelector('.activity-column'))`);
  if (!shown) {
    await click(page, '.chat-bar .activity-toggle');
  }
  await page.waitFor(`document.querySelector('.microphone-rows')`, 8000);
}

/** The Listen here switch's state: `true`, `false`, or `''` when there is none. */
export function switchState(page: TestPage): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector('#microphone-this-browser')?.getAttribute('aria-checked') ?? ''`,
  );
}

/** Switch Listen here on and wait until the stream is open (the mark shows, the row says Listening). */
export async function startListening(page: TestPage): Promise<void> {
  await showActivity(page);
  await click(page, '#microphone-this-browser');
  await page.waitFor(`document.querySelector('.listen-mark.on') !== null`, 8000);
  // "Starting…" until the gateway accepted the stream.
  await page.waitFor(
    `document.querySelector('.microphone-row.this-browser')?.textContent.includes('Listening')`,
    8000,
  );
}

/** The text of this browser's row. */
export function browserRow(page: TestPage): Promise<string> {
  return page.evaluate<string>(
    `document.querySelector('.microphone-row.this-browser')?.textContent ?? ''`,
  );
}

export function liveTracks(page: TestPage): Promise<number> {
  return page.evaluate<number>(`window.__liveTracks()`);
}

/** The names of the browsers the listener has a stream of now. */
export function listenerStreams(microphones: ReturnType<typeof microphonesFixture>): string[] {
  return microphones.browsers.list.map((browser) => browser.name);
}

export { waitFor };
