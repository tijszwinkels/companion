/**
 * Build Companion's trusted HTML session pages into integrations/session-apps/dist.
 *
 * Output: chat.html/js/css (the conversation chat) and rail.html/js/css (the
 * session rail). The native ShellProfile serves exactly these files (plus
 * Qt's own qwebchannel.js) to the trusted views; there are no runtime
 * network dependencies. `npm run ui:build` runs
 * this before the native build, so a source-launched UI always finds it.
 */

import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  entryPoints: { chat: join(root, 'chat', 'main.tsx'), rail: join(root, 'rail', 'main.tsx') },
  outdir: output,
  bundle: true,
  format: 'esm',
  // The page only runs in the Qt WebEngine (Chromium) this host links.
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  legalComments: 'linked',
  logLevel: 'warning',
});

await copyFile(join(root, 'chat', 'index.html'), join(output, 'chat.html'));
await copyFile(join(root, 'rail', 'index.html'), join(output, 'rail.html'));
console.log(`Built ${output}`);
