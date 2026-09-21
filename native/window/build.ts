import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const source = fileURLToPath(new URL('./', import.meta.url));
const build = join(source, 'build');

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

// Extra CMake arguments support a staged dependency prefix or a window-only
// build. This command builds local artifacts; it never installs or launches UI.
await run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-DCMAKE_BUILD_TYPE=Release',
  ...process.argv.slice(2),
]);
await run('cmake', ['--build', build, '--parallel', '4']);
