import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('./build/', import.meta.url));
const executable = join(build, 'quickshell-build/src/quickshell');
await access(executable);
await access(join(build, 'qml/Companion/Widgets/libcompanionwidgets.so'));
if (
  process.env.QTWEBENGINE_DISABLE_SANDBOX ||
  /--no-sandbox|--disable-web-security/.test(process.env.QTWEBENGINE_CHROMIUM_FLAGS ?? '')
) {
  throw Error('Native widgets require Chromium sandboxing and web security');
}

// Explicit user entry point, never called by installation or npm start. The
// no-duplicate flag leaves a running Omarchy shell alone; this command neither
// stops it nor changes its launcher/system configuration.
const child = spawn(
  executable,
  ['--no-duplicate', '--path', join(process.env.OMARCHY_PATH || '/usr/share/omarchy', 'shell')],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      QML_IMPORT_PATH: [join(build, 'qml'), process.env.QML_IMPORT_PATH].filter(Boolean).join(':'),
      QS_DISABLE_FILE_WATCHER: '1',
      QS_NO_RELOAD_POPUP: '1',
    },
  },
);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
