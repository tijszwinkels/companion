import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { object, type JsonObject } from './types.ts';

interface Pending {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One owned Chromium process, controlled over anonymous pipes. No debugging
 * port is exposed to widget content, other browser tabs or the network. Every
 * target is guarded before navigating to content, including child frames.
 */
export class Chromium {
  private child?: ChildProcess;
  private profile = '';
  private next = 0;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private closed?: Promise<void>;
  private starting?: Promise<void>;
  private stopped = false;
  private readonly listeners = new Set<(event: JsonObject) => void>();

  constructor(
    private readonly headed = false,
    private readonly executable = '/usr/lib/chromium/chromium',
  ) {}

  private start(): Promise<void> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.stopped) {
      throw Error('Widget browser is closed');
    }
    this.profile = await mkdtemp(join(tmpdir(), 'companion-widget-browser-'));
    if (this.stopped) {
      await rm(this.profile, { recursive: true, force: true });
      throw Error('Widget browser is closed');
    }
    const flags = [
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-extensions',
      '--disable-breakpad',
      '--metrics-recording-only',
      '--disable-features=MediaRouter,OptimizationHints',
      '--force-color-profile=srgb',
      '--autoplay-policy=user-gesture-required',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--user-data-dir=' + this.profile,
    ];
    flags.push(...(this.headed ? ['--app=about:blank'] : ['--headless=new', 'about:blank']));
    // Bubblewrap supplies a private network namespace (including loopback),
    // private /tmp and no home/runtime files. Chromium's own sandbox stays on.
    // The trusted pop-out host's three local API requests are fulfilled over
    // the private CDP pipe; the browser process itself never gets networking.
    const isolation = [
      '--unshare-net',
      '--unshare-pid',
      '--die-with-parent',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib',
      '/lib64',
      '--symlink',
      'usr/bin',
      '/bin',
      '--ro-bind',
      '/etc',
      '/etc',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      this.profile,
      this.profile,
      '--chdir',
      '/tmp',
    ];
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: this.profile,
      LANG: 'C.UTF-8',
    };
    if (this.headed) {
      const runtime = process.env.XDG_RUNTIME_DIR;
      const display = process.env.WAYLAND_DISPLAY;
      if (!runtime?.startsWith('/') || !display || display.includes('/')) {
        throw Error('Widget pop-out requires a Wayland desktop');
      }
      const socket = join(runtime, display);
      await access(socket);
      isolation.push('--ro-bind', socket, socket);
      environment.XDG_RUNTIME_DIR = runtime;
      environment.WAYLAND_DISPLAY = display;
      flags.push('--ozone-platform=wayland');
    }
    const child = spawn('bwrap', [...isolation, '--', this.executable, ...flags], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: environment,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.closed = new Promise((resolve) => child.once('close', () => resolve()));
    const fail = (error: Error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.once('error', fail);
    child.once('exit', () => fail(Error('Widget browser exited')));
    // Drain Chromium diagnostics without mixing its output with the listener's
    // protocol, or retaining arbitrary widget-provided console/error content.
    child.stderr?.resume();
    (child.stdio[3] as Writable).on('error', fail);
    (child.stdio[4] as Readable).setEncoding('utf8');
    (child.stdio[4] as Readable).on('data', (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 16 * 1024 * 1024) {
        fail(Error('Widget browser returned too much data'));
        void this.close();
        return;
      }
      let boundary = this.buffer.indexOf('\0');
      while (boundary >= 0) {
        const encoded = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        try {
          const event = object(JSON.parse(encoded));
          if (typeof event.id === 'number') {
            const pending = this.pending.get(event.id);
            if (pending) {
              this.pending.delete(event.id);
              clearTimeout(pending.timer);
              if (event.error) {
                pending.reject(Error(String(object(event.error).message)));
              } else {
                pending.resolve(object(event.result ?? {}));
              }
            }
          } else {
            for (const listener of this.listeners) {
              listener(event);
            }
          }
        } catch {
          fail(Error('Invalid widget browser response'));
        }
        boundary = this.buffer.indexOf('\0');
      }
    });
  }

  async call(
    method: string,
    params: JsonObject = {},
    sessionId?: string,
    timeout = 8000,
  ): Promise<JsonObject> {
    await this.start();
    if (this.stopped || !this.child || this.child.exitCode !== null || this.pending.size >= 128) {
      throw Error('Widget browser is unavailable');
    }
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Widget browser timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      (this.child!.stdio[3] as Writable).write(
        JSON.stringify({ id, method, params, sessionId }) + '\0',
      );
    });
  }

  async page(allowedRequest: (url: string) => boolean = () => false): Promise<BrowserPage> {
    let targetId: string;
    if (this.headed) {
      let initial: JsonObject | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        const targets = (await this.call('Target.getTargets')).targetInfos as JsonObject[];
        initial = targets.find((target) => target.type === 'page');
        if (initial) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!initial) {
        throw Error('Chromium did not open its widget window');
      }
      targetId = String(initial.targetId);
    } else {
      targetId = String((await this.call('Target.createTarget', { url: 'about:blank' })).targetId);
    }
    const sessionId = String(
      (await this.call('Target.attachToTarget', { targetId, flatten: true })).sessionId,
    );
    const sessions = new Set([sessionId]);
    const guard = async (session: string) => {
      await this.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
      await this.call('Page.enable', {}, session);
      await this.call('Page.setInterceptFileChooserDialog', { enabled: true }, session);
      await this.call(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        session,
      );
      await this.call('Runtime.runIfWaitingForDebugger', {}, session);
    };
    const listener = (event: JsonObject) => {
      if (!sessions.has(String(event.sessionId))) {
        return;
      }
      const params = object(event.params ?? {});
      if (event.method === 'Fetch.requestPaused') {
        const url = String(object(params.request).url);
        void this.fulfill(params, String(event.sessionId), allowedRequest(url)).catch(() => {
          void this.call(
            'Fetch.failRequest',
            { requestId: params.requestId, errorReason: 'BlockedByClient' },
            String(event.sessionId),
          ).catch(() => {});
        });
      } else if (event.method === 'Target.attachedToTarget') {
        const childSession = String(params.sessionId);
        sessions.add(childSession);
        void guard(childSession).catch(() =>
          this.call('Target.closeTarget', { targetId }).catch(() => {}),
        );
      } else if (
        event.method === 'Page.windowOpen' ||
        event.method === 'Page.javascriptDialogOpening'
      ) {
        void this.call(
          'Page.handleJavaScriptDialog',
          { accept: false },
          String(event.sessionId),
        ).catch(() => {});
      }
    };
    this.listeners.add(listener);
    try {
      await guard(sessionId);
      await this.call('Page.enable', {}, sessionId);
      await this.call('Browser.setDownloadBehavior', { behavior: 'deny' });
      await this.call('Browser.grantPermissions', { permissions: [] });
      return new BrowserPage(this, targetId, sessionId, () => this.listeners.delete(listener));
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
  }

  private async fulfill(params: JsonObject, session: string, allowed: boolean): Promise<void> {
    const request = object(params.request);
    const url = String(request.url);
    const method = String(request.method);
    // This is a tiny capability-scoped transport, never a general HTTP proxy.
    if (
      !allowed ||
      !/^http:\/\/127\.0\.0\.1:\d+\/view\/[0-9a-f]{64}(?:\/(?:state|action))?$/.test(url) ||
      !['GET', 'POST'].includes(method) ||
      String(request.postData ?? '').length > 160 * 1024
    ) {
      await this.call(
        'Fetch.failRequest',
        { requestId: params.requestId, errorReason: 'BlockedByClient' },
        session,
      );
      return;
    }
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? String(request.postData ?? '') : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) {
      throw Error('Widget viewer response exceeds its limit');
    }
    await this.call(
      'Fetch.fulfillRequest',
      {
        requestId: params.requestId,
        responseCode: response.status,
        responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
        body: bytes.toString('base64'),
      },
      session,
    );
  }

  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.starting?.catch(() => {});
    // Reap the owned process group even when a renderer is stuck in user code.
    if (this.child?.pid) {
      try {
        if (process.platform === 'win32') {
          this.child.kill('SIGKILL');
        } else {
          process.kill(-this.child.pid, 'SIGKILL');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
      await this.closed;
    }
    if (this.profile) {
      await rm(this.profile, { recursive: true, force: true });
    }
  }
}

export class BrowserPage {
  constructor(
    private readonly browser: Chromium,
    readonly targetId: string,
    private readonly sessionId: string,
    private readonly detach: () => void,
  ) {}

  call(method: string, params: JsonObject = {}, timeout?: number): Promise<JsonObject> {
    return this.browser.call(method, params, this.sessionId, timeout);
  }

  async evaluate(expression: string, timeout = 3000): Promise<unknown> {
    const reply = await this.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeout,
    );
    if (reply.exceptionDetails) {
      throw Error('Widget code failed to finish successfully');
    }
    return object(reply.result).value;
  }

  async document(html: string): Promise<void> {
    const tree = object((await this.call('Page.getFrameTree')).frameTree);
    await this.call('Page.setDocumentContent', { frameId: object(tree.frame).id, html });
  }

  async close(): Promise<void> {
    this.detach();
    await this.browser.call('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
