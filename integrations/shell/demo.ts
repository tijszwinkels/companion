/**
 * Synthetic browser-shell demo: `npm run shell:demo`.
 *
 * Starts, inside one process and a temporary directory (modelled on
 * integrations/mobile/demo.ts):
 *   - the real desktop control runtime (Unix socket, SQLite history),
 *   - real agent sessions driven by a scripted backend that streams Markdown,
 *     tool calls and choices (no model, no network),
 *   - the real remote gateway on loopback, serving the built browser shell
 *     (integrations/shell/dist) through its `appDirectory` option.
 *
 * The listener run has a few registered intents and synthetic Activity
 * entries of different kinds (typed into an application, ignored, a started
 * conversation, audio only, not saved); listening starts paused for media,
 * and a new synthetic entry is heard every 40 seconds (six in all), so the
 * new-activity marker can be seen while the Activity column is hidden.
 *
 * Tool details, screenshots and models: the bug-fix conversation's turn
 * made two tool calls (open the group in the chat; a long output pages);
 * the city-trip question kept its synthetic screenshot (View screenshot);
 * the other conversations' screenshots were not kept. The bar's model
 * picker lists two Pi models (one pinned; Show all models lists both).
 *
 * Turn and message times: one conversation (the invoice export) was asked
 * "yesterday" and continued today, so its messages show both kinds of
 * time; the flaky-test conversation's turn keeps running, so its timer
 * counts in the bar and the list; the others show how long their last turn
 * took. (The listener's clock is set to noon of the previous calendar day,
 * in this computer's time zone, for that first turn only; see `demoClock`.)
 *
 * Inline widgets: the gateway also runs a frame origin on a second loopback
 * port, and the city-trip answer is followed by a synthetic packing-list
 * widget the reader can tick off in the chat. The weekend-budget conversation
 * has a pinned widget, a small budget table above the chat or at the
 * right (by the window's shape). The library is written into
 * the temporary directory, and its actions run in this process
 * (test/widget-node-renderer.ts), not in the isolated widget renderer;
 * the browser draws it from the same bundle.
 *
 * Listen here: the gateway lets its page use the microphone
 * (`--allow-microphone`) and the listener has microphones with the test
 * recogniser (test/microphones-fixture.ts), so switching Listen here on in
 * Activity sends the browser's microphone, and what it hears appears in
 * Activity as words for its loudness ("w3 w5"), named after the browser.
 *
 * It prints the URL and a pairing code. Open the URL in a desktop browser.
 * Nothing reads personal data, starts the production listener, captures the
 * screen, or binds a non-loopback address; the microphone is used only when
 * the reader switches Listen here on in the browser. Ctrl+C stops
 * everything and removes the temporary directory.
 *
 * Options: --port N (default 8788), --frame-port N (default the port + 1).
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { widgetTools } from '../../src/agents/widget-tools.ts';
import { chatMessage, type AgentBackend, type AgentMessage } from '../../src/agents/types.ts';
import type { UserSensorFrame, UserSensorProcessor } from '../../src/core/frame.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { CaptureStoragePolicy, notAdmitted } from '../../src/capture-storage/policy.ts';
import { DeviceStore } from '../../src/remote/devices.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { syntheticWindowPng } from './synthetic-window.ts';
import { microphonesFixture } from '../../test/microphones-fixture.ts';
import { useNodeRenderer } from '../../test/widget-node-renderer.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8788' },
    'frame-port': { type: 'string' },
  },
});

const root = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(root, 'dist');

try {
  await access(join(appDirectory, 'index.html'));
} catch {
  console.error('Build the shell first: npm run shell:build');
  process.exit(1);
}

/**
 * Ctrl+C (SIGINT) or SIGTERM, also while the demo is still starting: the
 * listeners are installed before the temporary directory exists, so the
 * default action (exit without cleanup) never applies. The first signal ends
 * the wait below, or, during startup, skips the remaining steps; cleanup then
 * runs in `finally`. A second signal while cleanup is still running deletes
 * the directory at once and exits.
 */
let stopRequested = false;
let directory = '';
let resolveStop = () => {};
const stopped = new Promise<void>((resolve) => {
  resolveStop = resolve;
});

function onStopSignal(): void {
  if (!stopRequested) {
    stopRequested = true;
    resolveStop();
    return;
  }
  console.error('Stopping at once; deleting the temporary data.');
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(130);
}

