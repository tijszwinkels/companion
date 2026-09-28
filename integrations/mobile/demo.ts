/**
 * Synthetic phone-panel demo: `npm run mobile:demo`.
 *
 * Starts, inside one process and a temporary directory:
 *   - the real desktop control runtime (Unix socket, SQLite history) with a
 *     few registered intents and seeded Activity entries,
 *   - real agent sessions driven by a scripted backend that streams Markdown,
 *     tool calls and choices (no model, no network),
 *   - the real remote gateway on loopback, serving the built phone app,
 *   - with `--apps`: the synthetic CSV notebook local app, started by the real
 *     lifecycle code and offered to the phone through the app proxy on the
 *     synthetic origin http://csv-notebook.localhost:PORT+3 (docs/local-apps.md).
 *
 * It prints the URL and a pairing code. Open the URL in a desktop browser with
 * a phone-sized window (or device emulation). Nothing reads personal data,
 * starts the production listener, captures the screen or microphone, or binds
 * a non-loopback address. Ctrl+C removes the temporary directory.
 */

import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage, type AgentBackend, type AgentMessage } from '../../src/agents/types.ts';
import type { UserSensorFrame, UserSensorProcessor } from '../../src/core/frame.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { runApp } from '../../src/apps/launcher.ts';
import { AppRegistry } from '../../src/apps/registry.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { DeviceStore } from '../../src/remote/devices.ts';
import { Gateway } from '../../src/remote/gateway.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    apps: { type: 'boolean', default: false },
  },
});

const root = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(root, 'dist');

try {
  await access(join(appDirectory, 'index.html'));
} catch {
  console.error('Build the app first: npm run mobile:build');
  process.exit(1);
}

const directory = await mkdtemp(join(tmpdir(), 'companion-mobile-demo-'));
const controller = new AbortController();

// The demo's own agent profile, so defaults name the scripted demo models.
await writeFile(
  join(directory, 'companion-agent.json'),
  JSON.stringify({
    executable: 'demo-no-executable',
    model: 'cloud/demo-model',
    thinking: 'medium',
    quickQuestion: { model: 'local/qwen-demo', thinking: 'off' },
  }),
  { mode: 0o600 },
);

// ---- Synthetic screenshot ----------------------------------------------------

/** A small gradient PNG standing in for a captured window. */
function syntheticPng(width = 480, height = 300): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const band = y < 36 ? 40 : 0;
      row[1 + x * 3] = 30 + band + Math.round((x / width) * 60);
      row[2 + x * 3] = 90 + band + Math.round((y / height) * 80);
      row[3 + x * 3] = 80 + band + Math.round(((x + y) / (width + height)) * 90);
    }
    rows.push(row);
  }

  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let nextFrameId = 1;

function frame(utterance: string, app = 'org.gnome.TextEditor'): UserSensorFrame {
  return {
    id: nextFrameId++,
    observedAt: Date.now(),
    utterance,
    screenshot: {
      png: syntheticPng(),
      width: 480,
      height: 300,
      capturedAt: Date.now(),
      window: { address: '0xdemo', app, title: 'Synthetic window' },
    },
  };
}

// ---- Scripted agent backend -------------------------------------------------

const answers: Record<string, string> = {
  trip: `Here is a relaxed **two-day plan** for the synthetic city trip:

### Day 1
1. Morning walk along the river
2. Lunch at the market hall
3. Afternoon at the *modern art museum*

### Day 2
- Botanical garden
- Train home at 17:10

> All places in this demo are made up.

Want me to add restaurant options?`,
  code: `I looked at the failing test. The fixture returns \`undefined\` when the list is empty:

\`\`\`ts
export function first(items: string[]): string | undefined {
  return items[0];
}
\`\`\`

A guard in the caller fixes it. Should I apply the change?`,
  default: `Sure — here is a short answer with a list:

- Point one
- Point two, with a [local docs link](https://example.com/docs)

That is all synthetic text for the demo.`,
};

