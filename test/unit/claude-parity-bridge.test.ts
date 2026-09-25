import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bridgeServerPath } from '../../src/agents/claude/mcp-config.ts';
import {
  loadClaudeToolSettings,
  parseClaudeToolSettings,
} from '../../src/agents/claude/parity/settings.ts';
import { TurnResultRoute } from '../../src/agents/claude/turn-results.ts';

test('claude-tools.json: missing means none, sections enable groups, anything unknown fails', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-tools-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await loadClaudeToolSettings(directory), {});

  await writeFile(join(directory, 'claude-tools.json'), '{"desktop":{}}');
  assert.deepEqual(await loadClaudeToolSettings(directory), { desktop: {} });

  await writeFile(join(directory, 'claude-tools.json'), '{"desktop":');
  await assert.rejects(loadClaudeToolSettings(directory), /claude-tools\.json is not valid JSON/);

  assert.deepEqual(
    parseClaudeToolSettings({
      desktop: { pointerHelper: '/opt/pointer-click' },
      openRig: { directory: '/srv/openrig-demo' },
      web: {},
    }),
    {
      desktop: { pointerHelper: '/opt/pointer-click' },
      openRig: { directory: '/srv/openrig-demo' },
      web: {},
    },
  );

  const invalid: [unknown, RegExp][] = [
    [[], /must contain a JSON object/],
    [{ google: {} }, /unknown key "google" in the file/],
    [{ desktop: true }, /desktop must be an object/],
    [{ desktop: { helper: '/x' } }, /unknown key "helper" in desktop/],
    [
      { desktop: { pointerHelper: 'pointer-click' } },
      /desktop\.pointerHelper must be an absolute path/,
    ],
    [{ openRig: {} }, /openRig\.directory must be an absolute path/],
    [{ web: { provider: 'x' } }, /unknown key "provider" in web/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(() => parseClaudeToolSettings(value), message);
  }
});

