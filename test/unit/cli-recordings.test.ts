import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { restoreIntentRequest } from '../../src/core/intent-request.ts';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { findArtifact } from '../desktop-fixture.ts';
import { screenshot } from '../helpers.ts';

for (const classify of [false, true]) {
  test(
    classify
      ? '--text records the exact inference request through the real CLI'
      : '--text records its screenshot by utterance UUID without an audio file',
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), 'companion-cli-recordings-'));
      context.after(() => rm(directory, { recursive: true, force: true }));
      const binaries = join(directory, 'bin');
      await mkdir(binaries);

      // Redirect homedir() only in the child process, before its ESM imports load.
      // This exercises the real CLI/default paths without reading personal history.
      const preload = join(directory, 'fixture.cjs');
      await writeFile(
        preload,
        `require('node:os').homedir = () => process.env.COMPANION_TEST_DIRECTORY;
require('node:module').syncBuiltinESMExports();
`,
      );

      const window = {
        address: screenshot.window.address,
        class: screenshot.window.app,
        title: screenshot.window.title,
        at: [0, 0],
        size: [64, 64],
        monitor: 0,
        mapped: true,
        hidden: false,
      };
      const monitors = [{ id: 0, x: 0, y: 0, width: 640, height: 480, scale: 1, transform: 0 }];

      // Only capture commands are simulated. The child runs its actual CLI, desktop
      // service, SQLite migration, prefix routing, file writer, and cleanup paths.
      await writeFile(
        join(binaries, 'hyprctl'),
        `#!${process.execPath}
const action = process.argv.slice(2).join(' ');
if (action === '-j activewindow') {
  process.stdout.write(JSON.stringify(${JSON.stringify(window)}));
} else if (action === '-j monitors') {
  process.stdout.write(JSON.stringify(${JSON.stringify(monitors)}));
} else {
  throw Error('Unexpected desktop command: ' + action);
}
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(binaries, 'grim'),
        `#!${process.execPath}
process.stdout.write(Buffer.from('${screenshot.png.toString('base64')}', 'base64'));
`,
        { mode: 0o700 },
      );
      let baseUrl = 'http://127.0.0.1:1/v1';
      const requests: unknown[] = [];
      if (classify) {
        // No model is contacted: only Pi's real transport to our local fixture.
        const server = createServer(async (request, response) => {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
          }
          requests.push(JSON.parse(body));
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            'data: ' +
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'IGNORE' },
                    finish_reason: 'stop',
                  },
                ],
              }) +
              '\n\ndata: [DONE]\n\n',
          );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        context.after(async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      }
      const config = join(directory, 'config.json');
      await writeFile(config, JSON.stringify({ llm: { baseUrl } }));

      const execute = promisify(execFile);
      const utterance = classify
        ? 'Speech needing classification'
        : 'insert Supplied text for evaluation';
      const result = await execute(
        process.execPath,
        [
          '--require',
          preload,
          '--import',
          'tsx',
          'src/cli.ts',
          '--config',
          config,
          '--preview',
          '--text',
          utterance,
        ],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: {
            ...process.env,
            COMPANION_TEST_DIRECTORY: directory,
            XDG_RUNTIME_DIR: join(directory, 'runtime'),
            XDG_STATE_HOME: join(directory, 'old-state'),
            PATH: `${binaries}:${process.env.PATH}`,
          },
          timeout: 10000,
        },
      );
      assert.match(result.stdout, classify ? /IGNORE/ : /SEND_TEXT_TO_APPLICATION/);

      const storage = join(directory, 'companion');
      const database = new DatabaseSync(join(storage, 'utterances.sqlite'), { readOnly: true });
      try {
        const rows = database.prepare('SELECT * FROM utterances').all();
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.transcript, utterance);
        assert.equal(row.recognized_intent, classify ? 'IGNORE' : 'SEND_TEXT_TO_APPLICATION');
        assert.equal(row.outcome, classify ? 'ignored' : 'preview');
        assert.equal('screenshot_path' in row, false);
        assert.equal('audio_path' in row, false);
        const path = await findArtifact(storage, String(row.id), 'screenshots');
        assert.deepEqual(await readFile(path), screenshot.png);
        if (classify) {
          assert.equal(requests.length, 1);
          assert.equal(typeof row.intent_request, 'string');
          assert.deepEqual(
            restoreIntentRequest(row.intent_request as string, await readFile(path)).body,
            requests[0],
          );
        } else {
          assert.equal(row.intent_request, null, 'Prefix routing has no model request');
        }
        assert.deepEqual(await readdir(dirname(dirname(path))), ['screenshots']);
      } finally {
        database.close();
      }
    },
  );
}
