/**
 * Frame origin options (src/remote/README.md, "Widget and application
 * frames" → Options): which combinations the gateway accepts, and the CLI's
 * usage errors. Nothing is bound here except by the CLI cases, which fail
 * before binding.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';

import { checkFrameOptions, type FrameOriginOptions } from '../../src/remote/frames/server.ts';

const tls = { cert: 'synthetic', key: 'synthetic' };

function options(overrides: Partial<FrameOriginOptions>): FrameOriginOptions {
  return {
    listen: { host: '127.0.0.1', port: 8788 },
    origin: 'http://127.0.0.1:8788',
    gatewayOrigins: ['http://127.0.0.1:8787'],
    widgetSocket: '/run/user/1000/companion/widgets.sock',
    log: () => {},
    ...overrides,
  };
}

const cases: Array<{ name: string; options: Partial<FrameOriginOptions>; accepted: boolean }> = [
  { name: 'loopback HTTP', options: {}, accepted: true },
  {
    name: 'loopback behind Tailscale Serve (https origin)',
    options: { origin: 'https://desk.example.ts.net:8444' },
    accepted: true,
  },
  {
    name: 'a Unix socket with an https origin',
    options: {
      listen: { socketPath: '/run/user/1000/companion-phone/frames.sock' },
      origin: 'https://desk.example.ts.net:8444',
    },
    accepted: true,
  },
  {
    name: 'a Tailscale address with the gateway TLS certificate',
    options: {
      listen: { host: '100.64.0.1', port: 8444 },
      origin: 'https://desk.example.ts.net:8444',
      tls,
    },
    accepted: true,
  },
  {
    name: 'the same origin as the gateway',
    options: { origin: 'http://127.0.0.1:8787' },
    accepted: false,
  },
  {
    name: 'the same origin as an app',
    options: { origin: 'https://app.example.ts.net', appOrigins: ['https://app.example.ts.net'] },
    accepted: false,
  },
  {
    name: 'an origin with a path',
    options: { origin: 'https://desk.example.ts.net/frames' },
    accepted: false,
  },
  {
    name: 'plain HTTP on a non-loopback origin',
    options: { origin: 'http://desk.example' },
    accepted: false,
  },
  {
    name: 'a non-loopback address without TLS',
    options: { listen: { host: '100.64.0.1', port: 8444 }, origin: 'https://desk.example.ts.net' },
    accepted: false,
  },
  {
    name: 'TLS with an http origin',
    options: { tls },
    accepted: false,
  },
  {
    name: 'every interface',
    options: { listen: { host: '0.0.0.0', port: 8444 }, origin: 'https://desk.example', tls },
    accepted: false,
  },
  {
    name: 'a host name instead of an address',
    options: { listen: { host: 'desk.example', port: 8444 }, origin: 'https://desk.example', tls },
    accepted: false,
  },
  {
    name: 'a Unix socket with an http origin',
    options: { listen: { socketPath: '/run/user/1000/frames.sock' } },
    accepted: false,
  },
  {
    name: 'a relative Unix socket path',
    options: { listen: { socketPath: 'frames.sock' }, origin: 'https://desk.example' },
    accepted: false,
  },
  ...['0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '::'].map((host) => ({
    name: `every interface spelled ${host}`,
    options: { listen: { host, port: 8444 }, origin: 'https://desk.example', tls },
    accepted: false,
  })),
  {
    name: 'an app origin on the same host name, another port',
    options: {
      origin: 'https://desk.example.ts.net:8444',
      appOrigins: ['https://desk.example.ts.net:9443'],
    },
    accepted: false,
  },
  {
    name: 'a wildcard gateway origin',
    options: { gatewayOrigins: ['https://*.example'], origin: 'https://frames.example' },
    accepted: false,
  },
  {
    name: 'a wildcard frame origin',
    options: { origin: 'https://*.example' },
    accepted: false,
  },
  {
    name: 'an IPv6 loopback gateway origin',
    options: { gatewayOrigins: ['http://[::1]:8787'], origin: 'http://[::1]:8788' },
    accepted: true,
  },
];

for (const entry of cases) {
  test(`frame options: ${entry.name} is ${entry.accepted ? 'accepted' : 'refused'}`, () => {
    if (entry.accepted) {
      checkFrameOptions(options(entry.options));
    } else {
      assert.throws(() => checkFrameOptions(options(entry.options)));
    }
  });
}

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/remote/cli.ts', ...args],
      { env: { ...process.env, XDG_RUNTIME_DIR: '/nonexistent-runtime' }, timeout: 30_000 },
      (error, _stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr });
      },
    );
  });
}

for (const [name, args, message] of [
  ['--frames-listen alone', ['--frames-listen', '127.0.0.1:8788'], /together/],
  ['--frame-origin alone', ['--frame-origin', 'http://127.0.0.1:8788'], /together/],
  [
    'an unparsable --frames-listen',
    ['--frames-listen', 'somewhere', '--frame-origin', 'http://127.0.0.1:8788'],
    /HOST:PORT/,
  ],
] as const) {
  test(`frame CLI: ${name} is a usage error`, async () => {
    const result = await runCli(['serve', ...args]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, message);
  });
}
