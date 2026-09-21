import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./', import.meta.url));
const build = join(directory, 'build');
const jobs = '4';

async function run(executable: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(Error(`${executable} exited with ${code}`));
      }
    });
  });
}

async function source(name: string, url: string, hash: string) {
  const archive = join(build, name + '.tar.gz');
  let content: Buffer;
  try {
    content = await readFile(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    console.log(`Downloading pinned ${name} sources into the private build directory`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw Error(`Could not download ${name}: ${response.status}`);
    }
    content = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(content).digest('hex') !== hash) {
    throw Error(`${name} archive checksum does not match the pinned source`);
  }
  await writeFile(archive, content);
  const path = join(build, name + '-source');
  try {
    await access(join(path, 'CMakeLists.txt'));
  } catch {
    await mkdir(path, { recursive: true });
    await run('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '-C', path]);
  }
  return path;
}

async function replace(path: string, before: string, after: string) {
  const contents = await readFile(path, 'utf8');
  if (contents.includes(after)) {
    return;
  }
  if (contents.split(before).length !== 2) {
    throw Error(`Pinned host source did not match the expected patch: ${path}`);
  }
  await writeFile(path, contents.replace(before, after));
}

await mkdir(build, { recursive: true });
await run('cmake', ['-S', directory, '-B', build, '-DCMAKE_BUILD_TYPE=Release']);
await run('cmake', ['--build', build, '--parallel', jobs]);

if (process.argv.includes('--host')) {
  // Neither build dependency nor Quickshell is installed into system paths.
  // Pin both archives and make the small host startup delta explicit below.
  const cli = await source(
    'cli11',
    'https://codeload.github.com/CLIUtils/CLI11/tar.gz/refs/tags/v2.5.0',
    '17e02b4cddc2fa348e5dbdbb582c59a3486fa2b2433e70a0c3bacb871334fd55',
  );
  const dependencies = join(build, 'dependencies');
  await run('cmake', [
    '-S',
    cli,
    '-B',
    join(build, 'cli11-build'),
    '-DCLI11_BUILD_TESTS=OFF',
    '-DCLI11_BUILD_EXAMPLES=OFF',
    '-DCMAKE_INSTALL_PREFIX=' + dependencies,
  ]);
  await run('cmake', ['--install', join(build, 'cli11-build')]);

  const host = await source(
    'quickshell',
    'https://codeload.github.com/quickshell-mirror/quickshell/tar.gz/28771c7c74b42e20afca0b1b63980cb46515537c',
    'dd938be236aab261597dd2fcf416aa09f16a285ca45dd19e80216695f787f907',
  );
  await replace(
    join(host, 'CMakeLists.txt'),
    'set(QT_FPDEPS Gui Qml Quick QuickControls2 Widgets ShaderTools)',
    'set(QT_FPDEPS Gui Qml Quick QuickControls2 Widgets ShaderTools WebEngineQuick)',
  );
  await replace(
    join(host, 'src/launch/CMakeLists.txt'),
    'Qt::Quick Qt::Widgets CLI11::CLI11 quickshell-build',
    'Qt::Quick Qt::Widgets Qt::WebEngineQuick CLI11::CLI11 quickshell-build',
  );
  const launch = join(host, 'src/launch/launch.cpp');
  await replace(
    launch,
    '#include "launch_p.hpp"',
    '#include "launch_p.hpp"\n#include <QtWebEngineQuick/qtwebenginequickglobal.h>\n#include "companion_widgets.hpp"',
  );
  await replace(
    launch,
    'auto qArgC = 0;',
    'char nativeArgument[] = "--companion-native-widgets";\n\tchar* qtArguments[] = {argv[0], nativeArgument, nullptr};\n\tauto qArgC = 2;\n\tregisterWidgetScheme();\n\tQtWebEngineQuick::initialize();',
  );
  await replace(launch, 'new QApplication(qArgC, argv)', 'new QApplication(qArgC, qtArguments)');
  await replace(
    launch,
    'new QGuiApplication(qArgC, argv)',
    'new QGuiApplication(qArgC, qtArguments)',
  );
  const header = await readFile(join(directory, 'initialize.hpp'), 'utf8');
  const headerPath = join(host, 'src/launch/companion_widgets.hpp');
  if ((await readFile(headerPath, 'utf8').catch(() => '')) !== header) {
    await writeFile(headerPath, header);
  }
  const hostBuild = join(build, 'quickshell-build');
  await run('cmake', [
    '-S',
    host,
    '-B',
    hostBuild,
    '-G',
    'Unix Makefiles',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_PREFIX_PATH=' + dependencies,
    '-DCRASH_HANDLER=OFF',
    '-DUSE_JEMALLOC=OFF',
    '-DNO_PCH=ON',
    '-DDISTRIBUTOR=Companion native widget development',
  ]);
  // Qt's generated DBus sources must exist before dependent Make autogen rules.
  await run('cmake', ['--build', hostBuild, '--target', 'quickshell-dbus', '--parallel', jobs]);
  await run('cmake', ['--build', hostBuild, '--parallel', jobs]);
}

console.log('Native widget build complete. No shell, listener or installed files were changed.');
