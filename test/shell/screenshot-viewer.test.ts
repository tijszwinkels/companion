import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentMessage, type AgentSession } from '../../src/agents/types.ts';
import { ScreenshotRefused } from '../../integrations/mobile/src/screenshots.ts';
import { pageRow, screenshotPath } from '../../integrations/shell/src/rows.ts';
import {
  ScreenshotViewerState,
  viewerTexts,
  type ScreenshotRequest,
} from '../../integrations/shell/src/screenshots/screenshot-viewer.ts';

/**
 * The screenshot rule (integrations/shell/README.md, "Screenshots") as one
 * table: what a row offers and what the viewer shows for a kept screenshot,
 * one not kept, one removed since the message was drawn, a refused fetch, a
 * lost connection and a second screenshot opened over the first. The ways
 * of closing it (button, Escape, a click outside) and the request's address
 * are checked in the page with the real gateway (screenshot-browser.test.ts).
 */

const conversation = '33333333-3333-4333-8333-333333333333';
const route = `api/screenshots/${conversation}`;

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return { ...chatMessage('m1', 'user', 'Look at this'), screenshot: true, ...overrides };
}

function row(value: AgentMessage) {
  return { key: value.id, message: value, start: null, end: null, revision: 0 };
}

/** A fetch each case answers itself, recording what was asked. */
class FakeFetch {
  readonly asked: { path: string; signal: AbortSignal }[] = [];
  private readonly answers: { resolve(blob: Blob): void; reject(error: Error): void }[] = [];

  readonly fetch = (path: string, signal: AbortSignal): Promise<Blob> => {
    this.asked.push({ path, signal });
    return new Promise((resolve, reject) => {
      this.answers.push({ resolve, reject });
    });
  };

  answer(index: number): { resolve(blob: Blob): void; reject(error: Error): void } {
    return this.answers[index];
  }
}

/** Blob URLs that are counted instead of made. */
class FakeUrls {
  made = 0;
  readonly revoked: string[] = [];
  create = () => {
    this.made++;
    return `blob:test/${this.made}`;
  };
  revoke = (url: string) => {
    this.revoked.push(url);
  };
}

function request(gone: string[] = [], title = 'Trip'): ScreenshotRequest {
  return { path: route, title, gone: () => gone.push(route) };
}

/** The viewer's state now (read through a call, so no earlier check narrows it). */
function kind(viewer: ScreenshotViewerState): string {
  return viewer.state.kind;
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
}

interface Case {
  name: string;
  run(): Promise<void>;
}

const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

