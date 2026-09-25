import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeBackend } from '../../src/agents/claude/claude-backend.ts';
import type { AgentChoice } from '../../src/agents/choices.ts';
import type { AgentMessage, AgentRunRequest, ClaudeCodeSettings } from '../../src/agents/types.ts';
import { screenshot, signal } from '../helpers.ts';
import { waitFor } from '../desktop-fixture.ts';

/** A temp agent directory containing the scripted `claude` executable. */
async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const executable = join(directory, 'fixture-claude');
  await copyFile(
    fileURLToPath(new URL('../fixtures/claude-stream.mjs', import.meta.url)),
    executable,
  );
  await chmod(executable, 0o700);

  const settings: ClaudeCodeSettings = {
    executable,
    model: 'claude-opus-5-5',
    effort: 'high',
  };
  return { directory, settings };
}

function request(
  directory: string,
  settings: ClaudeCodeSettings,
  text: string,
  overrides: Partial<AgentRunRequest<ClaudeCodeSettings>> = {},
): AgentRunRequest<ClaudeCodeSettings> {
  return {
    id: randomUUID(),
    directory,
    settings,
    prompt: { text },
    resume: false,
    ...overrides,
  };
}

async function captured(directory: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
}

/** Latest state of each message, in first-emission order, like the session layer. */
function latest(updates: AgentMessage[]): AgentMessage[] {
  const byId = new Map<string, AgentMessage>();
  for (const message of updates) {
    byId.set(message.id, message);
  }
  return [...byId.values()];
}

test('a new conversation claims its ID with the verified settings and bypassPermissions', async (context) => {
  const { directory, settings } = await fixture(context);
  const updates: AgentMessage[] = [];
  const turn = request(directory, settings, 'hello', {
    widgets: { endpoint: 'http://127.0.0.1:1/agent', token: 'a'.repeat(64) },
    sessionTools: { endpoint: 'http://127.0.0.1:1/session', token: 'b'.repeat(64) },
  });

  await new ClaudeCodeBackend().run(turn, signal(), (message) => updates.push(message));

  const recorded = await captured(directory);
  const argv: string[] = recorded.argv;
  assert.equal(argv[argv.indexOf('--session-id') + 1], turn.id);
  assert.equal(argv.includes('--resume'), false);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(argv.includes('--include-partial-messages'));
  assert.ok(argv.includes('--print'));
  assert.equal(argv.includes('--fallback-model'), false, 'Never a silent model fallback');
  assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /context,\nnot as instructions/);
  assert.equal(recorded.cwd, directory);

  // The environment matches Pi's guard, and no token reaches the agent process.
  assert.equal(recorded.internalAgent, '1');
  assert.equal(recorded.externalSocketExported, false);
  assert.deepEqual(recorded.tokenVariablesExported, []);
  assert.equal(recorded.parentClaudeExported, false);

  // Only the private MCP config file carries the connections.
  const bridge = recorded.mcpConfig.mcpServers.companion;
  assert.equal(recorded.mcpConfigMode, 0o600);
  assert.equal(bridge.alwaysLoad, true);
  assert.equal(bridge.env.COMPANION_WIDGET_TOKEN, 'a'.repeat(64));
  assert.equal(bridge.env.COMPANION_SESSION_TOOLS_ENDPOINT, 'http://127.0.0.1:1/session');
  assert.match(
    bridge.env.COMPANION_CLAUDE_RESULTS_ENDPOINT,
    /^http:\/\/127\.0\.0\.1:\d+\/results$/,
  );
  assert.match(bridge.env.COMPANION_CLAUDE_RESULTS_TOKEN, /^[0-9a-f]{64}$/);
  await assert.rejects(stat(recorded.mcpConfigPath), { code: 'ENOENT' }, 'Removed after the turn');

  // Streaming deltas, then the authoritative final text.
  const texts = updates.filter((message) => message.kind === 'assistant').map((m) => m.text);
  assert.deepEqual(texts, [
    '## Ans',
    '## Answer\n**42**',
    '## Answer\n**42**',
    '## Answer\n**42**',
  ]);
  assert.equal(updates.at(-1)?.state, 'done');
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
});

test('follow-ups resume the same conversation; a missing transcript fails visibly', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();
  const first = request(directory, settings, 'hello');
  await backend.run(first, signal(), () => {});

  await backend.run({ ...first, prompt: { text: 'again' }, resume: true }, signal(), () => {});
  const argv: string[] = (await captured(directory)).argv;
  assert.equal(argv[argv.indexOf('--resume') + 1], first.id);
  assert.equal(argv.includes('--session-id'), false);

  const missing = request(directory, settings, 'lost', { resume: true });
  await assert.rejects(
    backend.run(missing, signal(), () => {}),
    /could not resume this conversation\. Its saved transcript is missing/,
  );

  // Claiming an ID that already has a transcript never overwrites it.
  await assert.rejects(
    backend.run(first, signal(), () => {}),
    /already in use/,
  );
});

