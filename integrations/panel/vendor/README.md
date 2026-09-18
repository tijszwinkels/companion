# Markdown parser

`markdown-it.mjs` contains markdown-it **15.0.2** and its browser dependencies,
under the MIT license. Source: https://github.com/markdown-it/markdown-it.
The generated bundle is committed so the QML panel works offline without a
Node process, package install, or build step at runtime.

Source archive: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.2.tgz

Verified npm integrity:
`sha512-q4IGxMv56jCqT4OCRCADBoDP3LO4MhmTXjFbphHPXs4g3j9Xg5RDnxqN8IF/3vIWEU+VCnUq+7JUg/cfy2E6Qw==`

The input is `package/dist/browser/markdown-it.umd.min.js`. Bundle this entry
with esbuild **0.28.1**, `bundle: true`, `target: 'es2016'`, `format: 'esm'`,
and `minify: true`:

```js
import MarkdownIt from './markdown-it.umd.min.js';
export function createParser(options) {
  return new MarkdownIt(options);
}
```

Use the contents of `base64-banner.js` as the esbuild `banner.js` option.
Qt needs the ES2016 syntax target and a binary-string base64 decoder for the
parser's entity tables. Its deprecated `Qt.atob(string)` decodes UTF-8 instead.
The same generated module also works in Node for offline checks.
Copy `package/LICENSE` alongside it as `markdown-it.LICENSE`. Styling, link policy,
and code-frame rendering belong in `../Markdown.mjs`, outside the vendor bundle.
`THIRD-PARTY-LICENSES.md` retains notices for the browser bundle's mdurl, uc.micro,
entities, linkify-it, and punycode.js dependencies.