const cases: Case[] = [
  {
    name: 'kept: the row offers View screenshot; the viewer loads, then shows it',
    async run() {
      const kept = message({ screenshotUrl: route });
      assert.equal(screenshotPath(kept), route);
      const page = pageRow(row(kept));
      assert.equal(page.screenshotAvailable, true);

      const fetcher = new FakeFetch();
      const urls = new FakeUrls();
      const viewer = new ScreenshotViewerState(fetcher.fetch, urls);
      viewer.open(request());
      assert.deepEqual(viewer.state, { kind: 'loading', title: 'Trip' });
      assert.equal(fetcher.asked[0].path, route);
      fetcher.answer(0).resolve(image);
      await settled();
      assert.deepEqual(viewer.state, { kind: 'shown', title: 'Trip', imageUrl: 'blob:test/1' });
    },
  },
  {
    name: 'not kept: no View screenshot, the existing text',
    async run() {
      // Capture storage off when it was sent.
      const unsaved = message({ screenshotSaved: false });
      assert.equal(screenshotPath(unsaved), '');
      const page = pageRow(row(unsaved));
      assert.equal(page.screenshotAvailable, false);
      assert.equal(page.screenshotNotSaved, true);
      // No route from the gateway (not saved yet, or not the gateway's route).
      for (const url of [undefined, 'file:///tmp/x.png', 'api/screenshots/../x']) {
        const without = message({ screenshotUrl: url });
        assert.equal(pageRow(row(without)).screenshotAvailable, false, String(url));
      }
    },
  },
  {
    name: 'removed since the message was drawn: unavailable in the viewer and then in the row',
    async run() {
      const fetcher = new FakeFetch();
      const viewer = new ScreenshotViewerState(fetcher.fetch, new FakeUrls());
      const gone: string[] = [];
      viewer.open(request(gone));
      fetcher.answer(0).reject(new ScreenshotRefused(404));
      await settled();
      assert.deepEqual(viewer.state, {
        kind: 'failed',
        title: 'Trip',
        message: viewerTexts.gone,
        canRetry: false,
      });
      assert.deepEqual(gone, [route]);
      // The bridge then labels the row as one without a kept screenshot.
      const page = pageRow(row(message({ screenshotUrl: route })), { screenshotGone: true });
      assert.equal(page.screenshotAvailable, false);
      assert.equal(page.screenshotNotSaved, false);
    },
  },
  {
    name: 'fetch refused: the refusal, no Try again',
    async run() {
      const fetcher = new FakeFetch();
      const viewer = new ScreenshotViewerState(fetcher.fetch, new FakeUrls());
      const gone: string[] = [];
      viewer.open(request(gone));
      fetcher.answer(0).reject(new ScreenshotRefused(401));
      await settled();
      assert.deepEqual(viewer.state, {
        kind: 'failed',
        title: 'Trip',
        message: viewerTexts.refused,
        canRetry: false,
      });
      assert.deepEqual(gone, []);
    },
  },
  {
    name: 'disconnected: the loss with Try again, which fetches again',
    async run() {
      const fetcher = new FakeFetch();
      const viewer = new ScreenshotViewerState(fetcher.fetch, new FakeUrls());
      viewer.open(request());
      fetcher.answer(0).reject(new TypeError('Failed to fetch'));
      await settled();
      assert.deepEqual(viewer.state, {
        kind: 'failed',
        title: 'Trip',
        message: viewerTexts.unreachable,
        canRetry: true,
      });
      viewer.retry();
      assert.equal(kind(viewer), 'loading');
      assert.equal(fetcher.asked.length, 2);
      fetcher.answer(1).resolve(image);
      await settled();
      assert.equal(kind(viewer), 'shown');
    },
  },
  {
    name: 'closed: the request is aborted, the image revoked, a late answer ignored',
    async run() {
      const fetcher = new FakeFetch();
      const urls = new FakeUrls();
      const viewer = new ScreenshotViewerState(fetcher.fetch, urls);
      viewer.open(request());
      fetcher.answer(0).resolve(image);
      await settled();
      viewer.close();
      assert.deepEqual(viewer.state, { kind: 'closed' });
      assert.deepEqual(urls.revoked, ['blob:test/1']);
      // Closed while loading: aborted, and its answer makes no image.
      viewer.open(request());
      viewer.close();
      assert.equal(fetcher.asked[1].signal.aborted, true);
      fetcher.answer(1).resolve(image);
      await settled();
      assert.equal(urls.made, 1);
      assert.deepEqual(viewer.state, { kind: 'closed' });
    },
  },
  {
    name: 'a second one opened: the first request aborted, its image revoked, the second shown',
    async run() {
      const fetcher = new FakeFetch();
      const urls = new FakeUrls();
      const viewer = new ScreenshotViewerState(fetcher.fetch, urls);
      viewer.open(request([], 'First'));
      fetcher.answer(0).resolve(image);
      await settled();
      viewer.open(request([], 'Second'));
      assert.deepEqual(urls.revoked, ['blob:test/1']);
      assert.deepEqual(viewer.state, { kind: 'loading', title: 'Second' });
      // Opened again before the second answered: that one is aborted too.
      viewer.open(request([], 'Third'));
      assert.equal(fetcher.asked[1].signal.aborted, true);
      fetcher.answer(1).resolve(image);
      fetcher.answer(2).resolve(image);
      await settled();
      assert.deepEqual(viewer.state, { kind: 'shown', title: 'Third', imageUrl: 'blob:test/2' });
    },
  },
];

for (const testCase of cases) {
  test(`screenshot: ${testCase.name}`, testCase.run);
}

test('screenshot: the bridge opens only a kept screenshot of the shown conversation', async () => {
  const { GatewayChatBridge } = await import('../../integrations/shell/src/bridge.ts');
  const session: AgentSession = {
    id: conversation,
    title: 'Trip',
    status: 'completed',
    model: 'm',
    error: '',
    messages: [
      message({ id: 'kept', screenshotUrl: route }),
      message({ id: 'unsaved', screenshotSaved: false }),
    ],
    updatedAt: 1,
    toolEpoch: 'e1',
  };
  const listeners = new Set<() => void>();
  const store = {
    state: {
      connection: { status: 'online', message: '', retryAt: 0, deviceName: '' },
      engine: { paused: false } as object | undefined,
      sessions: new Map([[conversation, session]]),
      selected: conversation,
      sends: new Map(),
      actions: undefined,
    },
    connection: { request: () => new Promise(() => {}) },
    request: () => new Promise(() => {}),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    draft: () => '',
    setDraft() {},
    open() {},
  };
  const bridge = new GatewayChatBridge(store as never, {
    visibleIndexes: () => [],
    topIndex: () => -1,
  });
  const opened: ScreenshotRequest[] = [];
  bridge.onScreenshot((value) => opened.push(value));

  bridge.openScreenshot('another-conversation', 'kept@0');
  bridge.openScreenshot(conversation, 'unsaved@0');
  bridge.openScreenshot(conversation, 'missing');
  assert.equal(opened.length, 0);

  bridge.openScreenshot(conversation, 'kept@0');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, route);
  assert.equal(opened[0].title, 'Trip');

  // Gone: not opened again.
  opened[0].gone();
  bridge.openScreenshot(conversation, 'kept@0');
  assert.equal(opened.length, 1);
});
