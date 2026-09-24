/**
 * Build the phone app into integrations/mobile/dist.
 *
 * Output is self-contained static files: index.html, app.js, app.css, the web
 * manifest and icon. There are no runtime network dependencies (no CDN, fonts
 * or analytics), matching the gateway's `default-src 'none'` CSP. The same
 * directory can later be copied into an iOS wrapper such as Capacitor.
 */

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  entryPoints: { app: join(root, 'src', 'main.tsx') },
  outdir: output,
  bundle: true,
  format: 'esm',
  // Safari 15 / iOS 15 and later; older WebKit lacks features the app uses.
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
});

await cp(join(root, 'public'), output, { recursive: true });
console.log(`Built ${output}`);