process.on('SIGINT', onStopSignal);
process.on('SIGTERM', onStopSignal);

/** Thrown between startup steps when a stop was requested meanwhile. */
class StartupStopped extends Error {}

function continueStartup(): void {
  if (stopRequested) {
    throw new StartupStopped('stopped during startup');
  }
}

/**
 * Settle the demo's unread marks before anyone can pair: wait until every
 * conversation in `turns` has asked its number of questions (the invoice
 * export asks two, the second after the first turn) and its last answer has
 * completed, then mark each of them read except `unreadId`, as if a device
 * had shown it then (the listener's shared mark, src/desktop/README.md
 * "Unread mark"). The demo then starts with `unreadId` as its one unread
 * conversation. Checks every 50 ms, at most for 30 seconds (the scripted
 * answers take a few seconds); a stop requested meanwhile ends the startup
 * (`continueStartup`), and marks not settled by then fail the startup, so
 * the demo never prints a pairing code with the wrong marks.
 */
async function settleDemoMarks(
  agentSessions: AgentSessions,
  turns: Map<string, number>,
  unreadId: string,
): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 50) {
    continueStartup();

    const snapshot = agentSessions.snapshot();
    let settled = true;
    for (const [id, questions] of turns) {
      const session = snapshot.find((candidate) => candidate.id === id);
      if (!session) {
        settled = false;
        continue;
      }
      const asked = session.messages.filter((message) => message.kind === 'user').length;
      const done = session.status === 'completed' && session.turnStartedAt === undefined;
      if (asked < questions || !done || session.unread !== true) {
        settled = false;
      }
    }

    if (settled) {
      for (const id of turns.keys()) {
        if (id !== unreadId) {
          agentSessions.markRead(id);
        }
      }
      return;
    }
    await delay(50);
  }
  throw Error('The demo conversations did not finish their scripted answers in 30 seconds.');
}

directory = await mkdtemp(join(tmpdir(), 'companion-shell-demo-'));
const controller = new AbortController();

// What has been started so far, so that a failed start (for example a port
// that is already taken) stops exactly that and still deletes the temporary
// directory. Everything below runs inside try/finally for that reason.
let sessions: AgentSessions | undefined;
let runtime: DesktopRuntime | undefined;
let runtimeStarted = false;
let gateway: Gateway | undefined;
let microphones: ReturnType<typeof microphonesFixture> | undefined;

