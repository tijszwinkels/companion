import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeBackend } from '../../src/agents/claude/claude-backend.ts';
import type { AgentChoice } from '../../src/agents/choices.ts';
import type {
  AgentMessage,
  AgentRunRequest,
  ClaudeCodeSettings,
  NativeTitleExport,
} from '../../src/agents/types.ts';
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

test('a resumed turn with another model announces the switch only once Claude Code confirms it', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();
  const first = request(directory, settings, 'hello');
  await backend.run(first, signal(), () => {});

  // Same native session, another model, the conversation's unchanged effort.
  const switched: AgentMessage[] = [];
  await backend.run(
    {
      ...first,
      settings: { ...settings, model: 'claude-sonnet-5' },
      prompt: { text: 'again' },
      resume: true,
      previousModel: 'claude-opus-5-5',
    },
    signal(),
    (message) => switched.push(message),
  );
  const argv: string[] = (await captured(directory)).argv;
  assert.equal(argv[argv.indexOf('--resume') + 1], first.id);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.equal(argv.includes('--fallback-model'), false);
  assert.deepEqual(
    switched.filter((message) => message.kind === 'notice').map((message) => message.text),
    [
      'Now using claude-sonnet-5 (previous turn: claude-opus-5-5). Claude Code continues the same conversation history.',
    ],
  );
  assert.equal(latest(switched).at(-1)?.text, '## Answer\n**42**');

  // The first turn with a model that ignores effort repeats the effort notice.
  const toNoEffort: AgentMessage[] = [];
  await backend.run(
    {
      ...first,
      settings: { ...settings, model: 'claude-no-effort' },
      resume: true,
      previousModel: 'claude-sonnet-5',
    },
    signal(),
    (message) => toNoEffort.push(message),
  );
  const notices = toNoEffort.filter((message) => message.kind === 'notice');
  assert.equal(notices.length, 2);
  assert.match(notices[0].text, /^Now using claude-no-effort \(previous turn: claude-sonnet-5\)\./);
  assert.match(notices[1].text, /claude-no-effort does not support effort levels/);

  // Later turns with the same model are silent again.
  const unchanged: AgentMessage[] = [];
  await backend.run(
    { ...first, settings: { ...settings, model: 'claude-no-effort' }, resume: true },
    signal(),
    (message) => unchanged.push(message),
  );
  assert.equal(
    unchanged.some((message) => message.kind === 'notice'),
    false,
  );

  // A switch Claude Code does not confirm fails before any notice or prompt,
  // whether the model or the conversation's effort drifted.
  const effortDrifted: AgentMessage[] = [];
  await assert.rejects(
    backend.run(
      {
        ...first,
        settings: { ...settings, model: 'claude-effort-drift' },
        resume: true,
        previousModel: 'claude-no-effort',
      },
      signal(),
      (message) => effortDrifted.push(message),
    ),
    /Claude Code selected effort low; expected high/,
  );
  assert.deepEqual(effortDrifted, []);

  const drifted: AgentMessage[] = [];
  await assert.rejects(
    backend.run(
      {
        ...first,
        settings: { ...settings, model: 'claude-drift' },
        resume: true,
        previousModel: 'claude-no-effort',
      },
      signal(),
      (message) => drifted.push(message),
    ),
    /Claude Code selected claude-other; expected claude-drift/,
  );
  assert.deepEqual(drifted, []);
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
  ['old-version', /Claude Code 2\.1\.269 is too old; Companion needs 2\.1\.270 or later/],
  ['no-version', /did not report a usable version \(undefined\)/],
  ['malformed-correlation', /malformed user_message_uuid/],
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

  // A picker switch announces the confirmed model after the settings checks,
  // but its resumed turn is still bounded until a verified init.
  const first = request(directory, settings, 'hello');
  await initStall.run(first, signal(), () => {});
  const switched: AgentMessage[] = [];
  await assert.rejects(
    initStall.run(
      {
        ...first,
        settings: { ...settings, model: 'claude-sonnet-5' },
        prompt: { text: 'silent-init' },
        resume: true,
        previousModel: 'claude-opus-5-5',
      },
      signal(),
      (message) => switched.push(message),
    ),
    /did not confirm its session within 0\.3 seconds/,
  );
  assert.match(switched[0]?.text ?? '', /^Now using claude-sonnet-5 \(previous turn:/);
  const resumed = await captured(directory);
  assert.equal(resumed.argv[resumed.argv.indexOf('--resume') + 1], first.id);
  assert.throws(() => process.kill(resumed.pid, 0), { code: 'ESRCH' });
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

/** Run one turn and collect its titles, native exports, notices and rename requests. */
async function naming(
  directory: string,
  turn: AgentRunRequest<ClaudeCodeSettings>,
  options: { exportTitles?: boolean; signal?: AbortSignal } = {},
) {
  const titles: string[] = [];
  const exports: NativeTitleExport[] = [];
  const notices: string[] = [];
  await rm(join(directory, 'renames.jsonl'), { force: true });
  const run = new ClaudeCodeBackend().run(
    turn,
    options.signal ?? signal(),
    (message) => {
      if (message.kind === 'notice') {
        notices.push(message.text);
      }
    },
    () => {},
    (title) => titles.push(title),
    options.exportTitles === false ? undefined : (title) => exports.push(title),
  );
  let failure: unknown;
  await run.catch((error: unknown) => {
    failure = error;
  });
  const renames = (await readFile(join(directory, 'renames.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const transcript = await readFile(join(directory, 'claude-sessions', turn.id), 'utf8').catch(
    () => '',
  );
  return { titles, exports, notices, renames, transcript, failure };
}

test('a successful name is published to the native Claude session and confirmed', async (context) => {
  const { directory, settings } = await fixture(context);
  const turn = request(directory, settings, 'name ok');

  const result = await naming(directory, turn);

  assert.deepEqual(result.titles, ['🐛 Login fix']);
  // Claude Code's native control request, for exactly this session.
  assert.deepEqual(result.renames, [
    { subtype: 'rename_session', title: '🐛 Login fix', source: 'host', session_id: turn.id },
  ]);
  // Its answer arrives after the turn's result and still confirms the export.
  assert.deepEqual(result.exports, [
    { title: '🐛 Login fix', state: 'pending' },
    { title: '🐛 Login fix', state: 'published' },
  ]);
  assert.match(result.transcript, /"type":"custom-title","customTitle":"🐛 Login fix"/);
  assert.deepEqual(result.notices, []);
});

test('failed, unreported or untracked naming calls never reach the native session', async (context) => {
  const { directory, settings } = await fixture(context);

  for (const variant of ['failed', 'unreported']) {
    const result = await naming(directory, request(directory, settings, `name ${variant}`));
    assert.deepEqual(result.titles, [], variant);
    assert.deepEqual(result.exports, [], variant);
    assert.deepEqual(result.renames, [], variant);
  }

  // A caller that does not track exports gets the Companion title only.
  const untracked = await naming(directory, request(directory, settings, 'name ok'), {
    exportTitles: false,
  });
  assert.deepEqual(untracked.titles, ['🐛 Login fix']);
  assert.deepEqual(untracked.renames, []);
});

test('a refused native rename is reported as failed, not as published', async (context) => {
  const { directory, settings } = await fixture(context);

  const result = await naming(directory, request(directory, settings, 'name refused'));

  assert.deepEqual(result.titles, ['🐛 Login fix'], 'Companion keeps its own title');
  assert.deepEqual(result.exports, [
    { title: '🐛 Login fix', state: 'pending' },
    { title: '🐛 Login fix', state: 'failed' },
  ]);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /did not save the name “🐛 Login fix”.*fixture refused the name/);
  assert.equal(result.failure, undefined, 'The answer itself still succeeds');
  assert.doesNotMatch(result.transcript, /custom-title/);
});

test('an unanswered rename stays pending and is sent again by the next turn', async (context) => {
  const { directory, settings } = await fixture(context);
  const first = request(directory, settings, 'name silent');

  const silent = await naming(directory, first);
  assert.deepEqual(silent.exports, [{ title: '🐛 Login fix', state: 'pending' }]);
  assert.equal(silent.failure, undefined);

  const retried = await naming(directory, {
    ...first,
    prompt: { text: 'hello' },
    resume: true,
    nativeTitle: { title: '🐛 Login fix', state: 'pending' },
  });
  assert.deepEqual(retried.renames, [
    { subtype: 'rename_session', title: '🐛 Login fix', source: 'host', session_id: first.id },
  ]);
  assert.deepEqual(retried.exports, [{ title: '🐛 Login fix', state: 'published' }]);
  assert.match(retried.transcript, /"customTitle":"🐛 Login fix"/);

  // Published and failed exports are not retried by an ordinary turn.
  for (const state of ['published', 'failed'] as const) {
    const quiet = await naming(directory, {
      ...first,
      prompt: { text: 'hello' },
      resume: true,
      nativeTitle: { title: '🐛 Login fix', state },
    });
    assert.deepEqual(quiet.renames, [], state);
    assert.deepEqual(quiet.exports, [], state);
  }
});

test('repeating a confirmed name sends nothing; a later name supersedes an earlier one', async (context) => {
  const { directory, settings } = await fixture(context);
  const first = request(directory, settings, 'hello');
  await naming(directory, first);

  const same = await naming(directory, {
    ...first,
    prompt: { text: 'name ok' },
    resume: true,
    nativeTitle: { title: '🐛 Login fix', state: 'published' },
  });
  assert.deepEqual(same.titles, ['🐛 Login fix']);
  assert.deepEqual(same.renames, []);
  assert.deepEqual(same.exports, []);

  // A failed name chosen again is an explicit new attempt.
  const again = await naming(directory, {
    ...first,
    prompt: { text: 'name ok' },
    resume: true,
    nativeTitle: { title: '🐛 Login fix', state: 'failed' },
  });
  assert.equal(again.renames.length, 1);
  assert.deepEqual(again.exports.at(-1), { title: '🐛 Login fix', state: 'published' });

  const twice = await naming(directory, {
    ...first,
    prompt: { text: 'name twice' },
    resume: true,
  });
  assert.deepEqual(
    twice.renames.map((rename) => rename.title),
    ['🐛 Login fix', '🔐 Auth flow'],
  );
  assert.deepEqual(twice.exports.at(-1), { title: '🔐 Auth flow', state: 'published' });
  assert.ok(
    !twice.exports.some((entry) => entry.title === '🐛 Login fix' && entry.state === 'published'),
    'The superseded name is never reported as the published one',
  );
});

test('a stopped turn leaves an unanswered name pending', async (context) => {
  const { directory, settings } = await fixture(context);
  const controller = new AbortController();
  const turn = request(directory, settings, 'name stall');

  const running = naming(directory, turn, { signal: controller.signal });
  await waitFor(() => existsSync(join(directory, 'renames.jsonl')));
  controller.abort();
  const result = await running;

  assert.equal((result.failure as Error | undefined)?.name, 'AbortError');
  assert.deepEqual(result.exports, [{ title: '🐛 Login fix', state: 'pending' }]);
});

test('a name whose result arrives after Stop never becomes a native export', async (context) => {
  const { directory, settings } = await fixture(context);
  const controller = new AbortController();
  const exports: NativeTitleExport[] = [];
  const turn = request(directory, settings, 'name ok');

  // Stop while the naming call runs: its successful result is in the same
  // output, which is still read while Claude Code is interrupted.
  const run = new ClaudeCodeBackend().run(
    turn,
    controller.signal,
    (message) => {
      if (message.kind === 'tool' && message.state === 'running') {
        controller.abort();
      }
    },
    () => {},
    () => {},
    (title) => exports.push(title),
  );
  await run.catch(() => {});

  assert.ok(controller.signal.aborted);
  assert.deepEqual(exports, []);
  assert.equal(existsSync(join(directory, 'renames.jsonl')), false, 'No rename was sent');
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

test('the result answering the prompt ends the turn; later background turns are ignored', async (context) => {
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

/** The final text and state of the turn's last message. */
function finalAnswer(updates: AgentMessage[]): {
  text: string;
  state: AgentMessage['state'] | undefined;
} {
  const last = latest(updates).at(-1);
  return { text: last?.text ?? '', state: last?.state };
}

test('each prompt carries a new request UUID, separate from the conversation ID', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();
  const first = request(directory, settings, 'hello');

  await backend.run(first, signal(), () => {});
  const firstUuid: string = (await captured(directory)).message.uuid;
  await backend.run({ ...first, prompt: { text: 'again' }, resume: true }, signal(), () => {});
  const secondUuid: string = (await captured(directory)).message.uuid;

  assert.match(firstUuid, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.match(secondUuid, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(firstUuid, first.id);
  assert.notEqual(secondUuid, firstUuid);
});

// A restored background-task notification's result (or any result for
// another input) arrives before the prompt's own answer. On the base adapter
// it ended the turn early, without the answer; the answer must be shown.
for (const variant of ['separate', 'chunk', 'error', 'mismatched', 'batched'] as const) {
  test(`an unrelated result (${variant}) before the answer does not end the turn`, async (context) => {
    const { directory, settings } = await fixture(context);
    const updates: AgentMessage[] = [];

    await new ClaudeCodeBackend().run(
      request(directory, settings, `notification ${variant}`),
      signal(),
      (message) => updates.push(message),
    );

    assert.deepEqual(finalAnswer(updates), { text: '## Answer\n**42**', state: 'done' });
    const recorded = await captured(directory);
    assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
  });
}

test('a resumed turn after a restored notification still shows its answer', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend();
  const first = request(directory, settings, 'hello');
  await backend.run(first, signal(), () => {});

  const updates: AgentMessage[] = [];
  await backend.run(
    { ...first, prompt: { text: 'notification separate' }, resume: true },
    signal(),
    (message) => updates.push(message),
  );

  const argv: string[] = (await captured(directory)).argv;
  assert.equal(argv[argv.indexOf('--resume') + 1], first.id);
  assert.deepEqual(finalAnswer(updates), { text: '## Answer\n**42**', state: 'done' });
});

test('an unrelated result does not fail a tool that is still running', async (context) => {
  const { directory, settings } = await fixture(context);
  const updates: AgentMessage[] = [];

  await new ClaudeCodeBackend().run(
    request(directory, settings, 'notification tool'),
    signal(),
    (message) => updates.push(message),
  );

  const tools = updates.filter((message) => message.id === 'tool-toolu_running');
  assert.deepEqual(
    tools.map((tool) => tool.state),
    ['running', 'done'],
  );
  assert.equal(tools.at(-1)?.text, 'slept');
  assert.deepEqual(finalAnswer(updates), { text: '## Answer\n**42**', state: 'done' });
});

test('an exit after an unrelated result fails visibly with both reasons', async (context) => {
  const { directory, settings } = await fixture(context);

  await assert.rejects(
    new ClaudeCodeBackend().run(
      request(directory, settings, 'notification exit'),
      signal(),
      () => {},
    ),
    /exited before finishing \(3\)\. fixture crash\. Claude Code also reported: fixture notification failure/,
  );
  const recorded = await captured(directory);
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
});

test('an unrelated result before init neither fails nor ends startup', async (context) => {
  const { directory, settings } = await fixture(context);
  const backend = new ClaudeCodeBackend({ settingsMilliseconds: 5000, initMilliseconds: 300 });

  await assert.rejects(
    backend.run(request(directory, settings, 'notification before-init'), signal(), () => {}),
    /did not confirm its session within 0\.3 seconds\. Claude Code also reported: fixture notification failure/,
  );
  const recorded = await captured(directory);
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
});

for (const variant of ['stall', 'uncorrelated'] as const) {
  test(`Stop still works while waiting after an unrelated result (${variant})`, async (context) => {
    const { directory, settings } = await fixture(context);
    const controller = new AbortController();
    const updates: AgentMessage[] = [];
    let settled = false;

    const run = new ClaudeCodeBackend()
      .run(request(directory, settings, `notification ${variant}`), controller.signal, (message) =>
        updates.push(message),
      )
      .finally(() => {
        settled = true;
      });
    run.catch(() => {});

    // The stalled turn has emitted nothing; the uncorrelated one has shown
    // its whole answer but, without the echo, is not this prompt's result.
    if (variant === 'uncorrelated') {
      await waitFor(() => finalAnswer(updates).text === '## Answer\n**42**', 3000);
    } else {
      await waitFor(() => existsSync(join(directory, 'request.json')), 3000);
    }
    await delay(200);
    assert.equal(settled, false, 'An unrelated result must not settle the turn');

    controller.abort();
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(await readFile(join(directory, 'interrupted'), 'utf8'), 'yes');
    const recorded = await captured(directory);
    assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' });
  });
}

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
