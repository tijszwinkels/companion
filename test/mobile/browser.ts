/**
 * Minimal headless Chromium driver for phone-app tests.
 *
 * Launches the system Chromium with a temporary profile and controls it over
 * the DevTools pipe (no debugging port). Unlike src/widgets/chromium.ts it is
 * not network-isolated, because the app must reach the loopback gateway; the
 * tests only ever navigate to 127.0.0.1. Test-only code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

type Json = Record<string, any>;

export const chromiumPath = '/usr/lib/chromium/chromium';

export class TestBrowser {
  private child?: ChildProcess;
  private profile = '';
  private next = 0;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  private readonly listeners = new Set<(message: Json) => void>();

  async start(): Promise<void> {
    this.profile = await mkdtemp(join(tmpdir(), 'companion-mobile-browser-'));
    this.child = spawn(
      chromiumPath,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--force-color-profile=srgb',
        '--user-data-dir=' + this.profile,
        'about:blank',
      ],
      // Own process group, so close() also reaps renderer/helper processes.
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true },
    );

    (this.child.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end)) as Json;
        this.buffer = this.buffer.slice(end + 1);
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            pending?.reject(Error(JSON.stringify(message.error)));
          } else {
            pending?.resolve(message.result ?? {});
          }
        } else {
          for (const listener of this.listeners) {
            listener(message);
          }
        }
      }
    });
  }

  call(method: string, params: Json = {}, sessionId?: string, timeout = 10_000): Promise<Json> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      (this.child!.stdio[3] as Writable).write(
        JSON.stringify({ id, method, params, sessionId }) + '\0',
      );
    });
  }

  on(listener: (message: Json) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A fresh page emulating a phone (touch, mobile viewport, device scale). */
  async phone(width = 390, height = 844, options: { dark?: boolean } = {}): Promise<TestPage> {
    // Each phone gets its own browser context: separate storage and pairing.
    const { browserContextId } = await this.call('Target.createBrowserContext');
    const { targetId } = await this.call('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    const page = new TestPage(this, targetId, sessionId);

    await page.call('Page.enable');
    await page.call('Runtime.enable');
    await page.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.call('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: options.dark ? 'dark' : 'light' }],
    });

    page.watchConsole();
    return page;
  }

  async close(): Promise<void> {
    if (this.child?.pid && this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child!.once('exit', resolve));
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        this.child.kill('SIGKILL');
      }
      await exited;
    }
    for (const stream of [this.child?.stdio[3], this.child?.stdio[4]]) {
      (stream as Readable | undefined)?.destroy();
    }
    if (this.profile) {
      await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

export class TestPage {
  readonly errors: string[] = [];
  readonly requests: string[] = [];

  constructor(
    private readonly browser: TestBrowser,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  call(method: string, params: Json = {}): Promise<Json> {
    return this.browser.call(method, params, this.sessionId);
  }

  /** Record uncaught exceptions, console errors and every requested URL. */
  watchConsole(): void {
    void this.call('Network.enable');
    this.browser.on((message) => {
      if (message.sessionId !== this.sessionId) {
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(JSON.stringify(message.params.exceptionDetails).slice(0, 500));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(
          message.params.args.map((arg: Json) => arg.value ?? arg.description).join(' '),
        );
      }
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push(String(message.params.request.url));
      }
    });
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const stop = this.browser.on((message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.loadEventFired') {
          stop();
          resolve();
        }
      });
    });
    await this.call('Page.navigate', { url });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`Navigation to ${url} timed out`)), 10_000);
    });
    try {
      await Promise.race([loaded, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) {
      throw Error(`Evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 400)}`);
    }
    return reply.result.value as T;
  }

  /** Poll a page expression until it is truthy. */
  async waitFor(expression: string, timeout = 5000): Promise<void> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out waiting for: ${expression}`);
  }

  /** Tap the centre of the first element matching a selector, as a finger would. */
  async tap(selector: string): Promise<void> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!box) {
      throw Error(`No element for ${selector}`);
    }
    const point = [{ x: box.x, y: box.y }];
    await this.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
    await this.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** Type into the focused element via the input pipeline. */
  async type(text: string): Promise<void> {
    await this.call('Input.insertText', { text });
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    await this.browser.call('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
