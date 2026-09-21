import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Activity } from '../core/activity.ts';
import type { InteractionContext, Log } from '../core/frame.ts';
import { PauseControl } from '../core/pause-control.ts';
import { DeliveryControl } from '../core/delivery-control.ts';
import { failureOutcome } from '../core/delivery-error.ts';
import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { InstanceLock } from '../system/instance-lock.ts';
import { typeText } from '../system/type-text.ts';
import { UtteranceHistory } from './history.ts';
import { DesktopServer } from './server.ts';
import { SoundFeedback } from './sounds.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { UserSensorRouter } from '../core/router.ts';
import { IntentPreferences } from './intent-preferences.ts';
import { migrateDesktopStorage } from './storage-migration.ts';
import { ActivityHistory } from './activity-history.ts';
import { agentChoiceStates, type AgentActions } from '../agents/choice-intents.ts';

/** No Omarchy types or commands belong here; any local UI can use this service. */
export function desktopPaths(): { database: string; socket: string } {
  const runtime = process.env.XDG_RUNTIME_DIR;

  if (!runtime) {
    throw Error(
      'XDG_RUNTIME_DIR is required for desktop integration; use --no-desktop to disable it',
    );
  }

  return {
    database: join(homedir(), 'companion', 'utterances.sqlite'),
    socket: join(runtime, 'companion', 'control.sock'),
  };
}

/** Owns storage, UI notifications, sound feedback, and explicit history recovery. */
export class DesktopRuntime {
  readonly activity: Activity;
  private readonly history: UtteranceHistory;
  private readonly activityHistory = new ActivityHistory();
  private readonly server: DesktopServer;
  private readonly sounds: SoundFeedback;
  private readonly processing = new Set<number>();
  // Reports belong to their connections, so a vanished adapter cannot leave
  // listening paused forever or clear another adapter's active playback.
  private readonly mediaClients = new Set<number>();
  private readonly delivery = new DeliveryControl();
  private readonly databaseLock: InstanceLock;
  private ready = false;
  private pasting = false;
  private speaking = false;
  private unsubscribeAgents?: () => void;
  private composerSession = '';
  private composerClient = 0;
  private composerRevision = 0;
  private panelKeyboardFocused = false;
  private panelKeyboardClient = 0;
  private panelSession = '';
  private panelClient = 0;
  private interactionRevision = 0;
  private readonly frameComposerRevisions = new Map<number, number>();
  private router?: UserSensorRouter;
  private readonly intentPreferences: IntentPreferences;
  private lastAgentActions?: AgentActions;
  private routingRevision = 0;
  private cachedAgentActions?: {
    context: InteractionContext;
    routingRevision: number;
    actions: AgentActions;
  };