function pickAnswer(text: string): string {
  if (/trip|travel|city/i.test(text)) {
    return answers.trip;
  }
  if (/test|code|bug|fix/i.test(text)) {
    return answers.code;
  }
  return answers.default;
}

const scriptedRun: AgentBackend['run'] = async (request, signal, emit, publishChoices) => {
  const question = request.prompt.text;

  // A couple of tool calls first, like a coding agent reading files.
  if (/test|code|bug|fix/i.test(question)) {
    const calls: [string, string, string][] = [
      ['read', '{"path":"src/list.ts"}', 'export function first(items) {\n  return items[0];\n}\n'],
      ['bash', '{"command":"npm test -- list"}', 'not ok 1 - first() of empty list\n# fail 1\n'],
    ];
    for (const [name, input, output] of calls) {
      const id = randomUUID();
      const running: AgentMessage = { ...chatMessage(id, 'tool', ''), toolName: name, input };
      emit({ ...running, state: 'running' });
      await delay(400, undefined, { signal });
      emit({ ...running, text: output, state: 'done' });
    }
  }

  // Stream the answer word by word.
  const id = randomUUID();
  const words = pickAnswer(question).split(/(\s+)/);
  let text = '';
  for (const word of words) {
    text += word;
    emit({ ...chatMessage(id, 'assistant', text), state: 'running' });
    if (word.trim()) {
      await delay(35, undefined, { signal });
    }
  }
  emit({ ...chatMessage(id, 'assistant', text), state: 'done' });

  publishChoices?.(
    parseChoices(['[Yes] - Go ahead', '[More detail] - Explain further', '[No] - Stop here']),
  );
};

const sessions = new AgentSessions(
  {
    pi: {
      id: 'demo-backend',
      label: 'Scripted demo backend',
      dependencies: {},
      run: scriptedRun,
      async models() {
        return {
          models: ['local/qwen-demo', 'local/qwen-demo-large', 'cloud/demo-model'],
          pinned: ['local/qwen-demo', 'cloud/demo-model'],
          thinkingLevels: {
            'local/qwen-demo': ['off', 'low'],
            'local/qwen-demo-large': ['off', 'low', 'medium'],
            'cloud/demo-model': ['off', 'low', 'medium', 'high'],
          },
        };
      },
    },
  },
  () => {},
  directory,
);

// ---- Listener runtime with a few intents -------------------------------------

function demoProcessor(name: string, label: string, prefixes: string[], instruction?: string) {
  const processor: UserSensorProcessor = {
    id: name,
    label,
    dependencies: {},
    name,
    instruction,
    prefixes,
    async process() {},
    subscribe(router) {
      router.register(this);
    },
  };
  return processor;
}

const pause = new PauseControl();
const runtime = new DesktopRuntime(
  pause,
  () => {},
  controller.signal,
  {
    database: join(directory, 'utterances.sqlite'),
    socket: join(directory, 'control.sock'),
    preview: false,
    sounds: false,
    agents: sessions,
  },
  async () => {
    throw Error('The demo never runs desktop commands');
  },
);
await runtime.start();

const router = new UserSensorRouter(
  {
    detector: {
      id: 'demo-detector',
      label: 'No detector (demo)',
      dependencies: {},
      async detect() {
        throw Error('The demo does not classify speech');
      },
    },
  },
  () => {},
  runtime.activity,
);
for (const processor of [
  demoProcessor('IGNORE', 'Ignore', [], 'Not addressed to Companion'),
  demoProcessor('SEND_TEXT_TO_APPLICATION', 'Type text', ['insert'], 'Dictation'),
  demoProcessor('START_CODING_AGENT_SESSION', 'Coding session', ['new session'], 'Coding task'),
  demoProcessor('QUICK_QUESTION', 'Quick question', ['quick question'], 'Short question'),
  demoProcessor('GO_TO_SESSION', 'Go to session', ['go to session']),
]) {
  processor.subscribe(router);
}
await runtime.connectRouter(router);