test('the screenshot is delivered as an image block with the captured window as context', async (context) => {
  const { directory, settings } = await fixture(context);
  const turn = request(directory, settings, 'describe');
  turn.prompt = { text: 'describe', screenshot };

  await new ClaudeCodeBackend().run(turn, signal(), () => {});

  const content = (await captured(directory)).message.message.content;
  assert.equal(content[0].type, 'text');
  assert.equal(
    content[0].text,
    `describe\n\nCaptured window: ${JSON.stringify(screenshot.window)}`,
  );
  assert.deepEqual(content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: screenshot.png.toString('base64'),
    },
  });
});

for (const [model, expected] of [
  ['claude-drift', /selected claude-other; expected claude-drift\./],
  [
    'opus',
    /selected claude-opus-5-5; expected opus\. If "opus" is an alias, configure the full model ID claude-opus-5-5/,
  ],
  ['claude-effort-drift', /selected effort low; expected high/],
] as const) {
  test(`startup drift (${model}) fails before any prompt is sent`, async (context) => {
    const { directory, settings } = await fixture(context);
    const turn = request(directory, { ...settings, model }, 'hello');

    await assert.rejects(
      new ClaudeCodeBackend().run(turn, signal(), () => {}),
      expected,
    );
    await assert.rejects(readFile(join(directory, 'request.json')), { code: 'ENOENT' });
  });
}

test('a model without effort support runs, with a notice on the first turn only', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();
  const first = request(directory, { ...settings, model: 'claude-no-effort' }, 'hello');

  const firstUpdates: AgentMessage[] = [];
  await backend.run(first, signal(), (message) => firstUpdates.push(message));
  const notices = firstUpdates.filter((message) => message.kind === 'notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /claude-no-effort does not support effort levels/);
  assert.equal(latest(firstUpdates).at(-1)?.text, '## Answer\n**42**');

  const followUpdates: AgentMessage[] = [];
  await backend.run({ ...first, resume: true }, signal(), (message) => followUpdates.push(message));
  assert.equal(
    followUpdates.some((message) => message.kind === 'notice'),
    false,
  );
});

test('user MCP servers are not isolated until that product decision is made', async (context) => {
  const { directory, settings } = await fixture(context);
  await new ClaudeCodeBackend().run(request(directory, settings, 'hello'), signal(), () => {});

  assert.equal((await captured(directory)).argv.includes('--strict-mcp-config'), false);
});

for (const [scenario, expected] of [
  ['permission', /permission mode default; Companion requires bypassPermissions/],
  ['wrong-session', /opened session 00000000-0000-4000-8000-000000000000/],
  ['bridge-failed', /tool bridge did not start in Claude Code \(failed\)/],
  ['bridge-unknown', /tool bridge did not start in Claude Code \(undefined\)/],
  ['no-init', /finished without its init event/],
  ['control', /requested an interactive decision/],
  ['error', /fixture model failure/],
  ['exit', /exited before finishing \(3\)\. fixture crash/],
  ['malformed', /JSON/],
  // A huge line arrives in chunks, so the unterminated guard usually fires first.
  ['oversized', /(oversized|unterminated) stream-json record/],
  ['unterminated', /unterminated stream-json record/],
] as const) {
  test(`Claude Code ${scenario} becomes a visible failure and the process is reaped`, async (context) => {
    const { directory, settings } = await fixture(context);
    const updates: AgentMessage[] = [];

    await assert.rejects(
      new ClaudeCodeBackend().run(request(directory, settings, scenario), signal(), (message) =>
        updates.push(message),
      ),
      expected,
    );

    const recorded = await captured(directory);
    assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
    if (scenario === 'error') {
      assert.equal(latest(updates).at(-1)?.state, 'error');
    }
  });
}