try {
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

  let nextFrameId = 1;

  /** A complete 1×1 PNG standing in for a captured window. */
  const syntheticPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  );

  /**
   * A spoken request with a synthetic screenshot. Conversations keep it only
   * when `keep` is set (the city trip): the others were "not saved", as
   * with capture storage off.
   */
  function frame(
    utterance: string,
    application = 'org.example.Editor',
    keep = false,
  ): UserSensorFrame {
    const frameId = nextFrameId;
    nextFrameId++;
    const result: UserSensorFrame = {
      id: frameId,
      observedAt: Date.now(),
      utterance: utterance,
      screenshot: {
        png: keep ? windowPng : syntheticPng,
        width: keep ? windowWidth : 1,
        height: keep ? windowHeight : 1,
        capturedAt: Date.now(),
        window: { address: '0xdemo', app: application, title: 'Synthetic window' },
      },
    };
    if (!keep) {
      result.storage = notAdmitted;
    }
    return result;
  }

  // A synthetic window for the kept screenshot: a title bar and lines of
  // "text" on a dark background, drawn here (no file, no capture).
  const windowWidth = 640;
  const windowHeight = 400;
  const windowPng = syntheticWindowPng(windowWidth, windowHeight);
  // ---- Widget library ---------------------------------------------------------

  // One synthetic widget: a packing list whose items are ticked off in the
  // chat. Its action runs in this process (useNodeRenderer, below).
  const widgetLibrary = join(directory, 'widget-library');
  const packingList = join(widgetLibrary, 'packing-list');
  await mkdir(packingList, { recursive: true });
  await writeFile(
    join(packingList, 'widget.json'),
    JSON.stringify({
      name: 'packing-list',
      version: 1,
      description: 'A synthetic packing list for the demo trip.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 80 },
                packed: { type: 'boolean' },
              },
              required: ['text', 'packed'],
              additionalProperties: false,
            },
            default: [],
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      actions: {
        toggle: {
          description: 'Pack or unpack one item.',
          parameters: {
            type: 'object',
            properties: { index: { type: 'integer', minimum: 0, maximum: 19 } },
            required: ['index'],
            additionalProperties: false,
          },
          returns: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      example: { items: [{ text: 'Rain jacket', packed: false }] },
    }),
  );
  await writeFile(
    join(packingList, 'widget.js'),
    `export function describe(props) {
  const packed = props.items.filter((item) => item.packed).length;
  return 'Packing list: ' + packed + ' of ' + props.items.length + ' packed';
}
export const actions = {
  toggle(props, args) {
    const item = props.items[args.index];
    if (item) {
      item.packed = !item.packed;
    }
    return { props, result: {} };
  },
};
export function mount(root, api) {
  const list = document.createElement('ul');
  const summary = document.createElement('p');
  root.append(list, summary);
  return {
    update(props) {
      list.replaceChildren();
      props.items.forEach((item, index) => {
        const entry = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = item.packed;
        // A refused change shows the saved state again (no update follows it).
        box.onchange = () => {
          void api.call('toggle', { index }).catch(() => {
            box.checked = item.packed;
          });
        };
        label.append(box, ' ' + item.text);
        entry.append(label);
        list.append(entry);
      });
      summary.textContent = describe(props);
    },
    dispose() {},
  };
}
`,
  );
  await writeFile(
    join(packingList, 'style.css'),
    'ul { list-style: none; margin: 0; padding: 0; } li { padding: 4px 0; } p { margin: 8px 0 0; color: var(--muted); font-size: 0.85rem; } input { accent-color: var(--accent); }\n',
  );

  // A second one, pinned by its conversation: the trip's budget as a table
  // with its total (no actions).
  const tripBudget = join(widgetLibrary, 'trip-budget');
  await mkdir(tripBudget, { recursive: true });
  await writeFile(
    join(tripBudget, 'widget.json'),
    JSON.stringify({
      name: 'trip-budget',
      version: 1,
      description: 'A synthetic budget for the demo trip.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 80 },
                euros: { type: 'integer', minimum: 0, maximum: 100000 },
              },
              required: ['label', 'euros'],
              additionalProperties: false,
            },
            default: [],
          },
        },
        required: ['rows'],
        additionalProperties: false,
      },
      actions: {},
      example: { rows: [{ label: 'Hotel', euros: 180 }] },
    }),
  );
  await writeFile(
    join(tripBudget, 'widget.js'),
    `export function describe(props) {
  const total = props.rows.reduce((sum, row) => sum + row.euros, 0);
  return 'Trip budget: ' + total + ' euros';
}
export function mount(root) {
  const table = document.createElement('table');
  root.append(table);
  return {
    update(props) {
      table.replaceChildren();
      for (const row of props.rows) {
        const line = table.insertRow();
        line.insertCell().textContent = row.label;
        line.insertCell().textContent = row.euros + ' €';
      }
      const total = table.insertRow();
      total.className = 'total';
      total.insertCell().textContent = 'Total';
      total.insertCell().textContent = props.rows.reduce((sum, row) => sum + row.euros, 0) + ' €';
    },
    dispose() {},
  };
}
`,
  );
  await writeFile(
    join(tripBudget, 'style.css'),
    'table { width: 100%; border-collapse: collapse; } td { padding: 4px 0; } td + td { text-align: right; } tr.total td { border-top: 1px solid var(--muted); font-weight: 600; }\n',
  );
  continueStartup();

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
- Point two, with a [documentation link](https://example.com/docs)

Agent text such as <b>this tag</b> stays literal. That is all synthetic text for the demo.`,
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

  /**
   * One turn: for coding questions two tool calls first, then the answer
   * streamed word by word, then three choices. Stops when the turn is stopped.
   */
  const scriptedRun: AgentBackend['run'] = async (request, signal, emit, publishChoices) => {
    const question = request.prompt.text;

    // The "working" conversation of the demo: its turn runs until it is
    // stopped (Stop in the chat, or closing it), so the list shows the
    // turning ring and the bar shows `working…`.
    if (/flaky/i.test(question)) {
      emit({
        ...chatMessage(randomUUID(), 'assistant', 'Running the suite 20 times…'),
        state: 'running',
      });
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }

    if (/test|code|bug|fix/i.test(question)) {
      const calls: [string, string, string][] = [
        [
          'read',
          '{"path":"src/list.ts"}',
          'export function first(items) {\n  return items[0];\n}\n',
        ],
        ['bash', '{"command":"npm test -- list"}', 'not ok 1 - first() of empty list\n# fail 1\n'],
      ];
      // A long output, so the details page through it (8,192 characters a page).
      const log: string[] = [];
      for (let line = 1; line <= 400; line++) {
        log.push(`ok ${line} - synthetic check number ${line}`);
      }
      calls.push(['bash', '{"command":"npm test -- --verbose"}', log.join('\n') + '\n']);
      for (const [name, input, output] of calls) {
        const id = randomUUID();
        const running: AgentMessage = { ...chatMessage(id, 'tool', ''), toolName: name, input };
        emit({ ...running, state: 'running' });
        await delay(400, undefined, { signal });
        emit({ ...running, text: output, state: 'done' });
      }
    }

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

    // The trip plan comes with an inline widget (a packing list).
    if (/trip|travel|city/i.test(question) && request.widgets) {
      const publish = widgetTools(request.widgets.endpoint, request.widgets.token).find(
        (tool) => tool.name === 'companion_widget',
      );
      await publish?.execute('demo-packing-list', {
        widget: 'packing-list',
        props: {
          items: [
            { text: 'Rain jacket', packed: true },
            { text: 'Museum tickets', packed: false },
            { text: 'Train tickets home (17:10)', packed: false },
            { text: 'Walking shoes', packed: true },
          ],
        },
      });
    }

    // The budget conversation pins its widget above the chat.
    if (/budget/i.test(question) && request.widgets) {
      const publish = widgetTools(request.widgets.endpoint, request.widgets.token).find(
        (tool) => tool.name === 'companion_widget',
      );
      await publish?.execute('demo-trip-budget', {
        widget: 'trip-budget',
        props: {
          rows: [
            { label: 'Train tickets', euros: 84 },
            { label: 'Hotel, one night', euros: 135 },
            { label: 'Museum', euros: 18 },
            { label: 'Meals', euros: 90 },
          ],
        },
        presentation: { placement: 'pinned', heightPercent: 30 },
      });
    }

    if (publishChoices) {
      publishChoices(
        parseChoices(['[Yes] - Go ahead', '[More detail] - Explain further', '[No] - Stop here']),
      );
    }
  };

  /**
   * The listener's clock for the demo's conversations: real time, except
   * while the first conversation's first turn runs, when it is noon of the
   * previous calendar day (whatever the hour now), so that turn's messages
   * were written "yesterday" in this computer's time zone.
   */
  const today = new Date();
  const yesterdayNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  let demoClockShift = yesterdayNoon.getTime() - Date.now();
  const demoClock = () => Date.now() + demoClockShift;

  sessions = new AgentSessions(
    {
      pi: {
        id: 'demo-backend',
        label: 'Scripted demo backend',
        dependencies: {},
        run: scriptedRun,
        async models() {
          return {
            models: ['local/qwen-demo', 'cloud/demo-model'],
            pinned: ['local/qwen-demo'],
            thinkingLevels: {
              'local/qwen-demo': ['off', 'low'],
              'cloud/demo-model': ['off', 'low', 'medium', 'high'],
            },
          };
        },
      },
    },
    () => {},
    directory,
    widgetLibrary,
    undefined,
    // On, so the one conversation that keeps its screenshot (see frame())
    // can; the others' frames are not admitted.
    CaptureStoragePolicy.enabledForTesting(),
    demoClock,
  );
  // The widget's actions and descriptions run in this process; the
  // isolated widget renderer is not used by the demo.
  useNodeRenderer((sessions as unknown as { widgets: { renderer: object } }).widgets.renderer);

  // ---- Listener runtime ------------------------------------------------------------

  const pause = new PauseControl();
  runtime = new DesktopRuntime(
    pause,
    () => {},
    controller.signal,
    {
      database: join(directory, 'utterances.sqlite'),
      socket: join(directory, 'control.sock'),
      preview: false,
      sounds: false,
      agents: sessions,
      captureStorage: CaptureStoragePolicy.enabledForTesting(),
    },
    async () => {
      throw Error('The demo never runs desktop commands');
    },
  );
  continueStartup();
  await runtime.start();
  runtimeStarted = true;
  continueStartup();

  // ---- Intents and Activity ------------------------------------------------------

  /** A registered intent that does nothing (the demo never routes speech). */
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
  const processors = [
    demoProcessor('IGNORE', 'Ignore', [], 'Not addressed to Companion'),
    demoProcessor('SEND_TEXT_TO_APPLICATION', 'Type text', ['insert'], 'Dictation'),
    demoProcessor('START_CODING_AGENT_SESSION', 'Coding session', ['new session'], 'Coding task'),
    demoProcessor('QUICK_QUESTION', 'Quick question', ['quick question'], 'Short question'),
  ];
  for (const processor of processors) {
    processor.subscribe(router);
  }
  await runtime.connectRouter(router);
  continueStartup();

  const activity = runtime.activity;

  /**
   * One finished synthetic utterance in this run's Activity. Its screenshot
   * is saved (capture storage is on, in memory only), so it can be labelled
   * and a coding session can start from it.
   */
  async function heard(
    utterance: string,
    intent: string,
    outcome: 'sent' | 'ignored' | 'started',
    application: string,
  ): Promise<void> {
    const observed = frame(utterance, application);
    activity.transcribed?.({
      ...observed,
      // The application that was in front, shown with the entry.
      application: observed.screenshot.window,
      storage: activity.admitCapture?.(),
    });
    await activity.screenshotCaptured?.(observed.id, observed.screenshot);
    activity.intentRecognized?.(observed.id, intent);
    activity.outcome?.(observed.id, outcome);
    activity.finished?.(observed.id);
  }

  await heard(
    'Please send the draft to Sam by Friday.',
    'SEND_TEXT_TO_APPLICATION',
    'sent',
    'org.gnome.Evolution',
  );
  await heard('Hmm, where did I put that file', 'IGNORE', 'ignored', 'org.gnome.Nautilus');
  await heard(
    'New session fix the failing list test',
    'START_CODING_AGENT_SESSION',
    'started',
    'code',
  );

  // Audio only: no speech was recognised, so there is no text to act on.
  const silent = frame('', 'org.example.Editor');
  activity.transcribed?.({
    ...silent,
    source: 'audio-only',
    storage: activity.admitCapture?.(),
  });
  activity.outcome?.(silent.id, 'error');
  activity.finished?.(silent.id);

  // Not saved: heard while capture storage was off, so it cannot be labelled.
  const unsaved = frame('Quick question what is the capital of Norway', 'org.mozilla.firefox');
  activity.transcribed?.({
    ...unsaved,
    application: unsaved.screenshot.window,
    storage: notAdmitted,
  });
  activity.intentRecognized?.(unsaved.id, 'QUICK_QUESTION');
  activity.outcome?.(unsaved.id, 'started');
  activity.finished?.(unsaved.id);

  // Listen here: the listener's microphones, composed as src/cli.ts composes
  // them, with the test recogniser (test/microphones-fixture.ts): the
  // computer's "microphone" is silent, and a listening browser's sound is
  // transcribed as words for its loudness ("w3 w5"), so speaking into the
  // browser makes Activity entries named after the paired browser. No model
  // runs and nothing is typed anywhere.
  microphones = microphonesFixture(runtime, pause);

  // Paused for media, as when music plays on the computer; Resume overrides it.
  pause.setMediaPlaying(true);

  // Every 40 seconds something new is heard, six times.
  const laterUtterances = [
    'Insert see you at the stand-up tomorrow',
    'Quick question how long do eggs boil',
    'That was not for you',
    'New session add a test for the empty case',
    'Insert thanks, looks good to me',
    'Never mind',
  ];
  const laterIntents = [
    'SEND_TEXT_TO_APPLICATION',
    'QUICK_QUESTION',
    'IGNORE',
    'START_CODING_AGENT_SESSION',
    'SEND_TEXT_TO_APPLICATION',
    'IGNORE',
  ];
  let later = 0;
  const laterTimer = setInterval(() => {
    if (later >= laterUtterances.length) {
      clearInterval(laterTimer);
      return;
    }
    const intent = laterIntents[later];
    let outcome: 'sent' | 'ignored' | 'started' = 'started';
    if (intent === 'SEND_TEXT_TO_APPLICATION') {
      outcome = 'sent';
    } else if (intent === 'IGNORE') {
      outcome = 'ignored';
    }
    void heard(laterUtterances[later], intent, outcome, 'org.example.Editor');
    later++;
  }, 40_000);
  controller.signal.addEventListener('abort', () => clearInterval(laterTimer));
  continueStartup();

  // Several conversations for the list: coding questions, a quick question
  // and one whose turn keeps running (see scriptedRun). Their answers
  // complete before the browser pairs, so the listener marks them unread
  // (no page shows them). All but the city trip are then marked read, as if
  // read on another device before (see `settleDemoMarks`), so the browser
  // shows one unread conversation, also after a reload; opening it marks it
  // read on every page.
  //
  // The invoice export is asked "yesterday" (the shifted clock) and, once
  // that turn has ended, continued today, so it shows both kinds of time.
  const invoice = sessions.start(frame('🧾 Explain the invoice export'), controller.signal);
  for (let waited = 0; waited < 20_000; waited += 50) {
    continueStartup();
    const session = sessions.snapshot().find((candidate) => candidate.id === invoice);
    if (session && session.turnStartedAt === undefined && session.status === 'completed') {
      break;
    }
    await delay(50);
  }
  demoClockShift = 0;
  continueStartup();
  sessions.followUp(invoice, 'Thanks. Is anything left to do today?', controller.signal);

  const bug = sessions.start(
    frame('🐛 Why does the list test fail? Please fix the bug.'),
    controller.signal,
  );
  const trip = sessions.start(
    frame('🗺️ Plan a two-day city trip for me', 'org.mozilla.firefox', true),
    controller.signal,
    'quickQuestion',
  );
  const budget = sessions.start(
    frame('💶 Keep the weekend budget in view'),
    controller.signal,
    'quickQuestion',
  );
  sessions.start(frame('🧪 Find the flaky test'), controller.signal);
  const rules = sessions.start(
    frame('Notification rules: summarise them'),
    controller.signal,
    'quickQuestion',
  );
  await settleDemoMarks(
    sessions,
    new Map([
      [invoice, 2],
      [bug, 1],
      [rules, 1],
      [trip, 1],
      [budget, 1],
    ]),
    trip,
  );
  continueStartup();

  // ---- Gateway --------------------------------------------------------------------

  const port = Number(values.port);
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const stateDirectory = join(directory, 'remote');
  // Widget pages are served on their own origin: a second loopback port.
  const framePort = values['frame-port'] ? Number(values['frame-port']) : port + 1;
  const frameOrigin = `http://127.0.0.1:${framePort}`;

  gateway = new Gateway({
    host: '127.0.0.1',
    port,
    origins,
    stateDirectory,
    controlSocket: join(directory, 'control.sock'),
    sessionsDirectory: join(directory, '.companion-sessions'),
    appDirectory,
    log: (message) => console.error(`[remote] ${message}`),
    // The page may ask for the microphone (Listen here).
    allowMicrophone: true,
    frames: {
      listen: { host: '127.0.0.1', port: framePort },
      origin: frameOrigin,
    },
  });
  await gateway.start();
  continueStartup();

  const { code } = await new DeviceStore(stateDirectory).createPairingCode();

  console.log(`
Companion browser shell demo (synthetic data only)

  Open:          http://127.0.0.1:${port}/
  Pairing code:  ${code.slice(0, 5)}-${code.slice(5)}   (10 minutes, one browser)
  Widget frames: ${frameOrigin}/ (the city trip shows an inline widget, the
                 weekend budget a pinned one)
  Listen here:   Activity → This browser (Resume first: the demo starts
                 paused for media). The browser asks for the microphone;
                 a test recogniser turns its sound into words such as
                 "w3 w5". Needs this loopback address (a secure page).

New pairing code:
  bin/companion-remote pair --state-directory ${stateDirectory}

Temporary data: ${directory}
Press Ctrl+C to stop and delete it.
`);

  await stopped;
  console.error('Stopping…');
} catch (error) {
  if (!(error instanceof StartupStopped)) {
    throw error;
  }
  console.error('Stopped during startup.');
} finally {
  controller.abort();
  // A gateway that failed to start may still hold its state claim; closing
  // it releases whatever it took (as test/remote-fixture.ts does).
  if (gateway) {
    await gateway.close();
  }
  if (microphones) {
    await microphones.close();
  }
  if (sessions) {
    await sessions.close();
  }
  if (runtime && runtimeStarted) {
    await runtime.close();
  }
  await rm(directory, { recursive: true, force: true });
}
