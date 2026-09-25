import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { publicAddressesOnly } from '../../src/agents/claude/parity/web/address-policy.ts';
import { findContent } from '../../src/agents/claude/parity/web/content-find.ts';
import {
  ContentStore,
  maximumStoreBytes,
  newResponseId,
  retentionMilliseconds,
} from '../../src/agents/claude/parity/web/content-store.ts';
import { htmlTitle, htmlToText } from '../../src/agents/claude/parity/web/html-text.ts';
import {
  maximumBodyBytes,
  safeFetchText,
  type SafeFetchOptions,
} from '../../src/agents/claude/parity/web/safe-fetch.ts';
import { webTools } from '../../src/agents/claude/parity/web/web-tools.ts';

/**
 * A synthetic web on loopback. All test names resolve through a fixed table,
 * never real DNS. The test policy treats exactly 127.0.0.1 as a "public"
 * fixture address and applies the real policy to everything else, so a
 * redirect or name pointing at any other private range is still refused.
 */
const fixtureAddress = '127.0.0.1';
const names: Record<string, string[]> = {
  'site.test': [fixtureAddress],
  'intranet.test': ['192.168.1.10'],
  'metadata.test': ['169.254.169.254'],
  'split.test': [fixtureAddress, '10.0.0.7'],
  'localhost.test': ['::1'],
};

const fixtureFetch: SafeFetchOptions = {
  resolveHost: async (hostname) => names[hostname] ?? [],
  addressPolicy: (address) => address === fixtureAddress || publicAddressesOnly(address),
};

type Route = (response: ServerResponse, port: number) => void;

async function syntheticWeb(routes: Record<string, Route>) {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.headers.host} ${request.url}`);
    const route = routes[request.url ?? ''];
    if (route) {
      route(response, port);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('missing');
    }
  });
  server.listen(0, fixtureAddress);
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  return {
    port,
    requests,
    url: (path: string) => `http://site.test:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const html = (body: string) => (response: ServerResponse) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
};

const signal = () => new AbortController().signal;

test('the address policy admits only public unicast addresses', () => {
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(publicAddressesOnly(address), true, address);
  }

  const refused = [
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:0:4136:e378::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'not-an-address',
  ];
  for (const address of refused) {
    assert.equal(publicAddressesOnly(address), false, address);
  }
});

test('non-HTTP schemes, credentials, literal and resolved private addresses are refused before connecting', async (context) => {
  const web = await syntheticWeb({ '/': html('<p>fixture</p>') });
  context.after(() => web.close());

  const refusals: [string, RegExp][] = [
    ['file:///etc/passwd', /Only http and https URLs/],
    ['ftp://site.test/file', /Only http and https URLs/],
    ['data:text/plain,hello', /Only http and https URLs/],
    ['javascript:alert(1)', /Only http and https URLs/],
    [`http://user:secret@site.test:${web.port}/`, /embedded credentials/],
    [`http://127.0.0.2:${web.port}/`, /local or private address/],
    [`http://[::1]:${web.port}/`, /local or private address/],
    [`http://[::ffff:127.0.0.2]:${web.port}/`, /local or private address/],
    // Alternative IPv4 notations normalize to the loopback network.
    [`http://2130706434:${web.port}/`, /local or private address/],
    [`http://0x7f.0.0.2:${web.port}/`, /local or private address/],
    [`http://intranet.test:${web.port}/`, /local or private address/],
    [`http://metadata.test:${web.port}/latest/meta-data/`, /local or private address/],
    [`http://localhost.test:${web.port}/`, /local or private address/],
    // One private answer among public ones is enough to refuse.
    [`http://split.test:${web.port}/`, /local or private address/],
    [`http://unknown.test:${web.port}/`, /did not resolve/],
    ['not a url', /Invalid URL/],
  ];

  for (const [url, message] of refusals) {
    await assert.rejects(safeFetchText(url, signal(), fixtureFetch), message, url);
  }
  assert.deepEqual(web.requests, []);

  // The real default policy refuses the fixture itself, too.
  await assert.rejects(
    safeFetchText(`http://127.0.0.1:${web.port}/`, signal()),
    /local or private address/,
  );
  assert.deepEqual(web.requests, []);
});

