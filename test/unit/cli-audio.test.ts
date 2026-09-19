import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const preload = fileURLToPath(new URL('../fixtures/no-audio.cjs', import.meta.url));

test('help, graph and supplied text acquire no audio worker or native runtime', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-cli-audio-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      asr: { workerBinary: '/nonexistent/asr-worker', modelDir: '/nonexistent/model' },
      vadModel: '/nonexistent/vad.onnx',
      llm: { baseUrl: 'http://127.0.0.1:1/v1' },
    }),
  );

  for (const args of [
    ['--help'],
    ['--graph', 'json'],
    ['--text', 'insert fixture', '--preview', '--no-desktop'],
  ]) {
    const { stdout } = await run(
      process.execPath,
      ['--require', preload, '--import', 'tsx', 'src/cli.ts', '--config', configPath, ...args],
      {
        cwd: project,
        env: { ...process.env, PATH: '/nonexistent' },
        timeout: 10000,
      },
    );
    if (args[0] === '--text') {
      assert.match(stdout, /fixture/);
      assert.match(stdout, /SEND_TEXT_TO_APPLICATION/);
    }
  }
});
