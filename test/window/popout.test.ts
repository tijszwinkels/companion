import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { offscreenPlatform } from './offscreen.ts';

/**
 * Pop-out conversation windows in the real native host and QML body
 * (popout.qml.in), offscreen, with a synthetic listener transport and
 * temporary configuration. Requires `npm run ui:build -- -DBUILD_TESTING=ON`.
 *
 * Not covered (supervised desktop checks): compositor placement and focus,
 * layer-shell width/exclusive zones on Wayland, and real speech routing.
 */

const execute = promisify(execFile);
const build = resolve('native/window/build');

test('pop-out windows move drafts, report one atomic view state and answer agents', async () => {
  const directory = await mkdtemp('/tmp/companion-popout-test-');
  try {
    const runtime = join(directory, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    const template = await readFile(new URL('./popout.qml.in', import.meta.url), 'utf8');
    const path = join(directory, 'tst_popout.qml');
    await writeFile(
      path,
      template.replace('@WINDOW@', new URL('../../integrations/window', import.meta.url).href),
    );

    try {
      const result = await execute(
        join(build, 'companion-window-tests'),
        ['-input', path, '-nocrashhandler'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, 'config'),
            XDG_CACHE_HOME: join(directory, 'cache'),
            XDG_RUNTIME_DIR: runtime,
            QT_QPA_PLATFORM: await offscreenPlatform(directory),
            QT_QUICK_BACKEND: 'software',
            QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
            QML_IMPORT_PATH: join(build, 'qml'),
          },
          timeout: 60_000,
          killSignal: 'SIGKILL',
        },
      );
      assert.match(result.stdout, /Totals: \d+ passed, 0 failed/);
    } catch (error) {
      throw Error([String(error), (error as any).stdout, (error as any).stderr].join('\n'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