test('every redirect hop is checked again, and redirect chains are bounded', async (context) => {
  const redirect = (location: string) => (response: ServerResponse) => {
    response.writeHead(302, { Location: location });
    response.end();
  };
  const web = await syntheticWeb({
    '/to-intranet': redirect('http://intranet.test/admin'),
    '/to-private-literal': redirect('http://10.0.0.1/'),
    '/to-metadata': redirect('http://169.254.169.254/latest/meta-data/'),
    '/to-file': redirect('file:///etc/passwd'),
    '/relative': redirect('/final'),
    '/final': html('<title>Final</title><p>arrived</p>'),
    '/loop': redirect('/loop'),
  });
  context.after(() => web.close());

  for (const path of ['/to-intranet', '/to-private-literal', '/to-metadata']) {
    await assert.rejects(
      safeFetchText(web.url(path), signal(), fixtureFetch),
      /local or private address/,
    );
  }
  await assert.rejects(
    safeFetchText(web.url('/to-file'), signal(), fixtureFetch),
    /Only http and https/,
  );

  const followed = await safeFetchText(web.url('/relative'), signal(), fixtureFetch);
  assert.equal(followed.url, web.url('/final'));
  assert.match(followed.body, /arrived/);

  await assert.rejects(
    safeFetchText(web.url('/loop'), signal(), fixtureFetch),
    /More than 5 redirects/,
  );
  assert.equal(web.requests.filter((request) => request.endsWith('/loop')).length, 6);

  // The Host header names the host, while the connection used the vetted address.
  assert.ok(web.requests.includes(`site.test:${web.port} /relative`));
});