// Seed this run's Activity with finished synthetic utterances.
const seeded: [string, string, 'sent' | 'ignored' | 'started', string][] = [
  [
    'Please send the draft to Sam by Friday.',
    'SEND_TEXT_TO_APPLICATION',
    'sent',
    'org.gnome.Evolution',
  ],
  ['Hmm, where did I put that file', 'IGNORE', 'ignored', 'org.gnome.Nautilus'],
  ['New session fix the failing list test', 'START_CODING_AGENT_SESSION', 'started', 'code'],
];
for (const [utterance, intent, outcome, app] of seeded) {
  const observed = frame(utterance, app);
  runtime.activity.transcribed?.(observed);
  runtime.activity.intentRecognized?.(observed.id, intent);
  runtime.activity.outcome?.(observed.id, outcome);
  runtime.activity.finished?.(observed.id);
}

// Two conversations: one coding question with a screenshot, one quick question.
sessions.start(
  frame('Why does the list test fail? Please fix the bug.', 'code'),
  controller.signal,
);
sessions.start(frame('Plan a two-day city trip for me'), controller.signal, 'quickQuestion');

// ---- Gateway --------------------------------------------------------------------

const port = Number(values.port);
const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const stateDirectory = join(directory, 'remote');

// Optional synthetic local app: registered with phone access, started by the
// real lifecycle code, served to the phone by the gateway's app proxy.
const appsPort = port + 3;
const notebookPort = port + 4;
const notebookOrigin = `http://csv-notebook.localhost:${appsPort}`;
const checkout = join(root, '..', '..');

if (values.apps) {
  const registry = new AppRegistry(join(directory, 'apps'));
  await registry.add({
    id: 'csv-notebook',
    name: 'CSV notebook (demo)',
    upstream: `http://127.0.0.1:${notebookPort}`,
    launch: {
      argv: [
        join(checkout, 'node_modules', '.bin', 'tsx'),
        join(checkout, 'src', 'apps', 'demo', 'fixture-app.ts'),
        '--port',
        String(notebookPort),
        '--data',
        join(directory, 'csv-notebook-data'),
      ],
      cwd: directory,
    },
  });
  const notebook = await registry.update('csv-notebook', { phoneAccess: true });

  await new Promise<void>((resolve, reject) => {
    runApp(notebook, { signal: controller.signal, output: 'ignore', onReady: resolve }).catch(
      reject,
    );
  });
}

const gateway = new Gateway({
  host: '127.0.0.1',
  port,
  origins,
  stateDirectory,
  controlSocket: join(directory, 'control.sock'),
  sessionsDirectory: join(directory, '.companion-sessions'),
  appDirectory,
  apps: values.apps
    ? {
        host: '127.0.0.1',
        port: appsPort,
        origins: [['csv-notebook', notebookOrigin]],
        registryDirectory: join(directory, 'apps'),
      }
    : undefined,
  log: (message) => console.error(`[remote] ${message}`),
});
await gateway.start();

const { code } = await new DeviceStore(stateDirectory).createPairingCode();

console.log(`
Companion phone demo (synthetic data only)

  Open:          http://127.0.0.1:${port}/
  Pairing code:  ${code.slice(0, 5)}-${code.slice(5)}   (10 minutes, one phone)

Use a phone-sized browser window or device emulation. New pairing code:
  bin/companion-remote pair --state-directory ${stateDirectory}
${
  values.apps
    ? `
  Local app:     CSV notebook at ${notebookOrigin} (Apps button in the header).
                 It opens in a new tab through the app proxy; *.localhost
                 names resolve to this computer in Chromium-based browsers.
`
    : ''
}
Temporary data: ${directory}
Press Ctrl+C to stop and delete it.
`);

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

console.error('Stopping…');
controller.abort();
await gateway.close();
await sessions.close();
await runtime.close();
await rm(directory, { recursive: true, force: true });