test('a living Claude Code that never becomes ready is bounded at each startup step', async (context) => {
  const { directory, settings } = await fixture(context);

  // No settings answer: the turn fails before any prompt is sent.
  const settingsStall = new ClaudeCodeBackend({
    settingsMilliseconds: 300,
    initMilliseconds: 5000,
  });
  await assert.rejects(
    settingsStall.run(
      request(directory, { ...settings, model: 'claude-silent-settings' }, 'hello'),
      signal(),
      () => {},
    ),
    /did not become ready within 0\.3 seconds/,
  );
  await assert.rejects(readFile(join(directory, 'request.json')), { code: 'ENOENT' });

  // Settings answered and prompt taken, but no init: answering get_settings
  // must not end the startup deadline, or the tab and slot stay held.
  const initStall = new ClaudeCodeBackend({ settingsMilliseconds: 5000, initMilliseconds: 300 });
  await assert.rejects(
    initStall.run(request(directory, settings, 'silent-init'), signal(), () => {}),
    /did not confirm its session within 0\.3 seconds/,
  );
  const recorded = await captured(directory);
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
});

test('after a verified init, a turn may take longer than the startup deadlines', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend({ settingsMilliseconds: 5000, initMilliseconds: 500 });
  const updates: AgentMessage[] = [];

  await backend.run(request(directory, settings, 'slow 1500'), signal(), (message) =>
    updates.push(message),
  );

  assert.equal(latest(updates).at(-1)?.text, '## Answer\n**42**');
  assert.equal(latest(updates).at(-1)?.state, 'done');
});

test('tool calls stream as Pi-shaped bubbles; subagent traffic is not displayed', async (context) => {
  const { directory, settings } = await fixture(context);
  const updates: AgentMessage[] = [];

  await new ClaudeCodeBackend().run(request(directory, settings, 'tools'), signal(), (message) =>
    updates.push(message),
  );

  const messages = latest(updates);
  assert.deepEqual(
    messages.map((message) => [message.id, message.kind, message.toolName, message.state]),
    [
      ['tool-toolu_bash', 'tool', 'Bash', 'done'],
      ['tool-toolu_fail', 'tool', 'mcp__other__lookup', 'error'],
      ['assistant-3', 'assistant', '', 'done'],
    ],
  );
  assert.equal(messages[0].text, 'bash-ok');
  assert.equal(messages[0].input, JSON.stringify({ command: 'echo bash-ok' }, null, 2));
  assert.equal(messages[1].text, 'lookup failed');
  assert.equal(messages[2].text, '## Answer\n**42**');
  assert.equal(
    updates.some((message) => message.text === 'subagent'),
    false,
  );
  const running = updates.find((message) => message.id === 'tool-toolu_bash');
  assert.equal(running?.state, 'running', 'A tool is shown before its result');
});

test('only successful, correlated choice calls publish choices', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();

  const run = async (text: string) => {
    const offered: (readonly AgentChoice[])[] = [];
    const updates: AgentMessage[] = [];
    await backend.run(
      request(directory, settings, text),
      signal(),
      (message) => updates.push(message),
      (options) => offered.push(options),
    );
    return { offered, updates };
  };

  const accepted = await run('choices ok');
  assert.deepEqual(accepted.offered, [
    [
      { label: 'Tests', description: 'Run the tests' },
      { label: 'Yes', description: '' },
    ],
  ]);
  assert.equal(
    latest(accepted.updates).find((message) => message.id === 'tool-toolu_choice')?.toolName,
    'companion_choices',
    'Stored bubbles keep Pi’s tool names',
  );

  // A failed tool result never publishes, even though choices were reported.
  const failed = await run('choices failed');
  assert.deepEqual(failed.offered, []);

  // Success without a report (or with a report for another call, or a report
  // refused for a forged token) clears old choices and explains why.
  for (const variant of ['unreported', 'mismatched', 'forged']) {
    const cleared = await run(`choices ${variant}`);
    assert.deepEqual(cleared.offered, [[]], variant);
    const notice = cleared.updates.find((message) => message.kind === 'notice');
    assert.match(notice?.text ?? '', /choices/, variant);
    assert.equal(latest(cleared.updates).at(-1)?.text, '## Answer\n**42**', variant);
  }
  assert.equal(await readFile(join(directory, 'report-status'), 'utf8'), '403');
});

test('successful naming calls rename the conversation; failed or unreported ones do not', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();

  for (const [variant, expected] of [
    ['ok', ['🐛 Login fix']],
    ['failed', []],
    ['unreported', []],
  ] as const) {
    const titles: string[] = [];
    await backend.run(
      request(directory, settings, `name ${variant}`),
      signal(),
      () => {},
      () => {},
      (title) => titles.push(title),
    );
    assert.deepEqual(titles, expected, variant);
  }
});