  constructor(
    private readonly pause: PauseControl,
    private readonly log: Log,
    private readonly signal: AbortSignal,
    private readonly options: {
      database: string;
      socket: string;
      preview: boolean;
      sounds: boolean;
      agents?: AgentSessions;
      mediaPause?: boolean;
    },
    private readonly run: RunCommand = command,
  ) {
    this.history = new UtteranceHistory(options.database);
    this.intentPreferences = new IntentPreferences(
      join(dirname(options.database), 'disabled-intents.json'),
    );
    this.databaseLock = new InstanceLock(options.database + '.lock');
    this.sounds = new SoundFeedback(log, signal, options.sounds && !options.preview, run);
    this.server = new DesktopServer(
      options.socket,
      () => this.snapshot(),
      (request, clientId) => this.handle(request, clientId),
      (clientId) => {
        this.setPanelKeyboardFocus(false, clientId);
        if (this.mediaClients.delete(clientId)) {
          this.pause.setMediaPlaying(this.mediaClients.size > 0);
        }
        if (clientId === this.panelClient) {
          this.setPanelState('', false, clientId);
        }
        if (clientId === this.composerClient) {
          this.setComposerFocus('', 0);
          this.server.broadcast();
        }
      },
    );
    this.unsubscribeAgents = options.agents?.subscribe((event) => {
      if (event.type === 'agent-turn-completed') {
        this.sounds.play('agent-completed');
      }
      if (event.type === 'agent-removed' && event.id === this.panelSession) {
        this.setPanelState('', false, this.panelClient);
      }
      this.server.publish(event);
      this.publishAgentActions();
    });

    this.activity = {
      interactionContext: () => {
        // The pipeline calls this synchronously at speech end, before screen
        // capture and ASR. Ordinary UI reads use interactionContext() directly
        // and do not repeatedly copy transcript excerpts during streaming.
        const context = this.interactionContext();
        return {
          ...context,
          agentConversation: this.options.agents?.conversationContext(context.agentSessionId),
        };
      },
      interactionCurrent: (context) =>
        context.revision === this.interactionRevision &&
        context.agentSessionId === this.panelSession &&
        this.options.agents?.has(context.agentSessionId) === true,
      speechChanged: (speaking) => {
        const next = speaking && !this.pause.paused;
        if (this.speaking !== next) {
          this.speaking = next;
          this.server.broadcast();
        }
      },
      delivery: this.delivery,
      // Hyprland's activewindow still names the last ordinary window when a
      // layer-shell composer owns keyboard focus. Track that extra boundary
      // so leaving/entering a composer cannot redirect pending dictation.
      deliveryAllowed: (id) =>
        !this.frameComposerRevisions.has(id) ||
        this.frameComposerRevisions.get(id) === this.composerRevision,
      deliveryStarted: (id) => {
        this.history.markDeliveryStarted(id);
        this.server.broadcast();
      },
      processing: (id) => {
        this.frameComposerRevisions.set(id, this.composerRevision);
        this.processing.add(id);
        this.sounds.play('processing');
        this.server.broadcast();
      },
      transcribed: (transcript) => {
        this.history.add(transcript);
        this.server.broadcast();
      },
      screenshotCaptured: (id, screenshot) => this.history.saveScreenshot(id, screenshot),
      audioCaptured: (id, samples) => this.history.saveAudio(id, samples),
      intentRequested: (id, request) => this.history.saveIntentRequest(id, request),
      intentRecognized: (id, intent) => {
        this.history.setIntent(id, intent);
        this.server.broadcast();
      },
      labelPrevious: (id, correct) => {
        const target = this.history.labelPrevious(id, correct);
        if (target) {
          this.publishFeedback(target);
        }
        return target;
      },
      outcome: (id, outcome) => {
        this.history.setOutcome(id, outcome);

        // A predicted send is not a delivered utterance. Skips/errors have no
        // success cue, and preview mode must not imply that text was delivered.
        if (outcome === 'sent' || outcome === 'ignored' || outcome === 'labeled') {
          this.sounds.play(outcome === 'labeled' ? 'sent' : outcome);
        }

        this.server.broadcast();
      },
      finished: (id) => {
        this.frameComposerRevisions.delete(id);
        this.processing.delete(id);
        this.delivery.finish(id);
        const entry = this.history.finish(id);
        if (entry && entry.outcome !== 'processing' && entry.outcome !== 'delivering') {
          this.server.publish({
            type: 'activity-entry',
            sessionId: this.activityHistory.sessionId,
            entry: this.activityHistory.update(entry, this.history.feedback(entry.id)),
          });
        }
        this.server.broadcast();
      },
    };
  }

  /** Attach after processor registration, before accepting any sensor frames. */
  async connectRouter(router: UserSensorRouter): Promise<void> {
    if (this.router) {
      throw Error('Desktop router already connected');
    }
    const disabled = await this.intentPreferences.load();
    for (const name of router.processors.keys()) {
      router.setEnabled(name, !disabled.has(name));
    }
    this.router = router;
    this.routingRevision++;
    router.on('change', this.routingChanged);
    this.server.broadcast();
  }

  private readonly routingChanged = () => {
    this.routingRevision++;
    this.server.broadcast();
  };

