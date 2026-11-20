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
 * then reads the path until it holds valid JSON or two seconds pass, and
 * answers `{ type: 'done', incomplete }`, where `incomplete` lists every text
 * that existed but did not parse.
 */
const watcherSource = `
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

parentPort.on('message', (path) => {
  parentPort.postMessage({ type: 'watching' });

  const incomplete = [];
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    try {
      JSON.parse(text);
      break;
    } catch {
      incomplete.push(text);
    }
  }

  parentPort.postMessage({ type: 'done', incomplete });
});
`;

interface WatcherMessage {
  type: 'watching' | 'done';
  incomplete?: string[];
}

/** Resolve with the watcher's next message; reject if the watcher fails first. */
function nextMessage(watcher: Worker): Promise<WatcherMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: WatcherMessage) => {
      watcher.off('error', onError);
      resolve(message);
    };
    const onError = (error: Error) => {
      watcher.off('message', onMessage);
      reject(error);
    };

    watcher.once('message', onMessage);
    watcher.once('error', onError);
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

      // No temporary file is left behind next to the configuration.
      assert.deepEqual(await readdir(directory), ['companion-agent.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