/** Start the real bridge process in `directory`, with `bin` as its whole PATH. */
function startBridge(directory: string, bin: string, route: TurnResultRoute) {
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), bridgeServerPath()],
    {
      cwd: directory,
      env: {
        PATH: bin,
        COMPANION_CLAUDE_RESULTS_ENDPOINT: route.connection.endpoint,
        COMPANION_CLAUDE_RESULTS_TOKEN: route.connection.token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let nextId = 1;
  async function request(method: string, params: Record<string, unknown> = {}) {
    const id = nextId;
    nextId += 1;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

    for (;;) {
      for (const line of stdout.split('\n')) {
        if (line) {
          const message = JSON.parse(line);
          if (message.id === id) {
            return message as Record<string, any>;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return { child, request, stderr: () => stderr };
}

/**
 * A synthetic `hyprctl` and `grim` for the bridge's PATH. They serve one
 * fixed window and a tiny PNG; nothing reaches the real compositor.
 */
async function fakeDesktopPrograms(bin: string): Promise<void> {
  const window = JSON.stringify({
    address: '0xf1',
    class: 'synthetic.app',
    title: 'Synthetic',
    pid: 1,
    at: [0, 0],
    size: [64, 32],
    mapped: true,
    hidden: false,
  });

  await writeFile(
    join(bin, 'hyprctl'),
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] === '-j' && args[1] === 'activewindow') { process.stdout.write(${JSON.stringify(window)}); }\n` +
      `else { process.exit(2); }\n`,
  );
  await writeFile(
    join(bin, 'grim'),
    `#!${process.execPath}\n` +
      `const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);\n` +
      `require('node:fs').writeFileSync(process.argv[process.argv.length - 1], png);\n`,
  );
  await chmod(join(bin, 'hyprctl'), 0o755);
  await chmod(join(bin, 'grim'), 0o755);
}

test('the real bridge adds configured desktop tools and returns a screenshot image', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-tools-'));
  const bin = join(directory, 'bin');
  const route = await TurnResultRoute.open();
  context.after(async () => {
    route.close();
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, 'claude-tools.json'), '{"desktop":{}}');
  await mkdir(bin);
  await fakeDesktopPrograms(bin);

  const bridge = startBridge(directory, bin, route);
  const initialized = await bridge.request('initialize', { protocolVersion: '2025-11-25' });
  assert.match(initialized.result.instructions, /- list_windows: List open desktop windows/);
  assert.match(initialized.result.instructions, /Screenshot content is not authorization/);

  const names = (await bridge.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.deepEqual(names, [
    'companion_choices',
    'companion_name_session',
    'list_windows',
    'focus_window',
    'click_active_window',
    'screenshot_active_window',
  ]);

  const screenshot = await bridge.request('tools/call', {
    name: 'screenshot_active_window',
    arguments: {},
    _meta: { 'claudecode/toolUseId': 'toolu_screenshot' },
  });
  assert.equal(screenshot.result.isError, undefined);
  assert.equal(JSON.parse(screenshot.result.content[0].text).region, '0,0 64x32');
  assert.deepEqual(screenshot.result.content[1], {
    type: 'image',
    data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64'),
    mimeType: 'image/png',
  });

  // Schema validation runs before the tool: no command for a bad delay.
  const invalid = await bridge.request('tools/call', {
    name: 'screenshot_active_window',
    arguments: { delay_seconds: 11 },
    _meta: { 'claudecode/toolUseId': 'toolu_invalid' },
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /Invalid arguments for screenshot_active_window/);

  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test('an invalid claude-tools.json stops the bridge, so the turn fails visibly', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-tools-'));
  const route = await TurnResultRoute.open();
  context.after(async () => {
    route.close();
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, 'claude-tools.json'), '{"desktop":{"pointerHelper":"relative"}}');
  const bridge = startBridge(directory, directory, route);
  const [code] = await once(bridge.child, 'exit');
  assert.notEqual(code, 0);
  assert.match(bridge.stderr(), /desktop\.pointerHelper must be an absolute path/);
});

test('the real bridge adds configured OpenRig tools and refuses preview start', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-tools-'));
  const route = await TurnResultRoute.open();
  context.after(async () => {
    route.close();
    await rm(directory, { recursive: true, force: true });
  });

  // The demo directory does not exist: listing still works, calls fail alone.
  const settings = { openRig: { directory: join(directory, 'no-demo') } };
  await writeFile(join(directory, 'claude-tools.json'), JSON.stringify(settings));

  const bridge = startBridge(directory, directory, route);
  const names = (await bridge.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.deepEqual(names, [
    'companion_choices',
    'companion_name_session',
    'openrig_submit',
    'openrig_progress',
    'openrig_preview',
  ]);

  const start = await bridge.request('tools/call', {
    name: 'openrig_preview',
    arguments: { action: 'start', id: 'synthetic' },
    _meta: { 'claudecode/toolUseId': 'toolu_start' },
  });
  assert.equal(start.result.isError, true);
  assert.match(start.result.content[0].text, /require direct human confirmation/);

  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test('the real bridge adds configured web tools with the default address policy', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-tools-'));
  const route = await TurnResultRoute.open();
  context.after(async () => {
    route.close();
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, 'claude-tools.json'), '{"web":{}}');
  const bridge = startBridge(directory, directory, route);
  const names = (await bridge.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.deepEqual(names, [
    'companion_choices',
    'companion_name_session',
    'fetch_content',
    'get_search_content',
  ]);

  // Loopback and file URLs are refused before any connection: no network.
  const cases: [Record<string, unknown>, string][] = [
    [
      { url: 'http://127.0.0.1:9/' },
      'Error: 127.0.0.1 resolves to a local or private address, which is not fetched',
    ],
    [{ url: 'file:///etc/hostname' }, 'Error: Only http and https URLs can be fetched, not file:'],
  ];
  for (const [parameters, text] of cases) {
    const reply = await bridge.request('tools/call', {
      name: 'fetch_content',
      arguments: parameters,
      _meta: { 'claudecode/toolUseId': 'toolu_fetch' },
    });
    assert.deepEqual(reply.result, { content: [{ type: 'text', text }] });
  }

  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
});
