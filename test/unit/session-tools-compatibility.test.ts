// Mixed versions after a source update without a listener restart.
//
// Pi loads src/agents/session-tools.ts as an extension, and Claude Code starts
// the MCP bridge (which imports it) from disk, for every turn. A listener that
// is still running older code passes a session tool lease without any
// capability announcement. Those children must then offer exactly the older
// listener's tools, never companion_browser_open, which that listener's
// service cannot serve. A current listener announces it with each lease.
// The Claude bridge process itself is covered in claude-bridge.test.ts.

import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeMcpConfig } from '../../src/agents/claude/mcp-config.ts';
import { PiBackend } from '../../src/agents/pi-backend.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import registerSessionTools, {
  parseSessionToolCapabilities,
} from '../../src/agents/session-tools.ts';
import { waitFor } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';

/** The session tools an older listener (before companion_browser_open) serves. */
const originalTools = [
  'companion_sessions',
  'companion_session_start',
  'companion_session_reopen',
  'companion_session_close',
  'companion_session_send',
  'companion_session_draft',
];

const variables = [
  'COMPANION_SESSION_TOOLS_ENDPOINT',
  'COMPANION_SESSION_TOOLS_TOKEN',
  'COMPANION_SESSION_TOOLS_CAPABILITIES',
] as const;

/** Register the on-disk Pi extension exactly as Pi does, with `environment`. */
function registeredBy(environment: Partial<Record<(typeof variables)[number], string>>) {
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  try {
    for (const name of variables) {
      if (environment[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = environment[name];
      }
    }
    const names: string[] = [];
    registerSessionTools({ registerTool: (tool) => names.push(tool.name) });
    return names;
  } finally {
    for (const name of variables) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
}

test('the on-disk Pi extension offers companion_browser_open only when announced', () => {
  const lease = {
    COMPANION_SESSION_TOOLS_ENDPOINT: 'http://127.0.0.1:1/session',
    COMPANION_SESSION_TOOLS_TOKEN: 'a'.repeat(64),
  };

  // No lease: no session tools at all, as before.
  assert.deepEqual(registeredBy({}), []);
  assert.deepEqual(registeredBy({ COMPANION_SESSION_TOOLS_CAPABILITIES: 'browser-open' }), []);

  // An older listener's lease: exactly its original tools, all still working.
  assert.deepEqual(registeredBy(lease), originalTools);

  // A current listener's announcement adds the tool.
  assert.deepEqual(
    registeredBy({ ...lease, COMPANION_SESSION_TOOLS_CAPABILITIES: 'browser-open' }),
    [...originalTools, 'companion_browser_open'],
  );
  assert.deepEqual(
    registeredBy({ ...lease, COMPANION_SESSION_TOOLS_CAPABILITIES: ' other , browser-open ' }),
    [...originalTools, 'companion_browser_open'],
  );

  // Malformed or look-alike values never enable it.
  for (const value of ['', ' ', 'Browser-Open', 'browser-open-v2', 'browser_open', ',,']) {
    assert.deepEqual(
      registeredBy({ ...lease, COMPANION_SESSION_TOOLS_CAPABILITIES: value }),
      originalTools,
      JSON.stringify(value),
    );
  }
  assert.deepEqual(parseSessionToolCapabilities(undefined), []);
});

test('a current listener announces browser-open to Pi and to the Claude bridge', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-tools-compat-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  // The lease a turn receives carries the announcement.
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));
  let announced: readonly string[] | undefined;
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'compatibility-fixture',
        label: 'Compatibility fixture',
        dependencies: {},
        async run(request) {
          announced = request.sessionTools?.capabilities;
        },
      },
    },
    () => {},
    directory,
  );
  context.after(() => sessions.close());
  sessions.start({ ...frame, utterance: 'Check the lease' }, signal());
  await waitFor(() => announced !== undefined);
  assert.deepEqual(announced, ['browser-open', 'self-wakes']);

  // Pi receives it in its environment only when the lease has it.
  const executable = join(directory, 'fixture-pi');
  await copyFile(fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url)), executable);
  await chmod(executable, 0o700);
  const request = {
    id: 'compatibility',
    directory,
    settings: { ...defaultAgentSettings, executable },
    prompt: { text: 'plain' },
    resume: false,
  };
  const recorded = async () =>
    JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')).sessionToolCapabilities;
  const lease = { endpoint: 'http://127.0.0.1:1/session', token: 'a'.repeat(64) };
  await new PiBackend().run(
    { ...request, sessionTools: { ...lease, capabilities: ['browser-open'] } },
    signal(),
    () => {},
  );
  assert.equal(await recorded(), 'browser-open');
  await new PiBackend().run({ ...request, sessionTools: lease }, signal(), () => {});
  assert.equal(await recorded(), null);

  // The Claude bridge receives it through the per-turn MCP configuration.
  const results = { endpoint: 'http://127.0.0.1:1/result', token: 'b'.repeat(64) };
  const environmentOf = async (connections: Parameters<typeof writeMcpConfig>[0]) => {
    const file = await writeMcpConfig(connections);
    try {
      const configuration = JSON.parse(await readFile(file.path, 'utf8'));
      return Object.values(configuration.mcpServers as Record<string, { env: object }>)[0]
        .env as Record<string, string>;
    } finally {
      await file.remove();
    }
  };
  const current = await environmentOf({
    results,
    sessionTools: { ...lease, capabilities: ['browser-open'] },
  });
  assert.equal(current.COMPANION_SESSION_TOOLS_CAPABILITIES, 'browser-open');
  const withoutAnnouncement = await environmentOf({ results, sessionTools: lease });
  assert.equal('COMPANION_SESSION_TOOLS_CAPABILITIES' in withoutAnnouncement, false);
});
