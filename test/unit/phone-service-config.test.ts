/**
 * `companion-phone` building blocks without systemd: config validation and
 * storage, the transient unit plan (quoting, pinning, sandbox), the pin check
 * (in TypeScript and as the shell program systemd runs) and the Serve
 * classifier. Real systemd behavior is in test/phone-service/.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  loadConfig,
  saveConfig,
  validateConfig,
  type PhoneServiceConfig,
} from '../../src/remote/service/config.ts';
import {
  pinCheckProgram,
  runPinCheck,
  verifyPinnedCheckout,
} from '../../src/remote/service/pin.ts';
import { classifyServeConfig } from '../../src/remote/service/probes.ts';
import {
  descriptionMarker,
  systemdRunArguments,
  transientServicePlan,
} from '../../src/remote/service/transient-unit.ts';
import { createPinnedCheckout } from '../phone-service-fakes.ts';

const run = promisify(execFile);

const revision = 'a'.repeat(40);

function sampleConfig(overrides: Partial<PhoneServiceConfig> = {}): PhoneServiceConfig {
  return {
    version: 1,
    origin: 'https://desk.tailnet-name.ts.net',
    tailscaleLogin: 'someone@github',
    checkout: '/home/someone/src/companion-phone-pinned',
    revision,
    nodeExecutable: '/usr/bin/node',
    stateDirectory: '/home/someone/companion/remote',
    sessionsDirectory: '/home/someone/companion/agents/.companion-sessions',
    controlSocket: '/run/user/1000/companion/control.sock',
    unitName: 'companion-phone-gateway',
    runtimeDirectoryName: 'companion-phone',
    ...overrides,
  };
}

const tools = { git: '/usr/bin/git', tailscale: '/usr/bin/tailscale', flock: '/usr/bin/flock' };

async function temporaryDirectory(context: { after(callback: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-phone-config-')));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('config validation accepts plain values and refuses anything needing quotes', () => {
  assert.deepEqual(validateConfig(sampleConfig()), sampleConfig());

  const refused: [Partial<PhoneServiceConfig>, RegExp][] = [
    [{ origin: 'http://desk.tailnet-name.ts.net' }, /--origin/],
    [{ origin: 'https://desk.tailnet-name.ts.net:8443' }, /--origin/],
    [{ origin: 'https://desk.tailnet-name.ts.net/' }, /--origin/],
    [{ origin: 'https://Desk.tailnet-name.ts.net' }, /--origin/],
    [{ origin: 'https://user@desk.tailnet-name.ts.net' }, /--origin/],
    [{ origin: 'https://localhost' }, /--origin/],
    [{ tailscaleLogin: 'some one@github' }, /--tailscale-login/],
    [{ tailscaleLogin: "x'@github" }, /--tailscale-login/],
    [{ tailscaleLogin: 'x@github\n--origin' }, /--tailscale-login/],
    [{ tailscaleLogin: 'nologin' }, /--tailscale-login/],
    [{ revision: 'abc123' }, /--revision/],
    [{ revision: 'A'.repeat(40) }, /--revision/],
    [{ checkout: 'relative/path' }, /--checkout must be an absolute/],
    [{ checkout: '/home/some one/companion' }, /--checkout may contain only/],
    [{ checkout: '/home/$USER/companion' }, /--checkout may contain only/],
    [{ checkout: '/home/%h/companion' }, /--checkout may contain only/],
    [{ checkout: "/home/it's/companion" }, /--checkout may contain only/],
    [{ checkout: '/home/x\n/companion' }, /--checkout may contain only/],
    [{ checkout: '/home/x/../companion' }, /--checkout must be a normalized/],
    [{ checkout: '/home/x/companion/' }, /--checkout must be a normalized/],
    [{ stateDirectory: '/home/x//remote' }, /--state-directory must be a normalized/],
    [{ controlSocket: '/run/user/1000/a;b' }, /--control-socket may contain only/],
    [{ nodeExecutable: '/usr/bin/no de' }, /--node may contain only/],
    [{ unitName: 'companion-phone-gateway.service' }, /--unit-name/],
    [{ unitName: 'Companion' }, /--unit-name/],
    [{ runtimeDirectoryName: '../x' }, /--runtime-directory-name/],
  ];
  for (const [override, message] of refused) {
    assert.throws(() => validateConfig(sampleConfig(override)), message, JSON.stringify(override));
  }

  assert.throws(
    () => validateConfig({ ...sampleConfig(), extra: 1 }),
    /Unknown phone service setting/,
  );
  assert.throws(() => validateConfig({ ...sampleConfig(), version: 2 }), /version/);
  assert.throws(() => validateConfig([]), /JSON object/);
});

test('the config is saved 0600 and refused when others could have changed it', async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, 'companion', 'phone-gateway.json');

  assert.equal(await loadConfig(path), undefined);
  await saveConfig(path, sampleConfig());
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(directory, 'companion'))).mode & 0o777, 0o700);
  assert.deepEqual(await loadConfig(path), sampleConfig());

  await chmod(path, 0o620);
  await assert.rejects(loadConfig(path), /writable by other users/);
  await chmod(path, 0o600);

  await chmod(join(directory, 'companion'), 0o777);
  await assert.rejects(loadConfig(path), /writable by other users/);
  await chmod(join(directory, 'companion'), 0o700);

  const link = join(directory, 'companion', 'link.json');
  await symlink(path, link);
  await assert.rejects(loadConfig(link), /symbolic link/);

  await writeFile(path, '{ not json');
  await assert.rejects(loadConfig(path), /not valid JSON/);
});

test('the transient unit runs the pinned checkout with every safeguard', () => {
  const config = sampleConfig();
  const plan = transientServicePlan(config, tools, '/run/user/1000');

  assert.equal(plan.unit, 'companion-phone-gateway.service');
  assert.equal(plan.socketPath, '/run/user/1000/companion-phone/gateway.sock');
  assert.deepEqual(plan.command, [
    '/usr/bin/node',
    '/home/someone/src/companion-phone-pinned/node_modules/tsx/dist/cli.mjs',
    '/home/someone/src/companion-phone-pinned/src/remote/cli.ts',
    'serve',
    '--listen',
    'unix:/run/user/1000/companion-phone/gateway.sock',
    '--origin',
    'https://desk.tailnet-name.ts.net',
    '--require-tailscale-login',
    'someone@github',
    '--check-tailscale-serve',
    '--state-directory',
    '/home/someone/companion/remote',
    '--control-socket',
    '/run/user/1000/companion/control.sock',
    '--sessions-directory',
    '/home/someone/companion/agents/.companion-sessions',
  ]);

  for (const required of [
    'Type=exec',
    'Restart=on-failure',
    'StartLimitBurst=3',
    'StartLimitIntervalSec=60',
    'WorkingDirectory=/home/someone/src/companion-phone-pinned',
    'RuntimeDirectory=companion-phone',
    'RuntimeDirectoryMode=0700',
    'ReadWritePaths=/home/someone/companion/remote',
    'UMask=0077',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'RestrictAddressFamilies=AF_UNIX',
    'SystemCallFilter=@system-service',
  ]) {
    assert.ok(plan.properties.includes(required), `missing ${required}`);
  }

  // Only the state directory is writable; no network families, no JIT-breaking setting.
  assert.equal(
    plan.properties.filter((property) => property.startsWith('ReadWritePaths=')).length,
    1,
  );
  assert.ok(!plan.properties.some((property) => property.startsWith('MemoryDenyWriteExecute')));
  assert.ok(
    plan.properties.some((property) =>
      property.startsWith(`Description=${descriptionMarker}, aaaaaaaaaaaa, `),
    ),
  );
  assert.ok(
    plan.properties.includes(
      `Environment=PATH=/usr/bin:/bin GIT_OPTIONAL_LOCKS=0 COMPANION_PHONE_SERVICE=${plan.fingerprint}`,
    ),
  );

  // The pin check is the only property with `$`, and it disables systemd's expansion.
  const pinCheck = plan.properties.find((property) => property.startsWith('ExecStartPre='))!;
  assert.equal(
    pinCheck,
    `ExecStartPre=:/bin/sh -c '${pinCheckProgram}' companion-phone-pin-check ` +
      `/home/someone/src/companion-phone-pinned ${revision} /usr/bin/git`,
  );
  for (const value of [
    ...plan.properties.filter((property) => property !== pinCheck),
    ...plan.command,
  ]) {
    assert.doesNotMatch(value, /[$%'"\\\n]/, value);
  }
  assert.doesNotMatch(pinCheckProgram, /['%\\\n]/);

  const args = systemdRunArguments(plan);
  assert.deepEqual(args.slice(0, 4), [
    '--user',
    '--unit=companion-phone-gateway.service',
    '--quiet',
    '--expand-environment=no',
  ]);
  assert.ok(!args.includes('--wait'));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), plan.command);
});

test('the fingerprint changes with anything that changes what runs', () => {
  const base = transientServicePlan(sampleConfig(), tools, '/run/user/1000').fingerprint;
  assert.equal(transientServicePlan(sampleConfig(), tools, '/run/user/1000').fingerprint, base);

  const changes = [
    transientServicePlan(sampleConfig({ revision: 'b'.repeat(40) }), tools, '/run/user/1000'),
    transientServicePlan(
      sampleConfig({ origin: 'https://other.tailnet-name.ts.net' }),
      tools,
      '/run/user/1000',
    ),
    transientServicePlan(sampleConfig({ tailscaleLogin: 'other@github' }), tools, '/run/user/1000'),
    transientServicePlan(
      sampleConfig(),
      { ...tools, tailscale: '/opt/bin/tailscale' },
      '/run/user/1000',
    ),
  ];
  for (const plan of changes) {
    assert.notEqual(plan.fingerprint, base);
  }
});

test('an overlong gateway socket path is refused', () => {
  assert.throws(
    () =>
      transientServicePlan(
        sampleConfig({ runtimeDirectoryName: 'x'.repeat(64) }),
        tools,
        '/run/user/1000/' + 'y'.repeat(40),
      ),
    /too long/,
  );
});

test('the pin check accepts only the exact, clean, complete revision', async (context) => {
  const directory = await temporaryDirectory(context);
  const checkout = await createPinnedCheckout(directory);

  assert.deepEqual(await verifyPinnedCheckout(checkout.path, checkout.revision, 'git'), []);

  // Ignored build output does not matter.
  await writeFile(join(checkout.path, 'node_modules', 'extra.js'), '');
  assert.deepEqual(await verifyPinnedCheckout(checkout.path, checkout.revision, 'git'), []);

  assert.match(
    (await verifyPinnedCheckout(checkout.path, 'b'.repeat(40), 'git')).join('\n'),
    /not at the approved revision/,
  );

  await writeFile(join(checkout.path, 'README.md'), 'changed\n');
  assert.match(
    (await verifyPinnedCheckout(checkout.path, checkout.revision, 'git')).join('\n'),
    /uncommitted/,
  );
  await run('git', ['-C', checkout.path, 'checkout', '--quiet', 'README.md']);

  await writeFile(join(checkout.path, 'src', 'injected.ts'), '');
  assert.match(
    (await verifyPinnedCheckout(checkout.path, checkout.revision, 'git')).join('\n'),
    /untracked/,
  );
  await rm(join(checkout.path, 'src', 'injected.ts'));

  await rm(join(checkout.path, 'integrations', 'mobile', 'dist'), { recursive: true });
  assert.match(
    (await verifyPinnedCheckout(checkout.path, checkout.revision, 'git')).join('\n'),
    /no built phone app/,
  );

  const link = join(directory, 'link');
  await symlink(checkout.path, link);
  assert.match(
    (await verifyPinnedCheckout(link, checkout.revision, 'git')).join('\n'),
    /symbolic link/,
  );

  const nested = join(checkout.path, 'src');
  assert.match(
    (await verifyPinnedCheckout(nested, checkout.revision, 'git')).join('\n'),
    /not the top directory/,
  );

  assert.match(
    (await verifyPinnedCheckout(join(directory, 'missing'), checkout.revision, 'git')).join('\n'),
    /does not exist/,
  );
});

test('the shell pin check that systemd runs agrees with the TypeScript one', async (context) => {
  const directory = await temporaryDirectory(context);
  const checkout = await createPinnedCheckout(directory);
  const git = (await run('sh', ['-c', 'command -v git'])).stdout.trim();

  async function shellCheck(revisionToCheck: string): Promise<{ code: number; stderr: string }> {
    try {
      await run('/bin/sh', [
        '-c',
        pinCheckProgram,
        'companion-phone-pin-check',
        checkout.path,
        revisionToCheck,
        git,
      ]);
      return { code: 0, stderr: '' };
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      return { code: failure.code, stderr: failure.stderr };
    }
  }

  assert.equal((await shellCheck(checkout.revision)).code, 0);
  assert.match((await shellCheck('b'.repeat(40))).stderr, /not at the approved revision/);

  await writeFile(join(checkout.path, 'README.md'), 'changed\n');
  assert.match((await shellCheck(checkout.revision)).stderr, /uncommitted changes/);
  await run('git', ['-C', checkout.path, 'checkout', '--quiet', 'README.md']);

  await mkdir(join(checkout.path, 'bin'));
  await writeFile(join(checkout.path, 'bin', 'injected'), '');
  assert.match((await shellCheck(checkout.revision)).stderr, /untracked code files/);
  await rm(join(checkout.path, 'bin'), { recursive: true });

  assert.equal((await shellCheck(checkout.revision)).code, 0);
});

test('the pin check cannot be fooled by index flags, replace refs, excludes, filters, hooks or redirection', async (context) => {
  const directory = await temporaryDirectory(context);
  const checkout = await createPinnedCheckout(directory);
  const git = (...args: string[]) => run('git', ['-C', checkout.path, ...args]);
  const identity = [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ];
  const problems = () => verifyPinnedCheckout(checkout.path, checkout.revision, 'git');
  const source = join(checkout.path, 'src', 'remote', 'cli.ts');
  const original = await readFile(source, 'utf8');

  // assume-unchanged and skip-worktree hide an edit from `git diff`.
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await git('update-index', flag, 'src/remote/cli.ts');
    await writeFile(source, original + '// unreviewed\n');
    assert.match((await problems()).join('\n'), /uncommitted changes/, flag);
    await writeFile(source, original);
    await git('update-index', flag.replace('--', '--no-'), 'src/remote/cli.ts');
  }
  assert.deepEqual(await problems(), []);

  // A replace ref makes Git show another commit's tree for the approved ID.
  await writeFile(join(checkout.path, 'README.md'), 'substituted\n');
  await git(...identity, 'commit', '--quiet', '-am', 'substitute');
  const substitute = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('replace', checkout.revision, substitute);
  await git('checkout', '--quiet', '--detach', checkout.revision);
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), checkout.revision);
  assert.equal(await readFile(join(checkout.path, 'README.md'), 'utf8'), 'substituted\n');
  assert.match((await problems()).join('\n'), /uncommitted changes/);
  await git('replace', '-d', checkout.revision);
  await git('checkout', '--quiet', '--force', '--detach', checkout.revision);
  assert.deepEqual(await problems(), []);

  // Local excludes and a new ignore-everything .gitignore cannot hide new code.
  await writeFile(join(checkout.path, '.git', 'info', 'exclude'), 'src/hidden.ts\n');
  await writeFile(join(checkout.path, 'src', 'hidden.ts'), '');
  assert.match((await problems()).join('\n'), /untracked code files/);
  await rm(join(checkout.path, 'src', 'hidden.ts'));
  await mkdir(join(checkout.path, 'src', 'extra'));
  await writeFile(join(checkout.path, 'src', 'extra', '.gitignore'), '*\n');
  await writeFile(join(checkout.path, 'src', 'extra', 'code.ts'), '');
  assert.match((await problems()).join('\n'), /untracked code files/);
  await rm(join(checkout.path, 'src', 'extra'), { recursive: true });

  // A configured fsmonitor command is never run.
  const marker = join(directory, 'fsmonitor-ran');
  const monitor = join(directory, 'monitor.sh');
  await writeFile(monitor, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  await git('config', 'core.fsmonitor', monitor);
  assert.deepEqual(await problems(), []);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  await git('config', '--unset', 'core.fsmonitor');

  // A clean filter that presents the approved bytes for an edited file is
  // neither trusted nor run.
  const approvedCopy = join(directory, 'approved-cli.ts');
  await writeFile(approvedCopy, original);
  const filterRan = join(directory, 'filter-ran');
  await writeFile(
    join(checkout.path, '.git', 'info', 'attributes'),
    'src/remote/cli.ts filter=mask\n',
  );
  await git('config', 'filter.mask.clean', `sh -c 'touch ${filterRan}; cat ${approvedCopy}'`);
  await writeFile(source, original + '// unreviewed\n');
  assert.match((await problems()).join('\n'), /uncommitted changes/);
  assert.match(
    (await runPinCheck(checkout.path, checkout.revision, 'git')) ?? '',
    /uncommitted changes/,
  );
  await assert.rejects(lstat(filterRan), { code: 'ENOENT' });
  await writeFile(source, original);
  await rm(join(checkout.path, '.git', 'info', 'attributes'));
  await git('config', '--unset', 'filter.mask.clean');
  assert.deepEqual(await problems(), []);

  // core.worktree pointing at a clean copy elsewhere: the shell program
  // itself (what systemd runs) must check the directory it was given.
  const cleanCopy = join(directory, 'clean-copy');
  await run('cp', ['-a', checkout.path, cleanCopy]);
  await rm(join(cleanCopy, '.git'), { recursive: true });
  await writeFile(source, original + '// unreviewed\n');
  await git('config', 'core.worktree', cleanCopy);
  assert.match(
    (await runPinCheck(checkout.path, checkout.revision, 'git')) ?? '',
    /is not the work tree of its own Git repository/,
  );
  await git('config', '--unset', 'core.worktree');
  await writeFile(source, original);
  assert.equal(await runPinCheck(checkout.path, checkout.revision, 'git'), undefined);

  // The executable bit and the file type are part of the pin.
  await chmod(source, 0o755);
  assert.match((await problems()).join('\n'), /changed file mode at src\/remote\/cli.ts/);
  await chmod(source, 0o644);
  await rm(source);
  await symlink(approvedCopy, source);
  assert.match((await problems()).join('\n'), /changed file type at src\/remote\/cli.ts/);
  await rm(source);
  await writeFile(source, original);
  assert.deepEqual(await problems(), []);

  // A code directory replaced by a symlink to other files is a change.
  const elsewhere = join(directory, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'cli.ts'), original);
  await rm(join(checkout.path, 'src', 'remote'), { recursive: true });
  await symlink(elsewhere, join(checkout.path, 'src', 'remote'));
  assert.notDeepEqual(await problems(), []);
});

test('the Serve classifier separates none, ours and everything else', () => {
  const expected = {
    hostname: 'desk.tailnet-name.ts.net',
    socketPath: '/run/user/1000/companion-phone/gateway.sock',
  };
  const ours = {
    TCP: { '443': { HTTPS: true } },
    Web: {
      'desk.tailnet-name.ts.net:443': {
        Handlers: { '/': { Proxy: 'unix:/run/user/1000/companion-phone/gateway.sock' } },
      },
    },
  };

  assert.deepEqual(classifyServeConfig({}, expected), { state: 'none' });
  assert.deepEqual(classifyServeConfig({ TCP: {}, Web: null, AllowFunnel: {} }, expected), {
    state: 'none',
  });
  assert.deepEqual(classifyServeConfig(ours, expected), { state: 'ours' });

  const unexpected: unknown[] = [
    { ...ours, AllowFunnel: { 'desk.tailnet-name.ts.net:443': true } },
    { Foreground: { session: ours } },
    { ...ours, TCP: { ...ours.TCP, '8443': { HTTPS: true } } },
    { ...ours, Services: { 'svc:x': {} } },
    {
      TCP: ours.TCP,
      Web: {
        'desk.tailnet-name.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18787' } } },
      },
    },
    {
      TCP: ours.TCP,
      Web: {
        'desk.tailnet-name.ts.net:443': { Handlers: { '/': { Proxy: 'unix:/tmp/other.sock' } } },
      },
    },
    {
      TCP: ours.TCP,
      Web: { 'other.tailnet-name.ts.net:443': ours.Web['desk.tailnet-name.ts.net:443'] },
    },
    'not an object',
    null,
  ];
  for (const config of unexpected) {
    assert.equal(classifyServeConfig(config, expected).state, 'unexpected', JSON.stringify(config));
  }
});
