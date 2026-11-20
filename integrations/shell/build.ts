/**
 * Build the browser shell into integrations/shell/dist.
 *
 * Output is self-contained static files: index.html, app.js and app.css
 * (the desktop chat stylesheet plus the shell's own). There are no runtime
 * network dependencies (no CDN, fonts or analytics), matching the gateway's
 * `default-src 'none'` CSP. Serve it with
 * `companion-remote serve --app-directory integrations/shell/dist`.
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
  // Current desktop browsers on macOS, Windows and Linux. The chat stylesheet
  // uses color-mix(), which these versions support.
  target: ['es2022', 'chrome111', 'edge111', 'firefox113', 'safari16.4'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
});

await cp(join(root, 'public'), output, { recursive: true });
console.log(`Built ${output}`);
