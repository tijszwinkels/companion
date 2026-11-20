/**
 * Creating `companion-agent.json` while other loads read it.
 *
 * The first turns after a fresh start may load the configuration at the same
 * moment. A reader must see either no file or the complete file; an empty or
 * partial file fails the turn with "Unexpected end of JSON input".
 *
 * Loads in one process rarely catch the moment between creating and writing
 * the file, so a worker thread also reads the file in a tight synchronous loop
 * while the loads run. It reports any text that is not complete JSON.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { loadAgentConfiguration } from '../../src/agents/settings.ts';

/**
 * The watcher's code, run as plain JavaScript in a worker thread.
 *
 * Input message: the path to watch. It first answers `{ type: 'watching' }`,
 * then reads the path until it holds valid JSON, another read error occurs or
 * five seconds pass. Its answer is `{ type: 'done', complete, incomplete,
 * error }`: whether it read valid JSON, every text that existed but did not
 * parse, and the read error other than a missing file, if any.
 */
const watcherSource = `
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

parentPort.on('message', (path) => {
  parentPort.postMessage({ type: 'watching' });

  const incomplete = [];
  const deadline = Date.now() + 5000;
  let complete = false;
  let error;

  while (!complete && error === undefined && Date.now() < deadline) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (readError) {
      // Only a file that does not exist yet is expected.
      if (readError.code !== 'ENOENT') {
        error = String(readError);
      }
      continue;
    }

    try {
      JSON.parse(text);
      complete = true;
    } catch {
      incomplete.push(text);
    }
  }

  parentPort.postMessage({ type: 'done', complete, incomplete, error });
});
`;

interface WatcherMessage {
  type: 'watching' | 'done';
  complete?: boolean;
  incomplete?: string[];
  error?: string;
}

/** Longer than the watcher's own five-second deadline. */
const replyTimeoutMilliseconds = 10_000;

/**
 * Resolve with the watcher's next message. Reject if the watcher fails or
 * exits first, or does not answer in time, so the test cannot hang.
 */
function nextMessage(watcher: Worker): Promise<WatcherMessage> {
  return new Promise((resolve, reject) => {
    const stopListening = () => {
      clearTimeout(timer);
      watcher.off('message', onMessage);
      watcher.off('error', onError);
      watcher.off('exit', onExit);
    };

    const onMessage = (message: WatcherMessage) => {
      stopListening();
      resolve(message);
    };
    const onError = (error: Error) => {
      stopListening();
      reject(error);
    };
    const onExit = (code: number) => {
      stopListening();
      reject(Error(`The watcher exited with code ${code}`));
    };
    const timer = setTimeout(() => {
      stopListening();
      reject(Error('The watcher did not answer in time'));
    }, replyTimeoutMilliseconds);

    watcher.on('message', onMessage);
    watcher.on('error', onError);
    watcher.on('exit', onExit);
  });
}

test('simultaneous first loads only ever see a complete configuration file', async (context) => {
  const rounds = 200;
  const loadsPerRound = 8;

  const watcher = new Worker(watcherSource, { eval: true });
  context.after(() => watcher.terminate());

  for (let round = 0; round < rounds; round++) {
    const directory = await mkdtemp(join(tmpdir(), 'companion-agent-create-'));
    const path = join(directory, 'companion-agent.json');

    try {
      // Start the loads only once the watcher is reading.
      const watching = nextMessage(watcher);
      watcher.postMessage(path);
      assert.equal((await watching).type, 'watching');

      const watchResult = nextMessage(watcher);

      const loads: Promise<unknown>[] = [];
      for (let load = 0; load < loadsPerRound; load++) {
        loads.push(loadAgentConfiguration(directory));
      }
      const results = await Promise.allSettled(loads);

      const done = await watchResult;
      assert.equal(done.type, 'done');

      for (const result of results) {
        if (result.status === 'rejected') {
          assert.fail(`Round ${round}: a load failed: ${String(result.reason)}`);
        }
      }

      assert.deepEqual(
        done.incomplete,
        [],
        `Round ${round}: a reader saw an incomplete configuration file`,
      );
      assert.equal(done.error, undefined, `Round ${round}: the watcher could not read the file`);
      assert.equal(done.complete, true, `Round ${round}: the watcher never read the file`);

      // No temporary file is left behind next to the configuration.
      assert.deepEqual(await readdir(directory), ['companion-agent.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