  private agentActions(): AgentActions {
    const interaction = this.interactionContext();
    const previous = this.cachedAgentActions;
    // Choice sets are immutable. Compare their identity and the few routing
    // fields before rebuilding/serializing potentially long descriptions on
    // every token flush. Capacity changes in another session still invalidate.
    if (
      previous &&
      previous.routingRevision === this.routingRevision &&
      previous.context.revision === interaction.revision &&
      previous.context.agentSessionId === interaction.agentSessionId &&
      previous.context.agentChoices === interaction.agentChoices &&
      previous.context.agentRunId === interaction.agentRunId &&
      previous.context.agentAcceptsFollowUp === interaction.agentAcceptsFollowUp &&
      previous.context.agentFollowUpUnavailableReason === interaction.agentFollowUpUnavailableReason
    ) {
      return previous.actions;
    }
    const actions = {
      sessionId: interaction.agentSessionId,
      choices: agentChoiceStates({ interaction }, this.router?.reservedPrefixes() ?? []),
      stopRunId: interaction.agentRunId ?? '',
    };
    this.cachedAgentActions = {
      context: interaction,
      routingRevision: this.routingRevision,
      actions,
    };
    return actions;
  }

  private publishAgentActions(): void {
    const actions = this.agentActions();
    if (actions !== this.lastAgentActions) {
      this.lastAgentActions = actions;
      this.server.publish({ type: 'agent-actions', actions });
    }
  }

