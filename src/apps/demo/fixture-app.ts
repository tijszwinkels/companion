/**
 * Synthetic "CSV notebook" app used by the demo and tests.
 *
 * It is an ordinary local web app, written the way any app might be, with no
 * Companion-specific protocol:
 *
 *   GET  /                 the page (strict CSP, refuses to be framed)
 *   GET  /app.js, /app.css page script and style
 *   GET  /api/state        datasets, this browser's visitor cookie, backend start time
 *   POST /api/datasets     a CSV file chosen in the browser (raw body, streamed to disk)
 *   POST /api/crash        demo failure: the backend exits
 *   WS   /api/events       status/log stream: hello, import progress, heartbeats
 *
 * Data is app-owned and durable: CSV files and an index under `--data`. The
 * backend checks its own Origin header against its Host (its own CSRF rule),
 * which also shows that the phone proxy preserves both. Uploads carry a
 * client-generated ID and are idempotent, so a user retrying after an unknown
 * outcome cannot create a duplicate.
 *
 * Usage: tsx fixture-app.ts --port 8123 --data /path/to/data [--host 127.0.0.1]
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';

interface Dataset {
  id: string;
  uploadId: string;
  name: string;
  bytes: number;
  rows: number;
  columns: string[];
  importedAt: number;
}

const maximumUploadBytes = 32 * 1024 * 1024;

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    data: { type: 'string' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.data) {
  console.error('Usage: fixture-app --port N --data DIRECTORY [--host 127.0.0.1]');
  process.exit(2);
}

const dataDirectory = values.data;
const datasetsDirectory = join(dataDirectory, 'datasets');
const indexPath = join(dataDirectory, 'datasets.json');
const startedAt = Date.now();

await mkdir(datasetsDirectory, { recursive: true });

// ---- Durable app-owned data ---------------------------------------------------

async function loadDatasets(): Promise<Dataset[]> {
  try {
    return JSON.parse(await readFile(indexPath, 'utf8')) as Dataset[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function saveDatasets(datasets: Dataset[]): Promise<void> {
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(datasets, null, 2));
  await rename(temporary, indexPath);
}

/** Imports serialize so two uploads cannot race on the index file. */
let importQueue: Promise<unknown> = Promise.resolve();

// ---- Event stream -------------------------------------------------------------

const events = new WebSocketServer({ noServer: true });

function broadcast(message: Record<string, unknown>): void {
  const text = JSON.stringify(message);
  for (const client of events.clients) {
    if (client.readyState === client.OPEN) {
      client.send(text);
    }
  }
}

events.on('connection', (client: WebSocket) => {
  client.send(JSON.stringify({ type: 'hello', startedAt }));
});

const heartbeat = setInterval(() => broadcast({ type: 'tick', at: Date.now() }), 5000);
heartbeat.unref();

// ---- HTTP ---------------------------------------------------------------------

