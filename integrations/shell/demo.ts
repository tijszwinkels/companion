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
 * Listener drafts: a stand-in desktop editor on the control socket (it
 * reports itself as the Qt panel does, `draftHost: true`) has written the
 * trip conversation's draft, and an agent (the invoice conversation) has
 * proposed one for the notification rules; the browser shows both from the
 * listener, with ✎ and "Draft: …" in the list.
 *
 * It prints the URL and a pairing code. Open the URL in a desktop browser.
 * Nothing reads personal data, starts the production listener, captures the
 * screen or microphone, or binds a non-loopback address. Ctrl+C stops
 * everything and removes the temporary directory.
 *
 * Options: --port N (default 8788).
 */

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { parseChoices } from '../../src/agents/choices.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { chatMessage, type AgentBackend, type AgentMessage } from '../../src/agents/types.ts';
import type { UserSensorFrame, UserSensorProcessor } from '../../src/core/frame.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { CaptureStoragePolicy, notAdmitted } from '../../src/capture-storage/policy.ts';
import { DeviceStore } from '../../src/remote/devices.ts';
import { Gateway } from '../../src/remote/gateway.ts';
import { syntheticWindowPng } from './synthetic-window.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8788' },
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
let desktopEditor: Socket | undefined;

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
    undefined,
    undefined,
    // On, so the one conversation that keeps its screenshot (see frame())
    // can; the others' frames are not admitted.
    CaptureStoragePolicy.enabledForTesting(),
    demoClock,
  );

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
    ]),
    trip,
  );
  continueStartup();

  // ---- Listener drafts ------------------------------------------------------------

  // A stand-in desktop editor: a second connection to the control socket
  // that reports itself as a draft host, as the Qt panel does. It writes the
  // trip conversation's draft and stays connected, so the listener has a
  // reviewer for the agent's proposal below (without any draft host it
  // would answer `offline`).
  desktopEditor = createConnection(join(directory, 'control.sock'));
  await once(desktopEditor, 'connect');
  continueStartup();
  desktopEditor.on('data', () => {
    // Its draft events are not needed; reading keeps the socket flowing.
  });
  desktopEditor.write(
    JSON.stringify({ action: 'panel-state', id: '', composerFocused: false, draftHost: true }) +
      '\n',
  );
  desktopEditor.write(
    JSON.stringify({
      action: 'draft-set',
      id: trip,
      text: 'Could you add a plan for a rainy afternoon? Museums close at 17:00.',
      editId: 'demo-desktop-1',
    }) + '\n',
  );

  // An agent's proposal, as its `companion_session_draft` call reaches the
  // listener (the sessions' private entry point; the demo plays the agent).
  type AgentDraftEntry = {
    draftFromAgent(
      request: {
        id: string;
        text: string;
        ifDraftExists: 'reject';
        focus: boolean;
        origin: { kind: 'agent'; sessionId: string; title: string; depth: number };
      },
      signal: AbortSignal,
    ): Promise<{ outcome: string }>;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    continueStartup();
    const proposal = await (sessions as unknown as AgentDraftEntry).draftFromAgent(
      {
        id: rules,
        text: 'Please also say which rules apply on weekends.',
        ifDraftExists: 'reject',
        focus: false,
        origin: { kind: 'agent', sessionId: invoice, title: '🧾 Invoice export', depth: 1 },
      },
      controller.signal,
    );
    // `offline` until the stand-in editor's report has been handled.
    if (proposal.outcome !== 'offline') {
      break;
    }
    await delay(50);
  }

  // ---- Gateway --------------------------------------------------------------------

  const port = Number(values.port);
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const stateDirectory = join(directory, 'remote');

  gateway = new Gateway({
    host: '127.0.0.1',
    port,
    origins,
    stateDirectory,
    controlSocket: join(directory, 'control.sock'),
    sessionsDirectory: join(directory, '.companion-sessions'),
    appDirectory,
    log: (message) => console.error(`[remote] ${message}`),
  });
  await gateway.start();
  continueStartup();

  const { code } = await new DeviceStore(stateDirectory).createPairingCode();

  console.log(`
Companion browser shell demo (synthetic data only)

  Open:          http://127.0.0.1:${port}/
  Pairing code:  ${code.slice(0, 5)}-${code.slice(5)}   (10 minutes, one browser)

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
  desktopEditor?.destroy();
  if (sessions) {
    await sessions.close();
  }
  if (runtime && runtimeStarted) {
    await runtime.close();
  }
  await rm(directory, { recursive: true, force: true });
}
