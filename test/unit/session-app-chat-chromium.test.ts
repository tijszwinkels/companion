/** Portable Chromium transport uses the same fixed chat bounds as native Qt. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Chromium } from '../../src/widgets/chromium.ts';

const url = 'http://127.0.0.1:1234/view/' + 'a'.repeat(64);

test('portable chat transport admits only scoped fixed POST routes, never grant/redirect/query/foreign URLs', async (context) => {
  const browser = new Chromium();
  const calls: string[] = [];
  const requests: any[] = [];
  context.mock.method(browser, 'call', async (method: string) => {
    calls.push(method);
    return {};
  });
  context.mock.method(globalThis, 'fetch', async (target: unknown, init: unknown) => {
    requests.push({ target, init });
    return new Response('{}');
  });
  for (const operation of ['chat-read', 'chat-send', 'chat-receipt']) {
    await (browser as any).fulfill(
      {
        requestId: 'request',
        request: { url: url + '/' + operation, method: 'POST', postData: '{}' },
      },
      'synthetic',
      true,
    );
    assert.equal(calls.at(-1), 'Fetch.fulfillRequest');
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.init.redirect === 'error'));
  for (const [target, method, allowed] of [
    [url + '/chat-send', 'GET', true],
    [url + '/chat-read', 'PUT', true],
    [url + '/chat-grant', 'POST', true],
    [url + '/chat-send?grant=true', 'POST', true],
    [url + '/chat-send/', 'POST', true],
    [url.replace('127.0.0.1', 'localhost') + '/chat-send', 'POST', true],
    [url + '/chat-send', 'POST', false],
  ]) {
    await (browser as any).fulfill(
      { requestId: 'request', request: { url: target, method, postData: '{}' } },
      'synthetic',
      allowed,
    );
    assert.equal(calls.at(-1), 'Fetch.failRequest');
  }
  assert.equal(requests.length, 3);
});

test('portable chat transport enforces UTF-8 request and response byte boundaries', async (context) => {
  const browser = new Chromium();
  const calls: string[] = [];
  let count = 0;
  let responseBytes = 0;
  context.mock.method(browser, 'call', async (method: string) => {
    calls.push(method);
    return {};
  });
  context.mock.method(globalThis, 'fetch', async () => {
    count++;
    return new Response('x'.repeat(responseBytes));
  });
  for (const [operation, inputLimit, outputLimit] of [
    ['chat-read', 1024, 65536],
    ['chat-send', 32768, 4096],
    ['chat-receipt', 1024, 4096],
  ] as const) {
    responseBytes = outputLimit;
    const request = {
      requestId: 'request',
      request: { url: url + '/' + operation, method: 'POST', postData: 'é'.repeat(inputLimit / 2) },
    };
    const before = count;
    await (browser as any).fulfill(request, 'synthetic', true);
    assert.equal(calls.at(-1), 'Fetch.fulfillRequest');
    assert.equal(count, before + 1);
    request.request.postData += 'a';
    await (browser as any).fulfill(request, 'synthetic', true);
    assert.equal(calls.at(-1), 'Fetch.failRequest');
    assert.equal(count, before + 1, 'Oversized body must never leave the broker');
    request.request.postData = '{}';
    responseBytes = outputLimit + 1;
    await assert.rejects((browser as any).fulfill(request, 'synthetic', true), /exceeds/);
  }
});
