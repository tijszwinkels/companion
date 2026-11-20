/**
 * Session applications: one authored application per conversation.
 *
 * Owned by WidgetService, which supplies its registry (guarded library loader,
 * schema validation, retained bundles), its isolated renderer (the only place
 * authored JavaScript runs), its loopback origin and its per-conversation
 * operation queue. This class adds:
 *
 * - the durable application record (record.ts) with state, receipts and the
 *   user-edit outbox (outbox.ts), committed in one atomic write;
 * - host-controlled code apply with version checks and compatibility checks;
 * - typed queries (read-only) and actions (mutations) shared by the view and
 *   the conversation's agent, with origin taken from the ingress only;
 * - the view capability (same `/view/<64 hex>` shape as widget views);
 * - delivery bookkeeping that AgentSessions drives when event turns start
 *   and finish.
 *
 * Inputs: view actions (user-edit origin), explicitly granted chat sends
 * (application-message origin), and agent lease commands (agent origin).
 * Outputs: committed records, descriptor changes and user-edit notifications
 * through `ApplicationHooks`. It never starts a model turn itself.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson, type WidgetRegistry } from '../widgets/registry.ts';
import type { WidgetRenderer } from '../widgets/renderer.ts';
import { defaultViewport, widgetDocument } from '../widgets/document.ts';
import {
  boundedJson,
  defaultPresentation,
  object,
  type JsonObject,
  type WidgetAction,
  type WidgetBundle,
  type WidgetRecord,
} from '../widgets/types.ts';
import { parseApplicationRecord, type ApplicationRecord } from './record.ts';
import {
  acknowledgeFailures,
  batchSummary,
  beginDelivery,
  checkEventCapacity,
  eventPrompt,
  eventStatus,
  finishDelivery,
  hasPendingEdits,
  noteAdmissionFailure,
  recordUserEdit,
  recoverInterruptedDelivery,
} from './outbox.ts';
import { SessionApplicationError } from './errors.ts';
import { applicationChatLimits, type ApplicationChatResponse } from './chat.ts';
import {
  ApplicationSending,
  applicationSendLimits,
  type ApplicationSendReceipt,
  type ApplicationSendWithdrawal,
} from './sending.ts';
import { applicationMessageOrigin } from '../agents/application-message-origin.ts';
import type { ApplicationMessageOrigin } from '../agents/types.ts';
import {
  sessionApplicationEventModes,
  sessionApplicationLimits,
  type SessionApplicationDescriptor,
  type SessionApplicationChatAccess,
  type SessionApplicationEventMode,
  type SessionApplicationStateResponse,
} from './types.ts';

/** What WidgetService lends this class. */
export interface ApplicationHost {
  registry: WidgetRegistry;
  renderer: WidgetRenderer;
  /** Starts the loopback server if needed and returns `http://127.0.0.1:<port>`. */
  origin(): Promise<string>;
  /** Runs `task` in the conversation's operation queue (shared with widgets). */
  serialized<T>(owner: string, task: () => Promise<T>): Promise<T>;
  /** Throws when the conversation is closed or `signal` is aborted. */
  check(owner: string, signal?: AbortSignal): void;
}

/** Notifications to the session layer. */
export interface ApplicationHooks {
  /** The descriptor changed (apply, state change, event status) or went away. */
  changed(owner: string, descriptor: SessionApplicationDescriptor | undefined): void;
  /** A user edit was committed with an event; the session may schedule delivery. */
  userEdit(owner: string, eventMode: SessionApplicationEventMode): void;
  /** Synchronous bounded projection, invoked only after a current read grant check. */
  readChat?(owner: string, after?: string): ApplicationChatResponse;
  /** Synchronous normal FIFO admission; may throw with an uncertain outcome. */
  sendChat?(owner: string, text: string, origin: ApplicationMessageOrigin): { messageId: string };
  /** Remove only never-started app messages bearing these host receipt identities. */
  withdrawChat?(owner: string, receipts: ApplicationSendReceipt[]): void;
}

/**
 * The application identity and exposed operations captured when an agent
 * turn's lease is issued. Execution through that lease is limited to exactly
 * this code version and these names (the safe-turn-boundary rule).
 */
export interface FrozenApplication {
  id: string;
  version: number;
  queries: ReadonlySet<string>;
  actions: ReadonlySet<string>;
}

/** Who made a request. Determined by the ingress route, never by its body. */
type Origin = { kind: 'user' } | { kind: 'agent'; frozen: FrozenApplication | undefined };

/** In-memory state for one open conversation. */
interface Entry {
  record?: ApplicationRecord;
  bundle?: WidgetBundle;
  /** Restoration failure; the saved file is left untouched. */
  error?: string;
  capability?: string;
  /** Live overlay: an event turn for the pending batch is queued. */
  queued: boolean;
  /**
   * Live overlay: a delivery start or outcome could not be saved. Shown as
   * the event status failure and cleared by the next successful write. Kept
   * in memory because the write that would have saved it is the one that
   * failed.
   */
  deliveryProblem?: string;
  /** Retained across code replacement so an old running send still occupies its slot. */
  sending?: ApplicationSending;
  /** Ephemeral, bound to exact code and this open entry, never serialized. */
  chat?: {
    applicationId: string;
    bundle: string;
    version: number;
    revision: string;
    read: boolean;
    lastReadAt?: number;
  };
}