/** The backend's own CSRF rule: state changes must come from its own page. */
function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function visitorCookie(request: IncomingMessage): string | undefined {
  const match = /(?:^|;\s*)fixture_visitor=([0-9a-f-]{36})/.exec(request.headers.cookie ?? '');
  return match?.[1];
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

/** Stream the request body to a file, counting rows as it goes. */
async function importCsv(
  request: IncomingMessage,
  name: string,
  uploadId: string,
): Promise<Dataset> {
  const id = randomUUID();
  const path = join(datasetsDirectory, `${id}.csv`);
  const file = createWriteStream(path, { flags: 'wx' });

  let bytes = 0;
  let newlines = 0;
  let lastByte = 0x0a;
  let header = '';
  let sawHeader = false;
  let lastReport = 0;

  try {
    for await (const chunk of request as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > maximumUploadBytes) {
        throw Error('File too large');
      }

      const text = chunk.toString('utf8');
      if (!sawHeader) {
        header += text;
        const newline = header.indexOf('\n');
        if (newline >= 0) {
          header = header.slice(0, newline);
          sawHeader = true;
        }
      }
      newlines += text.split('\n').length - 1;
      lastByte = chunk[chunk.length - 1];

      if (!file.write(chunk)) {
        await new Promise((resolve) => file.once('drain', resolve));
      }
      if (newlines - lastReport >= 500) {
        lastReport = newlines;
        broadcast({ type: 'log', text: `Importing ${name}: ${newlines} lines read` });
      }
    }
    await new Promise<void>((resolve, reject) =>
      file.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    file.destroy();
    await rm(path, { force: true });
    throw error;
  }

  // A final line without a trailing newline still counts; the header does not.
  const lines = newlines + (lastByte === 0x0a ? 0 : 1);

  return {
    id,
    uploadId,
    name,
    bytes,
    rows: Math.max(0, lines - 1),
    columns: header
      .replace(/\r$/, '')
      .split(',')
      .filter((column) => column.length > 0),
    importedAt: Date.now(),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');

  if (request.method === 'GET' && url.pathname === '/') {
    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    };
    if (!visitorCookie(request)) {
      headers['Set-Cookie'] =
        `fixture_visitor=${randomUUID()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    }
    response.writeHead(200, headers);
    response.end(pageHtml);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/app.css') {
    response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    response.end(pageStyle);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/app.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(pageScript);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    sendJson(response, 200, {
      startedAt,
      visitor: visitorCookie(request) ?? null,
      datasets: await loadDatasets(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/datasets') {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'Cross-origin request refused' });
      return;
    }

    const name = (url.searchParams.get('name') ?? 'upload.csv').slice(0, 200);
    const uploadId = url.searchParams.get('uploadId') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
      sendJson(response, 400, { error: 'uploadId required' });
      return;
    }

    const result = importQueue.then(async () => {
      const existing = (await loadDatasets()).find((dataset) => dataset.uploadId === uploadId);
      if (existing) {
        request.resume();
        return { dataset: existing, duplicate: true };
      }

      broadcast({ type: 'log', text: `Importing ${name}…` });
      const dataset = await importCsv(request, name, uploadId);
      await saveDatasets([...(await loadDatasets()), dataset]);
      broadcast({ type: 'log', text: `Imported ${name}: ${dataset.rows} rows` });
      broadcast({ type: 'datasets' });
      return { dataset, duplicate: false };
    });
    importQueue = result.catch(() => {});

    try {
      sendJson(response, 200, await result);
    } catch (error) {
      sendJson(response, 400, { error: String((error as Error).message) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/crash') {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'Cross-origin request refused' });
      return;
    }
    sendJson(response, 202, { stopping: true });
    broadcast({ type: 'log', text: 'Backend stopping (demo failure)' });
    setTimeout(() => process.exit(3), 50);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: String(error) });
    } else {
      response.destroy();
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  if (url.pathname !== '/api/events' || !sameOrigin(request)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  events.handleUpgrade(request, socket, head, (client) => events.emit('connection', client));
});

server.listen(port, values.host, () => {
  console.log(`CSV notebook listening on http://${values.host}:${port} (data: ${dataDirectory})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}

// ---- Page -----------------------------------------------------------------------

const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSV notebook</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<h1>CSV notebook <small>(synthetic demo app)</small></h1>
<p>Backend: <span id="status" data-state="connecting">connecting…</span></p>
<p>Opened <span id="visits">?</span> times in this browser profile.</p>
<section>
  <h2>Import a CSV file</h2>
  <input id="file" type="file" accept=".csv,text/csv">
  <button id="upload" type="button">Import</button>
  <p id="result" role="status"></p>
</section>
<section>
  <h2>Datasets</h2>
  <ul id="datasets"></ul>
</section>
<section>
  <h2>Activity</h2>
  <div id="log" aria-live="polite"></div>
</section>
<section>
  <h2>Browser features</h2>
  <button id="ask" type="button">Rename notebook…</button>
  <button id="crash" type="button">Stop backend (demo failure)</button>
  <p id="title"></p>
</section>
</body>
</html>`;

const pageStyle = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 40rem; }
  h1 { font-size: 1.3rem; }
  #status[data-state="connected"] { color: #1a7f37; }
  #status[data-state="reconnecting"] { color: #b35900; }
  #log { font-family: ui-monospace, monospace; font-size: 0.85rem; background: #f4f4f4;
         padding: 0.5rem; max-height: 12rem; overflow: auto; white-space: pre-wrap; }
  button, input { font-size: 1rem; min-height: 44px; }
  li { margin: 0.25rem 0; }
`;

const pageScript = `
const status = document.querySelector('#status');
const log = document.querySelector('#log');
const list = document.querySelector('#datasets');
const result = document.querySelector('#result');

function addLog(text) {
  const line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + '  ' + text;
  log.prepend(line);
}

// Browser storage belongs to this app's own profile/origin.
const visits = Number(localStorage.getItem('visits') || '0') + 1;
localStorage.setItem('visits', String(visits));
document.querySelector('#visits').textContent = String(visits);
document.querySelector('#title').textContent = localStorage.getItem('title') || '';

async function refresh() {
  const response = await fetch('/api/state');
  const state = await response.json();
  list.replaceChildren();
  for (const dataset of state.datasets) {
    const item = document.createElement('li');
    item.textContent = dataset.name + ' — ' + dataset.rows + ' rows (' + dataset.columns.join(', ') + ')';
    list.append(item);
  }
  document.body.dataset.visitor = state.visitor || '';
  document.body.dataset.datasets = String(state.datasets.length);
}

let delay = 500;
function connect() {
  const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events');
  socket.onopen = () => {
    delay = 500;
    status.textContent = 'connected';
    status.dataset.state = 'connected';
    void refresh();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'hello') {
      addLog('Connected to backend started at ' + new Date(message.startedAt).toLocaleTimeString());
      document.body.dataset.backendStartedAt = String(message.startedAt);
    } else if (message.type === 'log') {
      addLog(message.text);
    } else if (message.type === 'datasets') {
      void refresh();
    }
  };
  socket.onclose = () => {
    status.textContent = 'reconnecting…';
    status.dataset.state = 'reconnecting';
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 5000);
  };
}
connect();

document.querySelector('#upload').addEventListener('click', async () => {
  const file = document.querySelector('#file').files[0];
  if (!file) {
    result.textContent = 'Choose a CSV file first.';
    return;
  }
  // One ID per chosen file: retrying the same selection cannot import twice.
  const uploadId = crypto.randomUUID();
  result.textContent = 'Uploading ' + file.name + '…';
  try {
    const response = await fetch('/api/datasets?name=' + encodeURIComponent(file.name) + '&uploadId=' + uploadId, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: file,
    });
    const body = await response.json();
    result.textContent = response.ok ? 'Imported ' + body.dataset.rows + ' rows.' : 'Failed: ' + body.error;
  } catch {
    result.textContent = 'The upload outcome is unknown. Check the dataset list before importing again.';
  }
  await refresh();
});

document.querySelector('#ask').addEventListener('click', () => {
  const title = prompt('Notebook title', localStorage.getItem('title') || '');
  if (title !== null && confirm('Save "' + title + '"?')) {
    localStorage.setItem('title', title);
    document.querySelector('#title').textContent = title;
  }
});

document.querySelector('#crash').addEventListener('click', async () => {
  if (confirm('Stop the backend? Restart it with companion-app run.')) {
    await fetch('/api/crash', { method: 'POST' }).catch(() => {});
  }
});
`;