  async start(): Promise<void> {
    // Hold database ownership from before recovery until after SQLite closes.
    // The separate socket lock protects stale-socket recovery, including when
    // another caller uses the same database with a different socket path.
    await this.databaseLock.acquire();

    try {
      await this.server.start();

      // Custom databases used by isolated runs/tests must never import personal
      // history. Only the default destination adopts the former XDG location.
      if (this.options.database === join(homedir(), 'companion', 'utterances.sqlite')) {
        const state = process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
        const legacyDatabase = join(state, 'companion', 'utterances.sqlite');
        const migrated = await migrateDesktopStorage(legacyDatabase, this.options.database);

        if (migrated) {
          this.log('desktop', `Migrated history from ${legacyDatabase}`);
        }
      }

      await this.history.open();

      // Prepare cues even when starting muted, so the desktop can enable them
      // later without restarting. Preview mode remains silent throughout.
      if (!this.options.preview) {
        await this.sounds.initialize();
      }

      this.ready = true;
      this.pause.on('change', this.pauseChanged);
      this.server.broadcast();
      this.log('desktop', `Utterances: ${this.options.database}`);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private readonly pauseChanged = () => {
    if (this.pause.paused) {
      this.speaking = false;
    }

    this.log(
      this.pause.paused ? 'paused' : 'listening',
      this.pause.reason === 'media'
        ? 'Media playing; microphone stopped and pending speech cancelled'
        : this.pause.paused
          ? 'Microphone stopped; pending speech cancelled'
          : 'Microphone resuming',
    );
    this.server.broadcast();
  };

  private snapshot(): object {
    return {
      protocol: 1,
      ready: this.ready,
      paused: this.pause.paused,
      pauseReason: this.pause.reason,
      mediaPauseAvailable: this.options.mediaPause !== false,
      speaking: this.speaking,
      soundsEnabled: this.sounds.enabled,
      processing: this.processing.size,
      preview: this.options.preview,
      history: this.ready ? this.history.snapshot() : [],
      activitySessionId: this.activityHistory.sessionId,
      activityHistoryCount: this.activityHistory.count,
      historyDeletionAvailable: !this.options.preview,
      sessions: this.options.agents?.snapshot() ?? [],
      previousSessions: this.options.agents?.previousSnapshot() ?? [],
      intents: this.router?.intentStates({ interaction: this.interactionContext() }) ?? [],
      agentActions: this.agentActions(),
    };
  }

  private setComposerFocus(id: string, clientId: number): void {
    if (id !== this.composerSession || clientId !== this.composerClient) {
      this.composerSession = id;
      this.composerClient = clientId;
      this.composerRevision++;
      this.interactionRevision++;
    }
  }

  private setPanelKeyboardFocus(focused: boolean, clientId: number): void {
    if (!focused && clientId !== this.panelKeyboardClient) {
      return;
    }
    const owner = focused ? clientId : 0;
    if (focused !== this.panelKeyboardFocused || owner !== this.panelKeyboardClient) {
      this.panelKeyboardFocused = focused;
      this.panelKeyboardClient = owner;
      this.composerRevision++;
    }
  }

  private interactionContext(): InteractionContext {
    const id = this.options.agents?.has(this.panelSession) ? this.panelSession : '';
    return {
      agentSessionId: id,
      agentComposerFocused: Boolean(
        id && this.composerSession === id && this.composerClient === this.panelClient,
      ),
      revision: this.interactionRevision,
      ...this.options.agents?.interaction(id),
    };
  }

  /** One ordered UI report binds the visible tab and keyboard focus together. */
  private setPanelState(id: string, focused: boolean, clientId: number): void {
    // A stale/disconnecting observer must not clear another UI's selected tab.
    if (!id && clientId !== this.panelClient) {
      return;
    }
    const previousRevision = this.interactionRevision;
    const owner = id ? clientId : 0;
    if (id !== this.panelSession || owner !== this.panelClient) {
      this.panelSession = id;
      this.panelClient = owner;
      this.interactionRevision++;
    }
    if (focused || clientId === this.composerClient) {
      this.setComposerFocus(focused ? id : '', focused ? clientId : 0);
    }
    if (this.interactionRevision !== previousRevision) {
      this.server.broadcast();
    }
  }

  private publishFeedback(id: string): void {
    // Voice feedback may target an earlier run. Persist it, but only refresh
    // cards already belonging to the current run's Activity history.
    if (!this.activityHistory.has(id)) {
      return;
    }
    const entry = this.history.find(id)!;
    this.server.publish({
      type: 'activity-entry',
      sessionId: this.activityHistory.sessionId,
      entry: this.activityHistory.update(entry, this.history.feedback(id)),
    });
  }

  private async handle(value: unknown, clientId: number): Promise<unknown> {
    this.signal.throwIfAborted();

    if (!this.ready || !value || typeof value !== 'object') {
      throw Error('Companion is not ready');
    }

    const request = value as Record<string, unknown>;

    if (request.action === 'delete-history') {
      if (typeof request.id !== 'string') {
        throw Error('Expected an utterance id');
      }
      if (this.options.preview) {
        return 'preview';
      }
      await this.history.delete(request.id);
      const removed = this.activityHistory.remove(request.id);
      this.server.publish({
        type: 'history-deleted',
        id: request.id,
        sessionId: this.activityHistory.sessionId,
        removed,
      });
      this.server.broadcast();
      return 'deleted';
    }

    if (request.action === 'activity-history') {
      if (
        request.sessionId !== this.activityHistory.sessionId ||
        !Number.isSafeInteger(request.after) ||
        !Number.isSafeInteger(request.through) ||
        (request.after as number) < 0 ||
        (request.through as number) < (request.after as number) ||
        (request.through as number) > this.activityHistory.count
      ) {
        throw Error('Expected the current Activity session and a valid history range');
      }
      return this.activityHistory.page(request.after as number, request.through as number);
    }

    if (request.action === 'label-history' || request.action === 'start-history-agent') {
      if (typeof request.id !== 'string' || !this.activityHistory.has(request.id)) {
        throw Error('Choose a completed utterance from this Companion run');
      }
      if (request.action === 'label-history') {
        if (
          typeof request.correct !== 'boolean' ||
          (request.actualIntent !== undefined &&
            request.actualIntent !== null &&
            (typeof request.actualIntent !== 'string' ||
              !this.router?.processors.has(request.actualIntent)))
        ) {
          throw Error('Expected a correctness label and an optional registered intent');
        }
        if (this.options.preview) {
          return 'preview';
        }
        this.history.label(
          request.id,
          request.correct,
          request.actualIntent as string | null | undefined,
        );
        this.publishFeedback(request.id);
        return 'labeled';
      }
      if (!this.options.agents) {
        throw Error('Coding sessions are unavailable');
      }
      if (this.options.preview) {
        return 'preview';
      }
      const frame = await this.history.recordedFrame(request.id);
      this.options.agents.start(frame, this.signal);
      return 'started';
    }

    if (request.action === 'set-intent-enabled') {
      if (
        !this.router ||
        typeof request.name !== 'string' ||
        typeof request.enabled !== 'boolean'
      ) {
        throw Error('Expected an intent name and boolean enabled state');
      }
      const router = this.router;
      const name = request.name;
      const enabled = request.enabled;
      if (!router.processors.has(name) || (name === 'IGNORE' && !enabled)) {
        throw Error('Unknown intent, or an attempt to disable the IGNORE fallback');
      }
      await this.intentPreferences.setEnabled(name, enabled, () =>
        router.setEnabled(name, enabled),
      );
      this.log('intent-control', `${name}: ${enabled ? 'enabled' : 'disabled'}`);
      return enabled ? 'intent-enabled' : 'intent-disabled';
    }

    if (request.action === 'media-playback') {
      if (typeof request.playing !== 'boolean') {
        throw Error('Expected a boolean media playback state');
      }

      // Supplied text and audio files must not be interrupted by desktop media.
      if (this.options.mediaPause !== false) {
        if (request.playing) {
          this.mediaClients.add(clientId);
        } else {
          this.mediaClients.delete(clientId);
        }
        this.pause.setMediaPlaying(this.mediaClients.size > 0);
      }
      return 'media-recorded';
    }

    if (request.action === 'panel-state') {
      if (
        typeof request.id !== 'string' ||
        typeof request.composerFocused !== 'boolean' ||
        (request.keyboardFocused !== undefined && typeof request.keyboardFocused !== 'boolean') ||
        (!request.id && request.composerFocused) ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw Error('Expected a visible agent session id (or empty id) and composerFocused');
      }
      this.setPanelKeyboardFocus(
        request.keyboardFocused === true || request.composerFocused,
        clientId,
      );
      this.setPanelState(request.id, request.composerFocused, clientId);
      return 'panel-recorded';
    }

    if (request.action === 'composer-focus') {
      if (
        typeof request.id !== 'string' ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw Error('Expected a current composer session id or an empty id');
      }
      if (request.id !== '' || clientId === this.composerClient) {
        this.setComposerFocus(request.id, request.id ? clientId : 0);
        this.server.broadcast();
      }
      return 'focus-recorded';
    }

    if (request.action === 'choose-agent') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.revision !== 'string' ||
        !Number.isInteger(request.index)
      ) {
        throw Error('Expected a conversation, choice revision, and option index');
      }
      // A queued click from a tab that has since been hidden cannot submit.
      if (clientId !== this.panelClient || request.id !== this.panelSession) {
        throw Error('This conversation is no longer selected');
      }
      this.options.agents.selectChoice(
        request.id,
        request.revision,
        request.index as number,
        this.signal,
      );
      return 'submitted';
    }

    if (request.action === 'stop-agent-run') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.runId !== 'string'
      ) {
        throw Error('Expected a conversation and running turn id');
      }
      if (
        clientId !== this.panelClient ||
        request.id !== this.panelSession ||
        !(await this.options.agents.stopRun(request.id, request.runId))
      ) {
        throw Error('This agent run is no longer current');
      }
      return 'stopped';
    }

    if (request.action === 'send-agent') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.text !== 'string'
      ) {
        throw Error('Expected an agent session id and follow-up text');
      }
      this.options.agents.followUp(request.id, request.text, this.signal);
      return 'submitted';
    }

    if (
      request.action === 'stop-agent' ||
      request.action === 'close-agent' ||
      request.action === 'reopen-agent'
    ) {
      if (!this.options.agents || typeof request.id !== 'string') {
        throw Error('Expected an agent session id');
      }
      if (request.action === 'close-agent') {
        await this.options.agents.remove(request.id);
      } else if (request.action === 'reopen-agent') {
        await this.options.agents.reopen(request.id);
        return 'reopened';
      } else {
        await this.options.agents.stop(request.id);
      }
      return request.action === 'close-agent' ? 'closed' : 'stopped';
    }

    if (request.action === 'toggle-pause') {
      this.pause.toggle();
      return this.pause.paused ? 'paused' : 'listening';
    }

    if (request.action === 'toggle-sounds') {
      if (this.options.preview) {
        throw Error('Sound feedback is unavailable in preview mode');
      }

      this.sounds.setEnabled(!this.sounds.enabled);
      this.log('sound', this.sounds.enabled ? 'Feedback enabled' : 'Feedback muted');
      this.server.broadcast();
      return this.sounds.enabled ? 'sounds-enabled' : 'sounds-muted';
    }

    if (
      request.action !== 'paste' ||
      typeof request.id !== 'string' ||
      typeof request.target !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(request.target)
    ) {
      throw Error(
        'Expected toggle-pause, toggle-sounds, or paste with an utterance id and target window',
      );
    }

    const entry = this.history.find(request.id);

    if (!entry || this.pasting) {
      throw Error(entry ? 'A paste is already running' : 'Utterance not found');
    }

    const eventId = this.history.beginPaste(entry.id, request.target);
    const composerRevision = this.composerRevision;
    const expectedComposer =
      typeof request.composer === 'string' ? request.composer : this.composerSession;
    this.pasting = true;

    // The shared delivery owner either supersedes a pending automatic send or
    // rejects recovery if that utterance is already being typed.
    const frameId = this.history.activeFrameId(entry.id);
    let application: string | null = null;

    try {
      const target = request.target;
      const outcome = await this.delivery.recover(frameId, this.signal, async () => {
        // Bound the initial focus lookup independently of typing. A wedged
        // compositor cannot hold the shared keyboard queue indefinitely.
        // Recheck only at the front of the queue; focus may change while waiting.
        const focusDeadline = AbortSignal.any([this.signal, AbortSignal.timeout(5000)]);
        await delay(150, undefined, { signal: focusDeadline });
        const window = await activeWindow(focusDeadline, this.run);
        application = window.address === target ? window.class : null;

        if (window.address !== target) {
          return 'skipped';
        }

        if (this.options.preview) {
          return 'preview';
        }

        const delivered = await typeText(
          entry.utterance,
          target,
          // typeText owns a separate, length-aware typing deadline. Passing the
          // focus deadline here would still cut long recovery insertions short.
          this.signal,
          this.run,
          () =>
            this.composerRevision === composerRevision &&
            this.composerSession === expectedComposer &&
            (expectedComposer !== '' || !this.panelKeyboardFocused),
          () => this.history.markPasteStarted(eventId, application),
        );
        return delivered ? 'sent' : 'skipped';
      });

      this.history.finishPaste(eventId, outcome, application);
      this.log('paste', `${outcome}: ${entry.id}`);

      if (outcome === 'sent') {
        this.sounds.play('sent');
      }

      return outcome;
    } catch (error) {
      this.history.finishPaste(eventId, failureOutcome(error, this.signal), application);
      throw error;
    } finally {
      this.pasting = false;
    }
  }

  async close(): Promise<void> {
    this.router?.off('change', this.routingChanged);
    this.unsubscribeAgents?.();
    this.ready = false;
    this.speaking = false;
    this.pause.off('change', this.pauseChanged);

    try {
      await this.server.close();
      await this.sounds.close();
    } finally {
      this.history.close();
      await this.databaseLock.close();
    }
  }
}
