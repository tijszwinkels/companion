import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson, WidgetRegistry } from './registry.ts';
import { WidgetRenderer } from './renderer.ts';
import { defaultViewport, widgetDocument } from './document.ts';
import {
  attachment,
  boundedJson,
  defaultPresentation,
  object,
  presentation,
  type JsonObject,
  type WidgetAttachment,
  type WidgetBundle,
  type WidgetLease,
  type WidgetRecord,
  type WidgetViewport,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
interface Lease {
  owner: string;
  scope: string;
  signal: AbortSignal;
  release(): void;
}

/**
 * Owns widget state, versioned bundles and the private browser transport. Agent
 * leases last one turn; UI capabilities last one open conversation. Neither
 * capability permits file access, commands, arbitrary URLs or other sessions.
 */
export class WidgetService {
  private readonly registry: WidgetRegistry;
  private readonly records = new Map<string, WidgetRecord>();
  private readonly loaded = new Map<string, Promise<void>>();
  private readonly bundles = new Map<string, WidgetBundle>();
  private readonly leases = new Map<string, Lease>();
  private readonly capabilities = new Map<string, string>();
  private readonly widgetCapabilities = new Map<string, string>();
  private readonly owners = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly queued = new Map<string, number>();
  private readonly frames = new Map<string, Promise<Buffer>>();
  private server?: Server;
  private starting?: Promise<string>;
  private origin = '';
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly changed: (record: WidgetRecord, attachment: WidgetAttachment) => Promise<void>,
    library?: string,
    private readonly renderer = new WidgetRenderer(),
    private readonly validateChanges: (records: WidgetRecord[]) => () => void = () => () => {},
  ) {
    this.registry = new WidgetRegistry(join(directory, 'bundles'), library);
  }

  private start(): Promise<string> {
    if (this.closed) {
      return Promise.reject(Error('Widget service is closed'));
    }
    this.starting ??= new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        void this.receive(request, response).catch((error) => {
          if (!response.headersSent) {
            this.json(
              response,
              { error: error instanceof Error ? error.message : 'Widget request failed' },
              400,
            );
          } else {
            response.destroy();
          }
        });
      });
      this.server.once('error', reject);
      this.server.unref();
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') {
          reject(Error('Widget service failed to bind'));
          return;
        }
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve(this.origin);
      });
    });
    return this.starting;
  }

  async lease(owner: string, signal: AbortSignal): Promise<WidgetLease> {
    if (!uuid.test(owner)) {
      throw Error('Invalid widget owner');
    }
    signal.throwIfAborted();
    const origin = await this.start();
    await this.loadOwner(owner);
    signal.throwIfAborted();
    this.owners.add(owner);
    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    const release = () => {
      this.leases.delete(token);
      controller.abort();
      signal.removeEventListener('abort', release);
    };
    this.leases.set(token, {
      owner,
      scope: randomUUID(),
      signal: AbortSignal.any([signal, controller.signal]),
      release,
    });
    signal.addEventListener('abort', release, { once: true });
    return { endpoint: origin + '/agent', token, release };
  }

  private async reference(record: WidgetRecord): Promise<WidgetAttachment> {
    const origin = await this.start();
    let capability = this.widgetCapabilities.get(record.id);
    if (!capability) {
      capability = randomBytes(32).toString('hex');
      this.capabilities.set(capability, record.id);
      this.widgetCapabilities.set(record.id, capability);
    }
    return { ...attachment(record), viewUrl: origin + '/view/' + capability };
  }

  async restore(owner: string, value: unknown): Promise<WidgetAttachment> {
    const reference = attachment(value);
    const record = await this.record(reference.id, owner);
    this.owners.add(owner);
    return this.reference(record);
  }

  async deactivate(owner: string): Promise<void> {
    this.owners.delete(owner);
    await this.queues.get(owner)?.catch(() => {});
    for (const [token, lease] of this.leases) {
      if (lease.owner === owner) {
        lease.release();
      }
    }
    const ids: string[] = [];
    for (const record of this.records.values()) {
      if (record.owner === owner) {
        ids.push(record.id);
        const capability = this.widgetCapabilities.get(record.id);
        if (capability) {
          this.capabilities.delete(capability);
          this.widgetCapabilities.delete(record.id);
        }
      }
    }
    await Promise.allSettled(ids.map((id) => this.frames.get(id)));
    await this.renderer.discard(ids);
    for (const id of ids) {
      this.records.delete(id);
    }
    this.loaded.delete(owner);
    const usedBundles = new Set([...this.records.values()].map((record) => record.bundle));
    for (const hash of this.bundles.keys()) {
      if (!usedBundles.has(hash)) {
        this.bundles.delete(hash);
      }
    }
  }

  async restored(owner: string): Promise<{ record: WidgetRecord; reference: WidgetAttachment }[]> {
    await this.loadOwner(owner);
    this.owners.add(owner);
    return Promise.all(
      [...this.records.values()]
        .filter((record) => record.owner === owner)
        .map(async (record) => ({
          record: structuredClone(record),
          reference: await this.reference(record),
        })),
    );
  }

  private loadOwner(owner: string): Promise<void> {
    if (!uuid.test(owner)) {
      return Promise.reject(Error('Invalid widget owner'));
    }
    let pending = this.loaded.get(owner);
    if (!pending) {
      pending = this.readOwner(owner);
      this.loaded.set(owner, pending);
      void pending.catch(() => this.loaded.delete(owner));
    }
    return pending;
  }

  private async readOwner(owner: string): Promise<void> {
    let encoded: string;
    try {
      encoded = await readFile(join(this.directory, owner + '.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const values: unknown = JSON.parse(encoded);
    if (!Array.isArray(values) || values.length > 24) {
      throw Error('Invalid saved widgets');
    }
    const restored = [];
    for (const value of values) {
      const input = object(value);
      const reference = attachment(input);
      if (
        input.owner !== owner ||
        typeof input.bundle !== 'string' ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 4000 ||
        !Array.isArray(input.receipts) ||
        input.receipts.length > 64
      ) {
        throw Error('Invalid saved widget');
      }
      const receipts = input.receipts.map((value) => {
        const entry = object(value);
        if (typeof entry.id !== 'string' || entry.id.length > 200) {
          throw Error('Invalid saved widget receipt');
        }
        const result = object(entry.result);
        boundedJson(result);
        return { id: entry.id, result };
      });
      boundedJson(receipts, 64 * 1024);
      const bundle = await this.registry.retained(input.bundle);
      if (bundle.manifest.name !== reference.name) {
        throw Error('Widget bundle does not match its state');
      }
      restored.push({
        ...reference,
        owner,
        bundle: input.bundle,
        text: input.text,
        props: this.registry.validate(bundle.manifest.parameters, input.props),
        receipts,
      });
      this.bundles.set(bundle.hash, bundle);
    }
    if (
      new Set(restored.map((record) => record.id)).size !== restored.length ||
      restored.filter((record) => record.presentation.placement === 'pinned').length > 1
    ) {
      throw Error('Invalid saved widget identities or pinning');
    }
    for (const record of restored) {
      this.records.set(record.id, record);
    }
  }

  private async record(id: string, owner?: string): Promise<WidgetRecord> {
    if (!uuid.test(id)) {
      throw Error('Invalid widget id');
    }
    if (owner !== undefined) {
      await this.loadOwner(owner);
    }
    const record = this.records.get(id);
    if (!record || (owner !== undefined && record.owner !== owner)) {
      throw Error('Widget is unavailable in this conversation');
    }
    return record;
  }

  private async bundle(record: WidgetRecord): Promise<WidgetBundle> {
    const bundle = this.bundles.get(record.bundle) ?? (await this.registry.retained(record.bundle));
    this.bundles.set(bundle.hash, bundle);
    return bundle;
  }

  private async serialized<T>(owner: string, task: () => Promise<T>): Promise<T> {
    const count = this.queued.get(owner) ?? 0;
    if (count >= 16) {
      throw Error('Too many pending widget operations');
    }
    this.queued.set(owner, count + 1);
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    this.queues.set(owner, result);
    try {
      return await result;
    } finally {
      const remaining = (this.queued.get(owner) ?? 1) - 1;
      if (remaining > 0) {
        this.queued.set(owner, remaining);
      } else {
        this.queued.delete(owner);
      }
      if (this.queues.get(owner) === result) {
        this.queues.delete(owner);
      }
    }
  }

  private check(owner: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed || !this.owners.has(owner)) {
      throw Error('Widget conversation is closed');
    }
  }

  private async commit(record: WidgetRecord, signal?: AbortSignal): Promise<void> {
    const changed = [record];
    if (record.presentation.placement === 'pinned') {
      for (const other of this.records.values()) {
        if (
          other.owner === record.owner &&
          other.id !== record.id &&
          other.presentation.placement === 'pinned'
        ) {
          changed.push({
            ...other,
            revision: other.revision + 1,
            presentation: { ...other.presentation, placement: 'inline' },
          });
        }
      }
    }
    const transaction = new Map(
      [...this.records.values()]
        .filter((entry) => entry.owner === record.owner)
        .map((entry) => [entry.id, entry]),
    );
    for (const entry of changed) {
      transaction.set(entry.id, entry);
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = this.validateChanges(changed);
    try {
      this.check(record.owner, signal);
      // One atomic owner snapshot commits both the new pin and the old unpin.
      // Cancellation before this write changes nothing; after it we publish
      // the committed transaction even if the originating turn just stopped.
      await atomicJson(join(this.directory, record.owner + '.json'), [...transaction.values()]);
      for (const entry of changed) {
        this.records.set(entry.id, entry);
      }
      // Allocate capabilities only for durable records. Validation, cancellation
      // and failed writes must not leave references for unpublished widgets.
      // A later transcript failure retains these committed records and views.
      const references = await Promise.all(changed.map((entry) => this.reference(entry)));
      const publications = await Promise.allSettled(
        changed.map((entry, index) => this.changed(entry, references[index])),
      );
      for (const publication of publications) {
        if (publication.status === 'rejected') {
          throw publication.reason;
        }
      }
    } finally {
      release();
    }
  }

  private async command(
    owner: string,
    command: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.check(owner, signal);
    const method = command.method;
    if (method === 'discover') {
      if (command.id) {
        const record = await this.record(String(command.id), owner);
        return {
          id: record.id,
          revision: record.revision,
          props: record.props,
          presentation: record.presentation,
          manifest: (await this.bundle(record)).manifest,
        };
      }
      return this.registry.discover(
        String(command.query ?? '').slice(0, 100),
        typeof command.name === 'string' ? command.name : undefined,
      );
    }
    if (
      typeof command.requestId !== 'string' ||
      !command.requestId ||
      command.requestId.length > 200
    ) {
      throw Error('Widget mutations require a request id');
    }
    return this.serialized(owner, async () => {
      this.check(owner, signal);
      if (method === 'publish') {
        // A retry of a completed publication resolves to the same instance.
        const digest = createHash('sha256')
          .update(owner + ':' + command.requestId)
          .digest('hex');
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const existing = this.records.get(id);
        if (existing) {
          return { id, revision: existing.revision };
        }
        if ([...this.records.values()].filter((record) => record.owner === owner).length >= 24) {
          throw Error('A conversation may contain at most 24 widgets');
        }
        const bundle = await this.registry.load(String(command.widget));
        const props = this.registry.validate(bundle.manifest.parameters, command.props);
        const record: WidgetRecord = {
          id,
          owner,
          bundle: bundle.hash,
          name: bundle.manifest.name,
          props,
          revision: 1,
          text: '',
          presentation: presentation(command.presentation ?? defaultPresentation),
          receipts: [],
        };
        record.text = await this.renderer.describe(record, bundle);
        await this.registry.retain(bundle);
        this.bundles.set(bundle.hash, bundle);
        await this.commit(record, signal);
        return { id, revision: 1, text: record.text };
      }
      const current = await this.record(String(command.id), owner);
      const prior = current.receipts.find((entry) => entry.id === command.requestId);
      if (prior) {
        return prior.result;
      }
      if (command.revision !== undefined && command.revision !== current.revision) {
        throw Error(
          `Widget changed; expected revision ${current.revision}. Inspect it before retrying.`,
        );
      }
      const bundle = await this.bundle(current);
      const record: WidgetRecord = structuredClone(current);
      let result: JsonObject = {};
      if (method === 'update') {
        if (command.revision === undefined) {
          throw Error('Replacing widget properties requires the current revision');
        }
        record.props = this.registry.validate(bundle.manifest.parameters, command.props);
      } else if (method === 'call') {
        const action = String(command.action);
        if (!Object.hasOwn(bundle.manifest.actions, action)) {
          throw Error('Widget does not expose that action');
        }
        const args = this.registry.validate(
          bundle.manifest.actions[action].parameters,
          command.args ?? {},
        );
        const reduced = await this.renderer.reduce(
          current,
          bundle,
          action,
          args,
          String(command.requestId),
        );
        record.props = this.registry.validate(bundle.manifest.parameters, reduced.props);
        result = this.registry.validate(bundle.manifest.actions[action].returns, reduced.result);
        boundedJson(result, 16 * 1024);
      } else if (method === 'present') {
        record.presentation = presentation(command.presentation);
      } else {
        throw Error('Unknown widget method');
      }
      // Moving a widget must remain possible when its browser is unavailable.
      // Only property changes require a newly generated text description.
      if (method !== 'present') {
        record.text = await this.renderer.describe(record, bundle);
      }
      record.revision++;
      result = { ...result, id: record.id, revision: record.revision };
      record.receipts = [...record.receipts, { id: String(command.requestId), result }].slice(-64);
      while (Buffer.byteLength(JSON.stringify(record.receipts), 'utf8') > 64 * 1024) {
        record.receipts.shift();
      }
      await this.commit(record, signal);
      return result;
    });
  }

  private json(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(boundedJson(value, 256 * 1024));
  }

  private async body(request: IncomingMessage): Promise<JsonObject> {
    if (
      request.method !== 'POST' ||
      request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
    ) {
      throw Error('Expected a JSON POST request');
    }
    let content = '';
    let bytes = 0;
    request.setEncoding('utf8');
    for await (const part of request) {
      content += part.toString();
      bytes += Buffer.byteLength(part.toString(), 'utf8');
      if (bytes > 160 * 1024) {
        throw Error('Widget request exceeds its size limit');
      }
    }
    return object(JSON.parse(content));
  }

  private viewport(url: URL): WidgetViewport {
    const result = { ...defaultViewport };
    for (const key of ['width', 'height', 'scale'] as const) {
      if (url.searchParams.has(key)) {
        result[key] = Number(url.searchParams.get(key));
      }
    }
    if (
      !Number.isInteger(result.width) ||
      result.width < 80 ||
      result.width > 1600 ||
      !Number.isInteger(result.height) ||
      result.height < 60 ||
      result.height > 2200 ||
      !Number.isFinite(result.scale) ||
      result.scale < 0.5 ||
      result.scale > 3
    ) {
      throw Error('Invalid widget viewport');
    }
    for (const key of ['foreground', 'background', 'accent', 'muted'] as const) {
      const color = url.searchParams.get(key);
      if (color !== null) {
        if (!/^#[0-9a-f]{6}$/i.test(color)) {
          throw Error('Invalid widget theme color');
        }
        result[key] = color;
      }
    }
    return result;
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      this.closed ||
      request.headers.host !== this.origin.slice(7) ||
      (request.headers.origin && request.headers.origin !== this.origin)
    ) {
      this.json(response, { error: 'Widget origin rejected' }, 403);
      return;
    }
    const url = new URL(request.url ?? '', this.origin);
    if (url.pathname === '/agent') {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const lease = token ? this.leases.get(token) : undefined;
      if (!lease) {
        this.json(response, { error: 'Agent widget lease expired' }, 403);
        return;
      }
      const command = await this.body(request);
      this.check(lease.owner, lease.signal);
      if (command.requestId) {
        command.requestId = lease.scope + ':' + String(command.requestId);
      }
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) {
          controller.abort();
        }
      });
      this.json(
        response,
        await this.command(
          lease.owner,
          command,
          AbortSignal.any([lease.signal, controller.signal]),
        ),
      );
      return;
    }
    const match =
      /^\/view\/([0-9a-f]{64})(?:\/(state|action|frame|layout|input|present|popout))?$/.exec(
        url.pathname,
      );
    const id = match ? this.capabilities.get(match[1]) : undefined;
    if (!match || !id) {
      this.json(response, { error: 'Unknown widget view' }, 404);
      return;
    }
    const record = await this.record(id);
    this.check(record.owner);
    const bundle = await this.bundle(record);
    this.check(record.owner);
    const viewUrl = this.origin + '/view/' + match[1];
    const action = match[2];
    if (request.method === 'GET' && !action) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      });
      response.end(await widgetDocument(bundle, record, defaultViewport, viewUrl));
    } else if (request.method === 'GET' && action === 'state') {
      this.json(response, {
        revision: record.revision,
        props: record.props,
        presentation: record.presentation,
      });
    } else if (request.method === 'GET' && action === 'layout') {
      this.json(response, {
        height: await this.renderer.layout(record, bundle, this.viewport(url)),
      });
    } else if (request.method === 'GET' && action === 'frame') {
      let pending = this.frames.get(id);
      if (!pending) {
        pending = this.frame(record, bundle, this.viewport(url));
        this.frames.set(id, pending);
        void pending.finally(() => this.frames.delete(id)).catch(() => {});
      }
      const frame = await pending;
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end(frame);
    } else {
      const body = await this.body(request);
      this.check(record.owner);
      if (action === 'action') {
        this.json(response, await this.command(record.owner, { ...body, method: 'call', id }));
      } else if (action === 'present') {
        this.json(response, await this.command(record.owner, { ...body, method: 'present', id }));
      } else if (action === 'input') {
        this.json(response, { result: await this.renderer.input(record, bundle, body) });
      } else if (action === 'popout') {
        // Register accepted work before the renderer can await browser startup.
        // Deactivation revokes admission, drains this owner queue, then discards
        // its browsers. Repeated requests cannot replace each other mid-startup.
        await this.serialized(record.owner, async () => {
          const validate = () => {
            this.check(record.owner);
            if (this.capabilities.get(match[1]) !== id) {
              throw Error('Widget view expired');
            }
          };
          validate();
          await this.renderer.popout(id, viewUrl, validate);
          validate();
        });
        this.json(response, { opened: true });
      } else {
        throw Error('Unknown widget operation');
      }
    }
  }

  private async frame(
    record: WidgetRecord,
    bundle: WidgetBundle,
    viewport: WidgetViewport,
  ): Promise<Buffer> {
    for (const request of await this.renderer.requests(record, bundle)) {
      try {
        const result = await this.command(record.owner, {
          ...request,
          method: 'call',
          id: record.id,
        });
        await this.renderer.reply(record, bundle, String(request.id), result);
      } catch (error) {
        await this.renderer.reply(
          record,
          bundle,
          String(request.id),
          null,
          error instanceof Error ? error.message : 'Widget action failed',
        );
      }
    }
    return this.renderer.frame(await this.record(record.id), bundle, viewport);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => {});
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.capabilities.clear();
    this.owners.clear();
    await Promise.allSettled(this.queues.values());
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await this.renderer.close();
  }
}
