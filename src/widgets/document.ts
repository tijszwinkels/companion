import { readFile } from 'node:fs/promises';
import type { WidgetBundle, WidgetRecord, WidgetViewport } from './types.ts';

const scripts = Promise.all(
  ['host', 'frame'].map((name) =>
    readFile(new URL(`../../integrations/widgets/${name}.js`, import.meta.url), 'utf8'),
  ),
);
const dataScript = (javascript: string) =>
  'data:text/javascript;base64,' + Buffer.from(javascript).toString('base64');

export const defaultViewport: WidgetViewport = {
  width: 480,
  height: 280,
  scale: 1,
  foreground: '#e0e6f0',
  background: '#17212d',
  accent: '#82aaff',
  muted: '#959faa',
};

export function expressionValue(value: unknown): string {
  // JSON.parse preserves JSON object semantics, including keys such as
  // __proto__; no data is interpolated as executable JavaScript syntax.
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

export async function widgetDocument(
  bundle: WidgetBundle,
  record: Pick<WidgetRecord, 'props' | 'revision' | 'name'>,
  theme: WidgetViewport,
  api?: string,
): Promise<string> {
  const [host, frame] = await scripts;
  const moduleUrl = dataScript(bundle.javascript);
  const document = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>
    :root { color: var(--foreground); background: var(--background); font-family: sans-serif; color-scheme: dark light; }
    body { margin: 0; padding: 12px; box-sizing: border-box; } * { box-sizing: border-box; }
    button, input, select { font: inherit; color: inherit; } button { cursor: pointer; }
    ${bundle.css}</style></head><body><div id="widget"></div><script type="module" src="${dataScript(`window.widgetModuleUrl=${JSON.stringify(moduleUrl)};\n${frame}`)}"></script></body></html>`;
  const bootstrap = {
    title: record.name,
    document,
    props: record.props,
    revision: record.revision,
    theme,
    api,
  };
  const code = `window.widgetBootstrap=${expressionValue(bootstrap)};\n${host}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Companion widget</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden} .error:empty{display:none}.error{position:fixed;bottom:0;left:0;right:0;padding:8px;background:#782a2a;color:white;font:14px sans-serif}</style></head><body><script src="${dataScript(code)}"></script></body></html>`;
}
