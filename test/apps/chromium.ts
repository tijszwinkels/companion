/**
 * Headless Chromium driver for the local-app tests.
 *
 * Unlike test/mobile/browser.ts it launches with caller-supplied arguments, so
 * a test can use the exact per-app profile arguments from src/apps/desktop.ts
 * and relaunch the same persistent profile. Control uses the DevTools pipe (no
 * debugging port). Test-only code; it navigates only to loopback origins.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type Json = Record<string, any>;

export const chromiumPath = '/usr/lib/chromium/chromium';

export class HeadlessChromium {
  private child?: ChildProcess;
  private next = 0;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  private readonly listeners = new Set<(message: Json) => void>();

  /** `profileArguments` must include --user-data-dir. */
  constructor(private readonly profileArguments: string[]) {}

  start(): void {
    this.child = spawn(
      chromiumPath,
      [
        ...this.profileArguments,
        '--headless=new',
        '--remote-debugging-pipe',
        '--disable-background-networking',
        '--disable-component-update',
        'about:blank',
      ],
      // Own process group, so close() also reaps renderer/helper processes.
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true },
    );

    (this.child.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let end = this.buffer.indexOf('\0');
      while (end >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end)) as Json;
        this.buffer = this.buffer.slice(end + 1);

        if (typeof message.id === 'number') {
          const waiting = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            waiting?.reject(Error(JSON.stringify(message.error)));
          } else {
            waiting?.resolve(message.result ?? {});
          }
        } else {
          for (const listener of this.listeners) {
            listener(message);
          }
        }

        end = this.buffer.indexOf('\0');
      }
    });
  }

  call(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP ${method} timed out`));
      }, 10_000);
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

  /** A new tab in the browser's default (persistent) profile context. */
  async page(): Promise<Page> {
    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.call('Page.enable');
    await page.call('Runtime.enable');
    await page.call('DOM.enable');
    return page;
  }

  /** Close the browser and wait for its whole process group to exit. */
  async close(): Promise<void> {
    if (this.child?.pid && this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child!.once('exit', resolve));
      // Close normally first so the persistent profile is flushed to disk.
      await this.call('Browser.close').catch(() => {});
      const timer = setTimeout(() => {
        try {
          process.kill(-this.child!.pid!, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, 5000);
      await exited;
      clearTimeout(timer);
    }
    for (const stream of [this.child?.stdio[3], this.child?.stdio[4]]) {
      (stream as Readable | undefined)?.destroy();
    }
  }
}

export class Page {
  constructor(
    private readonly browser: HeadlessChromium,
    readonly sessionId: string,
  ) {}

  call(method: string, params: Json = {}): Promise<Json> {
    return this.browser.call(method, params, this.sessionId);
  }

  /** Navigate and wait for the load event. */
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
    await loaded;
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
  async waitFor(expression: string, timeout = 10_000): Promise<void> {
    const until = Date.now() + timeout;
    let lastError = '';
    while (Date.now() < until) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
          return;
        }
      } catch (error) {
        // The page may be navigating; keep polling.
        lastError = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out waiting for: ${expression} ${lastError}`);
  }

  /** A real mouse click at the centre of an element (a user gesture). */
  async click(selector: string): Promise<void> {
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

    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.call('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }

  /**
   * Click a file input like a user, answer the browser's file chooser with
   * the given files, and return once they are selected.
   */
  async chooseFiles(selector: string, files: string[]): Promise<void> {
    await this.call('Page.setInterceptFileChooserDialog', { enabled: true });

    const opened = new Promise<Json>((resolve) => {
      const stop = this.browser.on((message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.fileChooserOpened') {
          stop();
          resolve(message.params);
        }
      });
    });

    await this.click(selector);
    const chooser = await opened;
    await this.call('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId });
    await this.call('Page.setInterceptFileChooserDialog', { enabled: false });
  }
}
