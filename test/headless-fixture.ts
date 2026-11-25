// A machine without a desktop for tests of `--headless` (see "Running without
// a desktop" in src/desktop/README.md): a temporary HOME and private
// XDG_RUNTIME_DIR, a PATH that holds only `node` and `flock` (no compositor,
// screenshot, typing, sound or PipeWire program can be found), the synthetic
// Claude Code fixture (test/fixtures/claude-stream.mjs) as the coding
// harness, and the real listener and gateway as child processes on loopback.
// No model is called and no personal state is read.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultAgentSettings } from '../src/agents/settings.ts';
import { waitFor } from './desktop-fixture.ts';
import { freePort } from './remote-fixture.ts';

type Context = { after(callback: () => Promise<unknown>): void };

export const root = fileURLToPath(new URL('..', import.meta.url));

/** Every refusal of the mode starts with this (src/desktop/runtime.ts). */
export const withoutDesktop = 'This Companion runs without a desktop';

/** Programs a desktop listener uses; none of them may be on the test's PATH. */
export const desktopPrograms = [
  'hyprctl',
  'grim',
  'wtype',
  'pw-record',
  'pw-play',
  'playerctl',
  'notify-send',
];

/** A child process with its output collected as text. */
export interface Child {
  process: ChildProcess;
  output: () => string;
  /** The exit code, once the process ended and its output was read to the end. */
  exited: Promise<number | null>;
}

export function startChild(command: string, args: string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (text: string) => {
    output += text;
  });
  child.stderr!.on('data', (text: string) => {
    output += text;
  });
  // 'close' rather than 'exit': only then has all of its output arrived.
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
  });
  return { process: child, output: () => output, exited };
}

/** Wait until a child prints `text`, failing early if it exits first. */
export async function printed(child: Child, text: string, milliseconds = 20000): Promise<void> {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  await waitFor(() => child.output().includes(text) || exited, milliseconds);
  assert.ok(child.output().includes(text), `Expected "${text}" in:\n${child.output()}`);
}

/** Stop a child with SIGINT (unless it already ended) and return its exit code. */
export async function interrupt(child: Child): Promise<number | null> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGINT');
  }
  return child.exited;
}

/**
 * A temporary machine without a desktop: HOME, a private runtime directory,
 * a PATH with only node and flock, a synthetic Claude Code as the coding
 * harness and a synthetic intent model address that is never contacted.
 */
export async function headlessMachine(context: Context) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-headless-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const home = join(directory, 'home');
  const runtime = join(directory, 'runtime');
  const binaries = join(directory, 'bin');
  const agents = join(home, 'companion', 'agents');
  await mkdir(agents, { recursive: true });
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(binaries);
  await symlink(process.execPath, join(binaries, 'node'));
  await symlink('/usr/bin/flock', join(binaries, 'flock'));

  const claude = join(directory, 'fixture-claude');
  await copyFile(join(root, 'test/fixtures/claude-stream.mjs'), claude);
  await chmod(claude, 0o700);
  await writeFile(
    join(agents, 'companion-agent.json'),
    JSON.stringify({
      ...defaultAgentSettings,
      codingDefaultHarness: 'claude-code',
      claudeCode: { executable: claude, model: 'claude-opus-5-5', effort: 'high' },
    }),
  );

  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:1/v1' } }));

  // No desktop variables at all, and nothing inherited from this process.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    PATH: binaries,
    LANG: 'C.UTF-8',
  };

  return {
    directory,
    home,
    binaries,
    env,
    config,
    controlSocket: join(runtime, 'companion', 'control.sock'),
    remoteState: join(home, 'companion', 'remote'),
  };
}

export type HeadlessMachine = Awaited<ReturnType<typeof headlessMachine>>;

/** The listener's command line: tsx through node, as `npm start` runs it. */
export function listenerArguments(config: string, extra: string[]): string[] {
  return ['--import', 'tsx', 'src/cli.ts', '--config', config, ...extra];
}

/**
 * The real listener (`src/cli.ts --headless`) and the real gateway
 * (`src/remote/cli.ts serve`) on a free loopback port with its loopback
 * origins, as the running Companion on a server is started. Both are stopped
 * with SIGINT after the test. `pairingCode` asks `companion-remote pair` for
 * a code, as a user would.
 */
export async function startHeadlessCompanion(
  context: Context,
  machine: HeadlessMachine,
  options: { appDirectory?: string } = {},
) {
  const listener = startChild(
    process.execPath,
    listenerArguments(machine.config, ['--headless']),
    machine.env,
  );
  context.after(() => interrupt(listener));
  await printed(listener, 'Without a desktop: typed conversations only');

  const port = await freePort();
  let appDirectory = options.appDirectory;
  if (appDirectory === undefined) {
    appDirectory = join(machine.directory, 'no-app');
    await mkdir(appDirectory);
  }
  const gateway = startChild(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/remote/cli.ts',
      'serve',
      '--port',
      String(port),
      '--control-socket',
      machine.controlSocket,
      '--state-directory',
      machine.remoteState,
      '--app-directory',
      appDirectory,
    ],
    machine.env,
  );
  context.after(() => interrupt(gateway));
  await printed(gateway, '[remote] Serving on');

  async function pairingCode(): Promise<string> {
    const pairing = startChild(
      process.execPath,
      ['--import', 'tsx', 'src/remote/cli.ts', 'pair', '--state-directory', machine.remoteState],
      machine.env,
    );
    assert.equal(await pairing.exited, 0);
    const code = /Pairing code: (\w{5})-(\w{5})/.exec(pairing.output());
    assert.ok(code, pairing.output());
    return code[1] + code[2];
  }

  return { listener, gateway, port, origin: `http://127.0.0.1:${port}`, pairingCode };
}