test('a DNS lookup that never answers follows cancellation and the deadline', async (context) => {
  const web = await syntheticWeb({
    '/to-stalled': (response) => {
      response.writeHead(302, { Location: 'http://stalled.test/' });
      response.end();
    },
  });
  context.after(() => web.close());

  // Names in `names` resolve normally; `stalled.test` hangs until the test
  // itself answers it, like a lookup that getaddrinfo never completes.
  const lookups: string[] = [];
  let answerStalled: (addresses: string[]) => void = () => {};
  const stalledFetch: SafeFetchOptions = {
    ...fixtureFetch,
    resolveHost: (hostname) => {
      lookups.push(hostname);
      if (hostname !== 'stalled.test') {
        return Promise.resolve(names[hostname] ?? []);
      }
      return new Promise((resolve) => {
        answerStalled = resolve;
      });
    },
  };
  const waitForLookup = async (hostname: string) => {
    while (!lookups.includes(hostname)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  // Cancellation during the lookup ends the fetch at once.
  const cancelled = new AbortController();
  const cancelledFetch = safeFetchText('http://stalled.test/', cancelled.signal, stalledFetch);
  await waitForLookup('stalled.test');
  cancelled.abort();
  await assert.rejects(cancelledFetch, { name: 'AbortError' });

  // A late answer to the abandoned lookup is never connected to, even though
  // it now names the (fixture-public) address of the synthetic web.
  answerStalled([fixtureAddress]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(web.requests, []);

  // The lookup of a redirect target is bound in the same way.
  lookups.length = 0;
  const redirected = new AbortController();
  const redirectedFetch = safeFetchText(web.url('/to-stalled'), redirected.signal, stalledFetch);
  await waitForLookup('stalled.test');
  redirected.abort();
  await assert.rejects(redirectedFetch, { name: 'AbortError' });
  assert.deepEqual(web.requests, [`site.test:${web.port} /to-stalled`]);

  // Without cancellation, the fetch deadline ends the lookup.
  await assert.rejects(
    safeFetchText('http://stalled.test/', signal(), { ...stalledFetch, timeoutMilliseconds: 50 }),
    { name: 'TimeoutError' },
  );

  // An already cancelled fetch does not start a lookup at all.
  lookups.length = 0;
  const early = new AbortController();
  early.abort();
  await assert.rejects(safeFetchText('http://stalled.test/', early.signal, stalledFetch), {
    name: 'AbortError',
  });
  assert.deepEqual(lookups, []);
});

test('bodies are bounded (also after decompression), and only text is accepted', async (context) => {
  const web = await syntheticWeb({
    '/large': (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(Buffer.alloc(maximumBodyBytes + 1, 'a'));
    },
    '/bomb': (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(Buffer.alloc(maximumBodyBytes * 4, 'a')));
    },
    '/compressed': (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      response.end(gzipSync('compressed text'));
    },
    '/image': (response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(Buffer.from([137, 80, 78, 71]));
    },
    '/latin1': (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=iso-8859-1' });
      response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    },
    '/untyped-binary': (response) => {
      response.end(Buffer.from([1, 0, 2, 0]));
    },
    '/status': (response) => {
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('down');
    },
  });
  context.after(() => web.close());

  await assert.rejects(
    safeFetchText(web.url('/large'), signal(), fixtureFetch),
    /exceeds the 5 MiB limit/,
  );
  await assert.rejects(
    safeFetchText(web.url('/bomb'), signal(), fixtureFetch),
    /exceeds the 5 MiB limit/,
  );
  assert.equal(
    (await safeFetchText(web.url('/compressed'), signal(), fixtureFetch)).body,
    'compressed text',
  );
  await assert.rejects(
    safeFetchText(web.url('/image'), signal(), fixtureFetch),
    /Unsupported content type image\/png/,
  );
  assert.equal((await safeFetchText(web.url('/latin1'), signal(), fixtureFetch)).body, 'café');
  await assert.rejects(
    safeFetchText(web.url('/untyped-binary'), signal(), fixtureFetch),
    /Unsupported binary response/,
  );
  await assert.rejects(
    safeFetchText(web.url('/status'), signal(), fixtureFetch),
    /HTTP 503 Service Unavailable/,
  );
});

test('readable HTML text drops non-content and keeps structure', () => {
  const page = `<!doctype html><html><head><title>A &amp; B</title><style>p{}</style></head>
<body><script>alert("x")</script><!-- hidden --><h1>Heading</h1>
<p>First&nbsp;paragraph with <a href="/x">a link</a>.</p><ul><li>one</li><li>two</li></ul>
<p>Line<br>break &#8212; &#x2014; &unknown;</p><noscript>no</noscript></body></html>`;

  assert.equal(htmlTitle(page), 'A & B');
  assert.equal(
    htmlToText(page),
    'Heading\n\nFirst paragraph with a link.\n\n- one\n\n- two\n\nLine\nbreak — — &unknown;',
  );
});

test('findContent follows the pi-web-access contract', () => {
  const text = 'Alpha beta.\n\nThe Quick brown fox.\n\nquick again';
  assert.equal(
    findContent(text, ['quick'], 'case-insensitive').text,
    'Text matches (case-insensitive)\n\n1. "quick" ×2\nAlpha beta. The Quick brown fox. quick again',
  );
  assert.equal(findContent(text, ['quick'], 'exact').matchCount, 1);
  assert.equal(
    findContent(text, ['missing', 'Alpha'], 'exact').text,
    'Text matches (exact)\n\n1. "Alpha" ×1\nAlpha beta. The Quick brown fox. quick again\n\nNo matches: "missing"',
  );
  assert.equal(
    findContent(text, ['nothing'], 'exact').text,
    'Text matches (exact): no matches\n\nNo matches: "nothing"',
  );

  // Fuzzy: small misspellings and diacritics, most query words per paragraph.
  const fuzzy = findContent('Première étape.\n\nAutre chose.', ['premiere etapes'], 'fuzzy');
  assert.equal(fuzzy.matchCount, 1);

  // Context is 400 characters each side, with ellipses when cut.
  const long = `${'a'.repeat(1000)} needle ${'b'.repeat(1000)}`;
  const found = findContent(long, ['needle'], 'exact').text;
  assert.ok(found.includes(`…${'a'.repeat(399)} needle ${'b'.repeat(399)}…`));

  // Output stays below 20,000 characters and says how much it shows.
  const many = Array.from({ length: 200 }, (_, index) => `${'x'.repeat(900)} hit${index}`).join(
    '\n',
  );
  const bounded = findContent(many, ['hit'], 'exact');
  assert.ok(bounded.text.length <= 20_000);
  assert.match(bounded.text, /Showing \d+ of 200 matches\.$/);
});

test('fetch_content and get_search_content: exact slices, passages and retained results', async (context) => {
  const runtime = await mkdtemp(join(tmpdir(), 'companion-claude-web-test-'));
  context.after(() => rm(runtime, { recursive: true, force: true }));

  const longBody = Array.from(
    { length: 5000 },
    (_, index) => `line ${index} of the synthetic body`,
  );
  const web = await syntheticWeb({
    '/article': html(
      '<html><head><title>Synthetic article</title></head><body><p>The claim: water boils at 100 °C at sea level.</p></body></html>',
    ),
    '/long': (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(longBody.join('\n'));
    },
  });
  context.after(() => web.close());

  const store = new ContentStore(join(runtime, 'companion-claude-web'));
  const [fetchTool, getContent] = webTools({ store, fetchOptions: fixtureFetch });
  const fetch = (parameters: Record<string, unknown>) =>
    fetchTool.execute('toolu_fetch', parameters, signal()) as Promise<string>;
  const get = (parameters: Record<string, unknown>) =>
    getContent.execute('toolu_get', parameters, signal()) as Promise<string>;

  assert.equal(await fetch({}), 'Error: No URL provided.');
  assert.equal(
    await fetch({ urls: Array.from({ length: 11 }, () => web.url('/article')) }),
    'Error: At most 10 URLs per call.',
  );
  assert.equal(
    await fetch({ url: 'http://intranet.test/' }),
    'Error: intranet.test resolves to a local or private address, which is not fetched',
  );

  const readable = await fetch({ url: web.url('/article') });
  const responseId = /responseId: ([0-9a-f]{32})$/.exec(readable)![1];
  assert.equal(
    readable,
    `The claim: water boils at 100 °C at sea level.\n\n---\nresponseId: ${responseId}`,
  );

  const raw = await fetch({ url: web.url('/article'), mode: 'raw' });
  assert.ok(
    raw.startsWith(
      '<html><head><title>Synthetic article</title></head><body><p>The claim: water boils',
    ),
  );

  const passage = await get({ responseId, urlIndex: 0, findText: 'boils at 100' });
  assert.equal(
    passage,
    '# Synthetic article\n\nText matches (case-insensitive)\n\n1. "boils at 100" ×1\nThe claim: water boils at 100 °C at sea level.',
  );

  // A long body shows the first slice, ending at a line break, and the way on.
  const long = await fetch({ url: web.url('/long') });
  const longId = /responseId: "([0-9a-f]{32})"/.exec(long)![1];
  const firstEnd = Number(/Showing (\d+) of/.exec(long)![1]);
  const fullLength = longBody.join('\n').length;
  assert.ok(firstEnd <= 30_000 && firstEnd >= 24_000);
  assert.ok(long.includes(`Showing ${firstEnd} of ${fullLength} chars`));
  assert.ok(
    long.includes(
      `Use get_search_content({ responseId: "${longId}", urlIndex: 0, offset: ${firstEnd} }) for the next slice.`,
    ),
  );

  const slice = await get({ responseId: longId, url: web.url('/long'), offset: 10, limit: 20 });
  assert.equal(
    slice,
    `# ${web.url('/long')}\n\n${longBody.join('\n').slice(10, 30)}\n\n---\nShowing chars 10-30 of ${fullLength}. Use get_search_content({ responseId: "${longId}", urlIndex: 0, offset: 30, limit: 20 }) for the next slice.`,
  );

  // Several URLs: a summary, with each failure listed.
  const several = await fetch({ urls: [web.url('/article'), web.url('/missing')] });
  assert.match(several, /^## Fetched URLs\n\n- Synthetic article \(\d+ chars\)\n/);
  assert.match(several, /- http:\/\/site\.test:\d+\/missing: Error - HTTP 404 Not Found\n/);
  const severalId = /responseId: "([0-9a-f]{32})"/.exec(several)![1];
  assert.match(
    await get({ responseId: severalId, urlIndex: 1 }),
    /^Error retrieving URL .*missing.*: HTTP 404 Not Found\./,
  );

  // Error texts for bad lookups.
  assert.match(
    await get({ responseId: '0'.repeat(32), urlIndex: 0 }),
    /^Error: No stored results for responseId/,
  );
  assert.match(await get({ responseId: '../../etc/passwd' }), /^Error: No stored results/);
  assert.match(await get({ responseId, urlIndex: 3 }), /is out of range .*valid indexes are 0-0/);
  assert.match(
    await get({ responseId, url: 'http://other.test/' }),
    /was not found for responseId/,
  );
  assert.match(await get({ responseId }), /^Specify url or urlIndex/);
  assert.match(await get({ responseId, urlIndex: 0, findMode: 'exact' }), /requires findText/);
  assert.match(
    await get({ responseId, urlIndex: 0, offset: 10_000 }),
    /Offset 10000 is out of range/,
  );

  // A second store instance (a later turn's bridge) reads the same results.
  const laterTurn = webTools({ store: new ContentStore(join(runtime, 'companion-claude-web')) });
  assert.match(
    (await laterTurn[1].execute('toolu_later', { responseId, urlIndex: 0 }, signal())) as string,
    /^# Synthetic article/,
  );
});

test('the store is private, expires results, caps its size and refuses unsafe directories', async (context) => {
  const runtime = await mkdtemp(join(tmpdir(), 'companion-claude-web-test-'));
  context.after(() => rm(runtime, { recursive: true, force: true }));
  const directory = join(runtime, 'companion-claude-web');

  let clock = Date.now();
  const store = new ContentStore(directory, () => clock);
  const entry = (content: string) => ({
    id: newResponseId(),
    type: 'fetch' as const,
    timestamp: clock,
    urls: [{ url: 'http://site.test/', title: '', content }],
  });

  const first = entry('first');
  await store.save(first);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, `${first.id}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(first.id), first);

  // Expiry: older than the retention period is gone.
  clock += retentionMilliseconds + 1000;
  assert.equal(await store.load(first.id), undefined);
  assert.deepEqual(await readdir(directory), []);
  clock = Date.now();

  // Size cap: the oldest results go first.
  const large = 'x'.repeat(Math.floor(maximumStoreBytes / 3));
  const saved: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const item = entry(large);
    await store.save(item);
    // Distinct modification times make "oldest" well defined.
    const when = new Date(clock - (10 - index) * 1000);
    await utimes(join(directory, `${item.id}.json`), when, when);
    saved.push(item.id);
  }
  await store.save(entry('small'));
  const remaining = await readdir(directory);
  assert.ok(!remaining.includes(`${saved[0]}.json`));
  assert.ok(remaining.includes(`${saved[3]}.json`));

  // A directory others can read is refused, not repaired.
  await chmod(directory, 0o755);
  await assert.rejects(store.save(entry('refused')), /not a private directory/);
  await chmod(directory, 0o700);

  // A symlink in place of the directory is refused.
  const elsewhere = join(runtime, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
  const linked = join(runtime, 'linked');
  await symlink(elsewhere, linked);
  await assert.rejects(new ContentStore(linked).save(entry('x')), /not a private directory/);

  // Without XDG_RUNTIME_DIR nothing is retained, and fetch_content says so.
  const unavailable = ContentStore.forEnvironment({});
  assert.equal(unavailable.unavailableReason, 'XDG_RUNTIME_DIR is not set');
  await assert.rejects(unavailable.save(entry('x')), /XDG_RUNTIME_DIR is not set/);
  assert.equal(await unavailable.load(first.id), undefined);
});