/** View request results; WidgetService writes the HTTP response. */
export type ApplicationViewResult =
  { kind: 'document'; html: string } | { kind: 'json'; value: unknown };

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function exposed(operations: Record<string, WidgetAction> | undefined): string[] {
  return Object.entries(operations ?? {})
    .filter(([, operation]) => operation.agent !== false)
    .map(([name]) => name);
}

/** Agent-facing declarations (description and schemas) of exposed operations. */
function agentOperations(operations: Record<string, WidgetAction> | undefined): JsonObject {
  const result: JsonObject = {};
  for (const [name, operation] of Object.entries(operations ?? {})) {
    if (operation.agent === false) {
      continue;
    }
    result[name] = {
      description: operation.description,
      parameters: operation.parameters,
      returns: operation.returns,
    };
  }
  return result;
}

/** Entry points and declared handlers that the bundle's module does not export. */
function missingHandlers(
  manifest: WidgetBundle['manifest'],
  exports: { mount: boolean; describe: boolean; actions: string[]; queries: string[] },
): string[] {
  const missing: string[] = [];
  if (!exports.mount) {
    missing.push('mount');
  }
  if (!exports.describe) {
    missing.push('describe');
  }
  for (const name of Object.keys(manifest.actions)) {
    if (!exports.actions.includes(name)) {
      missing.push(name);
    }
  }
  for (const name of Object.keys(manifest.queries ?? {})) {
    if (!exports.queries.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** The page's own error line when authored code threw, else the error text. */
function authoredReason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'string' && cause) {
    return cause;
  }
  return errorText(error);
}

/**
 * Run authored code in the renderer. A refusal thrown by the application's
 * own handler (for example "Task was not found") is reported with its bounded
 * message; it is the application's text, shown to the user or agent as such.
 */
async function authored<T>(task: Promise<T>): Promise<T> {
  try {
    return await task;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (typeof cause === 'string' && cause) {
      throw new SessionApplicationError(`Application refused: ${cause}`);
    }
    throw error;
  }
}

export class SessionApplications {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();
  private readonly capabilities = new Map<string, string>();
  private readonly directory: string;

  constructor(
    widgetDirectory: string,
    private readonly host: ApplicationHost,
    private readonly hooks: ApplicationHooks,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = join(widgetDirectory, 'applications');
  }

  // ---- Loading and lifetime ------------------------------------------------

  private file(owner: string): string {
    return join(this.directory, owner + '.json');
  }

  /** Load once per open conversation. Never throws: failures become `error`. */
  load(owner: string): Promise<Entry> {
    const existing = this.entries.get(owner);
    if (existing) {
      return Promise.resolve(existing);
    }
    let pending = this.loading.get(owner);
    if (!pending) {
      pending = this.read(owner).then((entry) => {
        this.entries.set(owner, entry);
        this.loading.delete(owner);
        return entry;
      });
      this.loading.set(owner, pending);
    }
    return pending;
  }

  private async read(owner: string): Promise<Entry> {
    let encoded: string;
    try {
      encoded = await readFile(this.file(owner), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { queued: false };
      }
      return { queued: false, error: `Could not read the saved application: ${errorText(error)}` };
    }

    let record: ApplicationRecord;
    try {
      record = parseApplicationRecord(JSON.parse(encoded), owner);
    } catch (error) {
      return { queued: false, error: `The saved application is invalid: ${errorText(error)}` };
    }

    // A record that parses keeps its identity in the descriptor even if its
    // code or state cannot be used, so the UI can say which app is broken.
    try {
      const bundle = await this.host.registry.retained(record.bundle);
      if (bundle.manifest.name !== record.name || !bundle.manifest.application) {
        throw Error('The retained bundle does not match the application');
      }
      record.data = this.host.registry.validate(bundle.manifest.parameters, record.data);
      recoverInterruptedDelivery(record, this.now());
      return { record, bundle, queued: false };
    } catch (error) {
      return {
        record,
        queued: false,
        error: `The saved application could not be restored: ${errorText(error)}`,
      };
    }
  }

  /** Revoke the view capability and forget in-memory state (conversation closed). */
  async unload(owner: string): Promise<void> {
    await this.loading.get(owner)?.catch(() => {});
    const entry = this.entries.get(owner);
    this.entries.delete(owner);
    if (!entry) {
      return;
    }
    const withdrawn = entry.sending?.revoke('closed') ?? [];
    this.hooks.withdrawChat?.(owner, withdrawn);
    if (entry.capability) {
      this.capabilities.delete(entry.capability);
    }
    if (entry.record) {
      await this.host.renderer.discard([this.surfaceId(entry.record)]);
    }
  }

  close(): void {
    for (const [owner, entry] of this.entries) {
      const withdrawn = entry.sending?.revoke('closed') ?? [];
      this.hooks.withdrawChat?.(owner, withdrawn);
    }
    this.capabilities.clear();
    this.entries.clear();
  }

  // ---- Descriptor ----------------------------------------------------------

  /** The descriptor for snapshots, or undefined when there is no application. */
  async descriptor(owner: string): Promise<SessionApplicationDescriptor | undefined> {
    const entry = await this.load(owner);
    const record = entry.record;
    if (!record && !entry.error) {
      return undefined;
    }
    if (!record || entry.error) {
      return {
        id: record?.id ?? '',
        name: record?.name ?? '',
        version: record?.version ?? 0,
        revision: record?.revision ?? 0,
        text: record?.text ?? 'The saved application could not be restored.',
        eventMode: record?.eventMode ?? 'immediate',
        error: entry.error ?? 'The saved application is unavailable.',
      };
    }

    const origin = await this.host.origin();
    if (!entry.capability) {
      entry.capability = randomBytes(32).toString('hex');
      this.capabilities.set(entry.capability, owner);
    }
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      revision: record.revision,
      viewUrl: origin + '/view/' + entry.capability,
      text: record.text,
      eventMode: record.eventMode,
      eventStatus: this.eventStatus(entry, record),
      chatAccess: this.chatAccess(entry, record),
    };
  }

  private eventStatus(entry: Entry, record: ApplicationRecord) {
    const status = eventStatus(record, entry.queued);
    if (entry.deliveryProblem) {
      status.failure = entry.deliveryProblem;
    }
    return status;
  }

  /** The conversation that owns a view capability, if it is an application view. */
  ownerOf(capability: string): string | undefined {
    return this.capabilities.get(capability);
  }

  private async publish(owner: string): Promise<void> {
    this.hooks.changed(owner, await this.descriptor(owner));
  }

  // ---- Trusted permission controls (desktop and paired devices) -----------

  /**
   * A successful replacement creates a fresh, denied permission identity even
   * when the replacement declares exactly the same capability names. State-only
   * commits keep the identity. Reopen creates a new Entry, so old confirmations
   * cannot grant access after close/reopen or listener restart.
   */
  private chatGrant(entry: Entry, record: ApplicationRecord): NonNullable<Entry['chat']> {
    if (
      !entry.chat ||
      entry.chat.applicationId !== record.id ||
      entry.chat.bundle !== record.bundle ||
      entry.chat.version !== record.version
    ) {
      const identity = {
        applicationId: record.id,
        name: record.name,
        version: record.version,
        bundle: record.bundle,
      };
      if (entry.sending) {
        const withdrawn = entry.sending.replace(identity);
        this.hooks.withdrawChat?.(record.owner, withdrawn);
      } else {
        entry.sending = new ApplicationSending(identity);
      }
      entry.chat = {
        applicationId: record.id,
        bundle: record.bundle,
        version: record.version,
        revision: randomUUID(),
        read: false,
      };
    }
    return entry.chat;
  }

  private chatAccess(entry: Entry, record: ApplicationRecord): SessionApplicationChatAccess {
    const grant = this.chatGrant(entry, record);
    return {
      requested: [...(entry.bundle?.manifest.application?.capabilities ?? [])],
      read: grant.read,
      send: entry.sending!.access(),
      revision: grant.revision,
    };
  }

  /**
   * Trusted UI ingress ONLY. Deliberately not dispatched by agent() or
   * view(), and not an application action. The desktop transport must require
   * a currently shown conversation: on the desktop, or on a paired device
   * under its stricter rule for allowing (src/desktop/runtime.ts,
   * `checkRemotePermissionChange`). `validateShown` repeats that check.
   */
  setChatRead(owner: string, command: JsonObject, validateShown?: () => void) {
    return this.setChatPermission(owner, command, 'chat.read', validateShown);
  }

  setChatSend(owner: string, command: JsonObject, validateShown?: () => void) {
    return this.setChatPermission(owner, command, 'chat.send', validateShown);
  }

  private async setChatPermission(
    owner: string,
    command: JsonObject,
    capability: 'chat.read' | 'chat.send',
    validateShown?: () => void,
  ): Promise<SessionApplicationChatAccess> {
    if (
      Object.keys(command).some(
        (key) => !['applicationId', 'version', 'revision', 'allowed'].includes(key),
      ) ||
      typeof command.applicationId !== 'string' ||
      typeof command.revision !== 'string' ||
      !Number.isSafeInteger(command.version) ||
      typeof command.allowed !== 'boolean'
    ) {
      throw new SessionApplicationError(
        'Expected an application, version, permission revision and allowed flag',
      );
    }

    return this.host.serialized(owner, async () => {
      this.host.check(owner);
      const { record, bundle } = this.current(owner);
      const entry = this.entries.get(owner)!;
      const grant = this.chatGrant(entry, record);
      // A queue wait must not outlive the trusted view that confirmed consent.
      validateShown?.();
      if (
        command.applicationId !== record.id ||
        command.version !== record.version ||
        command.revision !== grant.revision
      ) {
        throw new SessionApplicationError(
          'Application or permissions changed; review the current permission controls.',
          409,
        );
      }
      if (command.allowed && !bundle.manifest.application?.capabilities?.includes(capability)) {
        throw new SessionApplicationError(`This application does not request ${capability}`, 403);
      }
      if (capability === 'chat.send') {
        if (command.allowed && !this.hooks.sendChat) {
          throw new SessionApplicationError('Application sending is unavailable', 503);
        }
        const withdrawn = command.allowed
          ? entry.sending!.permit()
          : entry.sending!.revoke('revoked');
        grant.revision = randomUUID();
        this.hooks.withdrawChat?.(owner, withdrawn);
        await this.publish(owner);
      } else if (grant.read !== command.allowed) {
        grant.read = command.allowed === true;
        grant.revision = randomUUID();
        delete grant.lastReadAt;
        await this.publish(owner);
      }
      return this.chatAccess(entry, record);
    });
  }

  /** Synchronous withdrawal before Stop can wait on a turn or the application queue. */
  revokeChatSend(owner: string, reason: ApplicationSendWithdrawal = 'stopped'): void {
    const entry = this.entries.get(owner);
    if (!entry?.sending) return;
    const withdrawn = entry.sending.revoke(reason);
    if (entry.chat) entry.chat.revision = randomUUID();
    this.hooks.withdrawChat?.(owner, withdrawn);
    void this.publishSending(owner, entry).catch(() => {});
  }

  /** A turn captures this open entry/policy, never a later reopened successor. */
  chatSendTurn(owner: string, receiptId: string) {
    const entry = this.entries.get(owner);
    const sending = entry?.sending;
    let began = false;
    return {
      begin: () => {
        if (!entry || this.entries.get(owner) !== entry || !sending) return false;
        const admitted = sending.begin(receiptId);
        if (admitted) {
          began = true;
          void this.publishSending(owner, entry).catch(() => {});
        }
        return admitted;
      },
      finish: async (state: 'completed' | 'failed' | 'cancelled') => {
        if (!entry || !sending) return;
        const changed = began
          ? sending.finish(receiptId, state)
          : sending.cancelUnstarted(receiptId);
        if (changed) await this.publishSending(owner, entry);
      },
    };
  }

  cancelChatSend(owner: string, receiptId: string): void {
    const entry = this.entries.get(owner);
    if (entry?.sending?.cancelUnstarted(receiptId)) {
      void this.publishSending(owner, entry).catch(() => {});
    }
  }

  private publishSending(owner: string, entry: Entry): Promise<void> {
    return this.host.serialized(owner, async () => {
      if (this.entries.get(owner) !== entry) return;
      this.host.check(owner);
      await this.publish(owner);
    });
  }

  // ---- Agent lease ---------------------------------------------------------

  /** Capture the callable version and names when a turn's lease is issued. */
  async freeze(owner: string): Promise<FrozenApplication | undefined> {
    const entry = await this.load(owner);
    if (!entry.record || !entry.bundle || entry.error) {
      return undefined;
    }
    return {
      id: entry.record.id,
      version: entry.record.version,
      queries: new Set(exposed(entry.bundle.manifest.queries)),
      actions: new Set(exposed(entry.bundle.manifest.actions)),
    };
  }

  /** Agent tool commands (`app_*` methods) from a turn lease. */
  async agent(
    owner: string,
    frozen: FrozenApplication | undefined,
    command: JsonObject,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.host.check(owner, signal);
    await this.load(owner);
    const origin: Origin = { kind: 'agent', frozen };
    switch (command.method) {
      case 'app_inspect':
        return this.inspect(owner, frozen, command, signal);
      case 'app_apply':
        return this.apply(owner, command, signal);
      case 'app_query':
        return this.query(owner, origin, command, signal);
      case 'app_call':
        return this.call(owner, origin, command, signal);
      default:
        throw new SessionApplicationError('Unknown application method');
    }
  }

  // ---- View ingress (user edits or explicitly granted app-origin chat) ------

  /**
   * Requests to an application view capability. The service already checked
   * Host/Origin and that the conversation is open. `documentApi` replaces the
   * view address in the served document (the widget service's private socket
   * route, which must not reveal the capability); by default it is the
   * loopback view address.
   */
  async view(
    owner: string,
    capability: string,
    operation: string | undefined,
    method: string,
    body: () => Promise<JsonObject>,
    documentApi?: string,
  ): Promise<ApplicationViewResult> {
    const entry = await this.load(owner);
    const record = entry.record;
    const bundle = entry.bundle;
    if (!record || !bundle || entry.error || entry.capability !== capability) {
      throw new SessionApplicationError('Application view is unavailable', 404);
    }

    if (method === 'GET' && operation === undefined) {
      const viewUrl = (await this.host.origin()) + '/view/' + capability;
      const html = await widgetDocument(
        bundle,
        { props: record.data, revision: record.revision, name: record.name },
        defaultViewport,
        documentApi ?? viewUrl,
        { version: record.version },
      );
      return { kind: 'document', html };
    }
    if (method === 'GET' && operation === 'state') {
      const state: SessionApplicationStateResponse = {
        kind: 'application',
        version: record.version,
        revision: record.revision,
        data: record.data,
        props: record.data,
        textScale: null,
        chatReadAllowed: this.chatGrant(entry, record).read,
        chatSend: entry.sending!.access(),
      };
      return { kind: 'json', value: state };
    }
    if (method === 'POST' && operation === 'action') {
      return { kind: 'json', value: await this.call(owner, { kind: 'user' }, await body()) };
    }
    if (method === 'POST' && operation === 'query') {
      return { kind: 'json', value: await this.query(owner, { kind: 'user' }, await body()) };
    }
    if (method === 'POST' && operation === 'chat-read') {
      return { kind: 'json', value: await this.readChat(owner, capability, await body()) };
    }
    if (method === 'POST' && (operation === 'chat-send' || operation === 'chat-receipt')) {
      return {
        kind: 'json',
        value: await this.sendChat(owner, capability, await body(), operation === 'chat-receipt'),
      };
    }
    throw new SessionApplicationError('Unknown application view operation', 404);
  }

  private async readChat(
    owner: string,
    capability: string,
    command: JsonObject,
  ): Promise<ApplicationChatResponse> {
    if (
      Object.keys(command).some((key) => key !== 'version' && key !== 'after') ||
      !Number.isSafeInteger(command.version) ||
      (command.after !== undefined &&
        (typeof command.after !== 'string' || !/^[0-9a-f]{64}$/.test(command.after)))
    ) {
      throw new SessionApplicationError('Expected a code version and optional chat revision');
    }

    // Serialize with apply and trusted revocation. Check AGAIN after reading
    // the body and entering the queue: both may have awaited replacement,
    // revocation or close/reopen. Never retain a source transcript across await.
    return this.host.serialized(owner, async () => {
      this.host.check(owner);
      const { record, bundle } = this.current(owner);
      const entry = this.entries.get(owner)!;
      if (entry.capability !== capability || this.ownerOf(capability) !== owner) {
        throw new SessionApplicationError('Application view expired', 403);
      }
      if (command.version !== record.version) {
        throw new SessionApplicationError('Application code changed; reload the view.', 409);
      }
      const grant = this.chatGrant(entry, record);
      if (!grant.read || !bundle.manifest.application?.capabilities?.includes('chat.read')) {
        throw new SessionApplicationError(
          'Chat reading is not allowed. Use the trusted application permissions.',
          403,
        );
      }
      if (!this.hooks.readChat) {
        throw new SessionApplicationError('Conversation text is unavailable', 503);
      }
      const now = this.now();
      if (
        grant.lastReadAt !== undefined &&
        now - grant.lastReadAt < applicationChatLimits.readIntervalMilliseconds
      ) {
        throw new SessionApplicationError('Chat reads are too frequent', 429);
      }
      grant.lastReadAt = now;
      const result = this.hooks.readChat(owner, command.after as string | undefined);
      boundedJson(result, applicationChatLimits.responseBytes);
      return result;
    });
  }

  private async sendChat(
    owner: string,
    capability: string,
    command: JsonObject,
    lookup: boolean,
  ): Promise<unknown> {
    boundedJson(
      command,
      lookup ? applicationSendLimits.receiptRequestBytes : applicationSendLimits.requestBytes,
    );
    if (!Number.isSafeInteger(command.version)) {
      throw new SessionApplicationError('Expected a code version');
    }
    return this.host.serialized(owner, async () => {
      this.host.check(owner);
      const { record, bundle } = this.current(owner);
      const entry = this.entries.get(owner)!;
      if (entry.capability !== capability || this.ownerOf(capability) !== owner) {
        throw new SessionApplicationError('Application view expired', 403);
      }
      if (command.version !== record.version) {
        throw new SessionApplicationError('Application code changed; reload the view.', 409);
      }
      this.chatGrant(entry, record);
      if (!bundle.manifest.application?.capabilities?.includes('chat.send')) {
        throw new SessionApplicationError('This application does not request chat.send', 403);
      }
      const sending = entry.sending!;
      if (lookup) {
        if (
          Object.keys(command).some((key) => !['version', 'grantId', 'requestId'].includes(key)) ||
          typeof command.grantId !== 'string' ||
          !uuid.test(command.grantId) ||
          typeof command.requestId !== 'string' ||
          !/^[a-zA-Z0-9_-]{16,128}$/.test(command.requestId)
        ) {
          throw new SessionApplicationError('Expected current code, grant and request ID');
        }
        // Unknown is not proof that a request did not execute before restart/eviction.
        const result = { receipt: sending.receipt(command.grantId, command.requestId) ?? null };
        boundedJson(result, applicationSendLimits.responseBytes);
        return result;
      }
      if (!this.hooks.sendChat)
        throw new SessionApplicationError('Application sending is unavailable', 503);
      const reservation = sending.reserve(command);
      if (!reservation.duplicate) {
        try {
          const accepted = this.hooks.sendChat(
            owner,
            command.text as string,
            applicationMessageOrigin(reservation.receipt, reservation.receipt.receiptId),
          );
          sending.attach(reservation.receipt.receiptId, accepted.messageId);
        } catch {
          sending.unconfirmed(reservation.receipt.receiptId);
        }
        await this.publish(owner);
      }
      const result = {
        receipt: sending.receipt(command.grantId as string, command.requestId as string)!,
      };
      boundedJson(result, applicationSendLimits.responseBytes);
      return result;
    });
  }

  // ---- Operations ----------------------------------------------------------

  /**
   * Renderer surface key: one page per application, code version and exact
   * bundle. Including the bundle hash means a page proven for one candidate
   * can never answer for different code that later gets the same version.
   */
  private surfaceId(record: ApplicationRecord, version = record.version): string {
    return `application:${record.id}:${version}:${record.bundle}`;
  }

  /** A widget-shaped view of the record for the shared renderer. */
  private surface(record: ApplicationRecord, data = record.data, version = record.version) {
    const surface: WidgetRecord = {
      id: this.surfaceId(record, version),
      owner: record.owner,
      bundle: record.bundle,
      name: record.name,
      props: data,
      revision: record.revision,
      text: record.text,
      presentation: defaultPresentation,
      receipts: [],
    };
    return surface;
  }

  private current(owner: string): { record: ApplicationRecord; bundle: WidgetBundle } {
    const entry = this.entries.get(owner);
    if (entry?.error) {
      throw new SessionApplicationError(entry.error, 409);
    }
    if (!entry?.record || !entry.bundle) {
      throw new SessionApplicationError('This conversation has no application', 404);
    }
    return { record: entry.record, bundle: entry.bundle };
  }

  /**
   * Refuse execution through code other than the caller's. The view names the
   * version it loaded; an agent lease carries the version frozen at turn start.
   * A successor version is never accepted through an older lease.
   */
  private checkCallable(
    record: ApplicationRecord,
    bundle: WidgetBundle,
    origin: Origin,
    command: JsonObject,
    kind: 'query' | 'action',
    name: string,
  ): void {
    const operations = kind === 'query' ? bundle.manifest.queries : bundle.manifest.actions;
    if (origin.kind === 'user') {
      if (command.version !== record.version) {
        throw new SessionApplicationError(
          `Application code changed to version ${record.version}; reload the view.`,
          409,
        );
      }
      if (!operations || !Object.hasOwn(operations, name)) {
        throw new SessionApplicationError(`Application does not declare ${kind} ${name}`);
      }
      return;
    }

    const frozen = origin.frozen;
    if (!frozen) {
      throw new SessionApplicationError(
        'This conversation had no application when this turn started. Its queries and ' +
          'actions become available to your next turn.',
        409,
      );
    }
    if (frozen.id !== record.id || frozen.version !== record.version) {
      throw new SessionApplicationError(
        `The application code changed during this turn (version ${frozen.version} → ` +
          `${record.version}). Queries and actions of the new code become available to ` +
          `your next turn; this turn cannot call them.`,
        409,
      );
    }
    if (command.version !== undefined && command.version !== frozen.version) {
      throw new SessionApplicationError(
        `This turn may only call application version ${frozen.version}.`,
        409,
      );
    }
    const allowed = kind === 'query' ? frozen.queries : frozen.actions;
    if (!allowed.has(name)) {
      throw new SessionApplicationError(
        `The application does not expose ${kind} ${name} to the agent.`,
      );
    }
  }

  private async commit(
    owner: string,
    next: ApplicationRecord,
    bundle: WidgetBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    boundedJson(next.data, sessionApplicationLimits.stateBytes);
    next.updatedAt = this.now();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    // Cancellation observed before this write changes nothing. After the
    // write starts, the commit is published even if the turn stops.
    this.host.check(owner, signal);
    await atomicJson(this.file(owner), next);

    const entry = this.entries.get(owner);
    if (entry) {
      entry.record = next;
      entry.bundle = bundle;
      // Successful replacement withdraws unstarted sends BEFORE any further await.
      this.chatGrant(entry, next);
      delete entry.error;
      // A successful write also saves any outcome a failed write left in memory.
      delete entry.deliveryProblem;
    }
    await this.publish(owner);
  }

  private async apply(owner: string, command: JsonObject, signal: AbortSignal): Promise<unknown> {
    const requestId = this.requestId(command);
    return this.host.serialized(owner, async () => {
      this.host.check(owner, signal);
      const entry = this.entries.get(owner);
      if (!entry) {
        throw new SessionApplicationError('Application conversation is closed');
      }
      if (entry.error) {
        // Replacing an unreadable record would discard its saved data.
        throw new SessionApplicationError(
          `${entry.error} It was left unchanged; the conversation's chat remains available.`,
          409,
        );
      }
      const current = entry.record;
      const prior = current?.receipts.find((receipt) => receipt.id === requestId);
      if (prior) {
        return prior.result;
      }

      const currentVersion = current?.version ?? 0;
      if (command.expectedVersion !== currentVersion) {
        throw new SessionApplicationError(
          `Expected application version ${String(command.expectedVersion)}, but it is ` +
            `${currentVersion}. Inspect it with companion_app before replacing it.`,
          409,
        );
      }

      const bundle = await this.host.registry.load(String(command.bundle));
      const manifest = bundle.manifest;
      if (!manifest.application) {
        throw new SessionApplicationError(
          `Bundle ${manifest.name} is not an application: its widget.json needs an "application" block.`,
        );
      }

      let eventMode: SessionApplicationEventMode =
        current?.eventMode ?? manifest.application.eventMode ?? 'immediate';
      if (command.eventMode !== undefined) {
        if (
          !sessionApplicationEventModes.includes(command.eventMode as SessionApplicationEventMode)
        ) {
          throw new SessionApplicationError('eventMode must be immediate or next-input');
        }
        eventMode = command.eventMode as SessionApplicationEventMode;
      }

      // State: a first apply takes initialState or the example; a replacement
      // keeps the existing state, which must satisfy the new schema.
      let data: JsonObject;
      if (current) {
        if (command.initialState !== undefined) {
          throw new SessionApplicationError(
            'Replacing application code keeps its existing state; initialState is only for the first apply.',
          );
        }
        try {
          data = this.host.registry.validate(manifest.parameters, current.data);
        } catch (error) {
          throw new SessionApplicationError(
            `The new state schema does not accept the existing state (${errorText(error)}). ` +
              'Nothing changed.',
            409,
          );
        }
      } else {
        data = this.host.registry.validate(
          manifest.parameters,
          command.initialState ?? manifest.example,
        );
      }

      const changedData = !current || JSON.stringify(data) !== JSON.stringify(current.data);
      const version = currentVersion + 1;
      const next: ApplicationRecord = {
        format: 1,
        id: current?.id ?? randomUUID(),
        owner,
        name: manifest.name,
        bundle: bundle.hash,
        version,
        revision: current ? current.revision + (changedData ? 1 : 0) : 1,
        data,
        text: '',
        eventMode,
        receipts: current ? structuredClone(current.receipts) : [],
        batches: current ? structuredClone(current.batches) : [],
        updatedAt: this.now(),
      };
      if (current) {
        next.previous = { name: current.name, bundle: current.bundle, version: current.version };
      }

      // Prove the new code runs before publishing it: the module loads in the
      // isolated renderer, implements every declared operation and describes
      // the state. Any failure leaves the previous code and state in place.
      const candidate = this.surface(next, data, version);
      try {
        const exports = await this.host.renderer.inspect(candidate, bundle);
        const missing = missingHandlers(manifest, exports);
        if (missing.length) {
          throw Error(`widget.js does not implement: ${missing.join(', ')}`);
        }
        // mount() and the first update() must succeed with the real state,
        // as they will in the user's view.
        await this.host.renderer.render(candidate, bundle);
        next.text = await this.host.renderer.describe(candidate, bundle);
      } catch (error) {
        await this.host.renderer.discard([candidate.id]);
        throw new SessionApplicationError(
          `The application bundle failed to load: ${authoredReason(error)}`,
        );
      }

      const result: JsonObject = {
        id: next.id,
        name: next.name,
        version: next.version,
        revision: next.revision,
        eventMode: next.eventMode,
        queries: exposed(manifest.queries),
        actions: exposed(manifest.actions),
        note:
          'Installed. The open view reloads with the new code. Its queries and actions are ' +
          'callable from your next turn.',
      };
      this.remember(next, requestId, result);

      try {
        await this.host.registry.retain(bundle);
        await this.commit(owner, next, bundle, signal);
      } catch (error) {
        // Not published: retire the proven candidate page so nothing can
        // reuse it for a later, different apply.
        await this.host.renderer.discard([candidate.id]);
        throw error;
      }
      if (current) {
        await this.host.renderer.discard([this.surfaceId(current)]);
      }
      return result;
    });
  }

  private async query(
    owner: string,
    origin: Origin,
    command: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const name = String(command.name ?? '');
    return this.host.serialized(owner, async () => {
      this.host.check(owner, signal);
      const { record, bundle } = this.current(owner);
      this.checkCallable(record, bundle, origin, command, 'query', name);
      const definition = bundle.manifest.queries![name];
      const args = this.host.registry.validate(definition.parameters, command.args ?? {});
      boundedJson(args, sessionApplicationLimits.argsBytes);

      // The page receives a serialized copy; nothing it returns is saved.
      const value = await authored(
        this.host.renderer.query(this.surface(record), bundle, name, args),
      );
      const result = this.host.registry.validate(definition.returns, value);
      boundedJson(result, sessionApplicationLimits.resultBytes);
      return { result, revision: record.revision, version: record.version };
    });
  }

  private async call(
    owner: string,
    origin: Origin,
    command: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestId = this.requestId(command);
    const action = String(command.action ?? '');
    return this.host.serialized(owner, async () => {
      this.host.check(owner, signal);
      const { record, bundle } = this.current(owner);
      this.checkCallable(record, bundle, origin, command, 'action', action);

      const prior = record.receipts.find((receipt) => receipt.id === requestId);
      if (prior) {
        return prior.result;
      }
      if (command.revision !== undefined && command.revision !== record.revision) {
        throw new SessionApplicationError(
          `Application state changed; expected revision ${record.revision}.`,
          409,
        );
      }
      // Reserve event capacity before anything runs: an edit that could not be
      // reported is refused now rather than committed silently.
      if (origin.kind === 'user') {
        checkEventCapacity(record);
      }

      const definition = bundle.manifest.actions[action];
      const args = this.host.registry.validate(definition.parameters, command.args ?? {});
      boundedJson(args, sessionApplicationLimits.argsBytes);
      const reduced = await authored(
        this.host.renderer.reduce(this.surface(record), bundle, action, args, requestId),
      );
      const data = this.host.registry.validate(bundle.manifest.parameters, reduced.props);
      let result = this.host.registry.validate(definition.returns, reduced.result);
      boundedJson(result, sessionApplicationLimits.resultBytes);

      const next: ApplicationRecord = structuredClone(record);
      next.data = data;
      next.text = await this.host.renderer.describe(this.surface(next, data), bundle);
      next.revision++;
      result = { ...result, id: next.id, revision: next.revision };
      this.remember(next, requestId, result);
      if (origin.kind === 'user') {
        recordUserEdit(
          next,
          { requestId, action, args, result, previousRevision: record.revision },
          this.now(),
        );
      }

      await this.commit(owner, next, bundle, signal);
      if (origin.kind === 'user') {
        this.hooks.userEdit(owner, next.eventMode);
      }
      return result;
    });
  }

  private async inspect(
    owner: string,
    frozen: FrozenApplication | undefined,
    command: JsonObject,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (typeof command.bundle === 'string') {
      const bundle = await this.host.registry.load(command.bundle);
      if (!bundle.manifest.application) {
        throw new SessionApplicationError(`Bundle ${bundle.manifest.name} is not an application`);
      }
      return { bundle: bundle.manifest };
    }

    if (Array.isArray(command.acknowledgeEvents) && command.acknowledgeEvents.length) {
      const ids = command.acknowledgeEvents.filter(
        (id): id is string => typeof id === 'string' && uuid.test(id),
      );
      await this.host.serialized(owner, async () => {
        this.host.check(owner, signal);
        const { record, bundle } = this.current(owner);
        const next = structuredClone(record);
        if (acknowledgeFailures(next, ids) > 0) {
          await this.commit(owner, next, bundle, signal);
        }
      });
    }

    const entry = this.entries.get(owner);
    const library = await this.host.registry.discoverApplications();
    if (!entry?.record || !entry.bundle || entry.error) {
      return {
        application: entry?.error ? { error: entry.error } : null,
        library,
      };
    }

    const { record, bundle } = { record: entry.record, bundle: entry.bundle };
    const callable = frozen?.id === record.id && frozen.version === record.version;
    return {
      application: {
        id: record.id,
        name: record.name,
        description: bundle.manifest.description,
        version: record.version,
        revision: record.revision,
        eventMode: record.eventMode,
        text: record.text,
        stateSchema: bundle.manifest.parameters,
        queries: agentOperations(bundle.manifest.queries),
        actions: agentOperations(bundle.manifest.actions),
        thisTurn: callable
          ? { callableVersion: record.version }
          : {
              callableVersion: frozen?.version ?? null,
              note: 'The code changed or was installed during this turn; its queries and actions are callable from your next turn.',
            },
        events: {
          status: this.eventStatus(entry, record),
          failed: record.batches
            .filter((batch) => batch.state === 'failed')
            .map((batch) => batchSummary(batch)),
        },
        ...(command.state === true
          ? { state: { revision: record.revision, data: record.data } }
          : {}),
      },
      library,
    };
  }

  private requestId(command: JsonObject): string {
    const value = command.requestId;
    if (typeof value !== 'string' || !value || value.length > 200) {
      throw new SessionApplicationError('Application mutations require a request id');
    }
    return value;
  }

  /** Keep a bounded receipt so a retried request returns its first result. */
  private remember(record: ApplicationRecord, requestId: string, result: JsonObject): void {
    record.receipts = [...record.receipts, { id: requestId, result }].slice(
      -sessionApplicationLimits.receipts,
    );
    while (
      Buffer.byteLength(JSON.stringify(record.receipts), 'utf8') >
      sessionApplicationLimits.receiptBytes
    ) {
      record.receipts.shift();
    }
  }

  // ---- Event delivery (driven by AgentSessions) ------------------------------

  hasPendingEdits(owner: string): boolean {
    const record = this.entries.get(owner)?.record;
    return record !== undefined && hasPendingEdits(record);
  }

  /** Live overlay: an event turn is (or is no longer) queued for this conversation. */
  setQueued(owner: string, queued: boolean): void {
    const entry = this.entries.get(owner);
    if (!entry || entry.queued === queued) {
      return;
    }
    entry.queued = queued;
    void this.publish(owner).catch(() => {});
  }

  /**
   * Freeze the pending batch for a turn that is starting and record that
   * durably. Returns its prompt text, or undefined when nothing is pending.
   */
  async beginDelivery(
    owner: string,
  ): Promise<{ batchId: string; text: string; summary: string } | undefined> {
    return this.host.serialized(owner, async () => {
      const entry = this.entries.get(owner);
      if (!entry?.record || !entry.bundle || !hasPendingEdits(entry.record)) {
        return undefined;
      }
      entry.queued = false;
      const next = structuredClone(entry.record);
      const batch = beginDelivery(next, this.now())!;
      try {
        await this.commit(owner, next, entry.bundle);
      } catch (error) {
        // Nothing was frozen: the edits stay pending and are not sent to the
        // model. They are offered again only by a later edit or message.
        entry.deliveryProblem =
          `Could not record the start of delivery (${errorText(error)}). ` +
          'These edits were not delivered and are kept.';
        await this.publish(owner);
        throw error;
      }
      return { batchId: batch.id, ...eventPrompt(next, batch) };
    });
  }

  /** Record the outcome of a turn that carried a batch. */
  async finishDelivery(
    owner: string,
    batchId: string,
    outcome: { delivered: true } | { delivered: false; reason: string },
  ): Promise<void> {
    await this.host.serialized(owner, async () => {
      const entry = this.entries.get(owner);
      if (!entry?.record || !entry.bundle) {
        return;
      }
      const next = structuredClone(entry.record);
      finishDelivery(next, batchId, outcome, this.now());
      try {
        await this.commit(owner, next, entry.bundle);
      } catch (error) {
        // The turn has ended either way. Show its outcome now; the next
        // successful write saves it. Until then the saved record still says
        // `delivering`, which a restart reports as possibly undelivered.
        entry.record = next;
        entry.deliveryProblem =
          `Could not save the delivery outcome (${errorText(error)}). ` +
          'After a restart these edits may be reported as possibly undelivered.';
        await this.publish(owner);
        throw error;
      }
    });
  }

  /** Keep pending edits pending, with a note why no turn could be queued. */
  async noteAdmissionFailure(owner: string, reason: string): Promise<void> {
    await this.host.serialized(owner, async () => {
      const entry = this.entries.get(owner);
      if (!entry?.record || !entry.bundle || !hasPendingEdits(entry.record)) {
        return;
      }
      entry.queued = false;
      const next = structuredClone(entry.record);
      noteAdmissionFailure(next, reason, this.now());
      await this.commit(owner, next, entry.bundle);
    });
  }
}