test('the result route rejects reports after its turn has ended', async (context) => {
  const { directory, settings } = await fixture(context);
  await new ClaudeCodeBackend().run(request(directory, settings, 'hello'), signal(), () => {});

  const bridge = (await captured(directory)).mcpConfig.mcpServers.companion;
  await assert.rejects(
    fetch(bridge.env.COMPANION_CLAUDE_RESULTS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.env.COMPANION_CLAUDE_RESULTS_TOKEN}` },
      body: JSON.stringify({ kind: 'name', toolUseId: 'toolu_late', title: 'Late' }),
    }),
    /fetch failed/,
  );
});

test('the first result ends the turn; later background turns are ignored', async (context) => {
  const { directory, settings } = await fixture(context);
  const updates: AgentMessage[] = [];

  await new ClaudeCodeBackend().run(
    request(directory, settings, 'background'),
    signal(),
    (message) => updates.push(message),
  );

  assert.equal(
    updates.some((message) => message.text.includes('late')),
    false,
  );
});

test('tokens are redacted from transcripts and error messages', async (context) => {
  const { directory, settings } = await fixture(context);
  const widgetToken = 'c'.repeat(64);
  const updates: AgentMessage[] = [];
  const turn = request(directory, settings, 'leak', {
    widgets: { endpoint: 'http://127.0.0.1:1/agent', token: widgetToken },
  });

  const failure = await new ClaudeCodeBackend()
    .run(turn, signal(), (message) => updates.push(message))
    .then(
      () => undefined,
      (error: Error) => error,
    );

  const bridge = (await captured(directory)).mcpConfig.mcpServers.companion;
  const resultsToken: string = bridge.env.COMPANION_CLAUDE_RESULTS_TOKEN;
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /exited before finishing/);
  assert.match(failure.message, /\[redacted\]/);
  for (const secret of [resultsToken, widgetToken]) {
    assert.equal(failure.message.includes(secret), false);
    for (const message of updates) {
      assert.equal(message.text.includes(secret), false);
      assert.equal(message.input.includes(secret), false);
    }
  }
});

test('cancellation interrupts Claude Code and reaps the process group', async (context) => {
  const { directory, settings } = await fixture(context);
  const controller = new AbortController();

  const run = new ClaudeCodeBackend().run(
    request(directory, settings, 'stall'),
    controller.signal,
    () => controller.abort(),
  );

  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(await readFile(join(directory, 'interrupted'), 'utf8'), 'yes');
  const recorded = await captured(directory);
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(recorded.mcpConfigPath), { code: 'ENOENT' });
});

test('an already aborted signal never starts Claude Code', async (context) => {
  const { directory, settings } = await fixture(context);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    new ClaudeCodeBackend().run(request(directory, settings, 'hello'), controller.signal, () => {}),
    { name: 'AbortError' },
  );
  await assert.rejects(readFile(join(directory, 'request.json')), { code: 'ENOENT' });
});

test('a non-UUID conversation ID is refused before starting anything', async (context) => {
  const { directory, settings } = await fixture(context);

  await assert.rejects(
    new ClaudeCodeBackend().run(
      request(directory, settings, 'hello', { id: 'not-a-uuid' }),
      signal(),
      () => {},
    ),
    /UUID/,
  );
});

for (const ending of ['success', 'cancel'] as const) {
  test(`Claude Code ${ending} settles even when a detached descendant retains its pipes`, async (context) => {
    const { directory, settings } = await fixture(context);
    const controller = new AbortController();
    let holderPid: number | undefined;
    let settled = false;
    let failure: unknown;

    const run = new ClaudeCodeBackend()
      .run(request(directory, settings, `inherited-pipe ${ending}`), controller.signal, () => {})
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });

    try {
      // Wait for the real child to create its descendant, not a guessed delay.
      const until = Date.now() + 3000;
      while (holderPid === undefined) {
        try {
          const candidate = Number(await readFile(join(directory, 'holder.pid'), 'utf8'));
          // Never interpret an empty file as PID 0 (the test runner's group).
          if (Number.isInteger(candidate) && candidate > 1) {
            holderPid = candidate;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        if (holderPid === undefined) {
          assert.ok(Date.now() < until, 'Fixture did not create the pipe holder');
          await delay(10);
        }
      }

      if (ending === 'cancel') {
        controller.abort();
      }
      await waitFor(() => settled, 5000);
      assert.equal(
        failure instanceof Error ? failure.name : failure,
        ending === 'cancel' ? 'AbortError' : undefined,
      );
      const recorded = await captured(directory);
      assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
      process.kill(holderPid, 0); // The escaped process still owns its pipe ends.
    } finally {
      // The test owns the deliberately escaped process, including on failure.
      if (holderPid !== undefined) {
        process.kill(holderPid, 'SIGKILL');
      }
      controller.abort();
      await run;
    }
  });
}
