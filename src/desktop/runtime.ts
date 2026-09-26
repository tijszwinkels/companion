import { randomUUID } from 'node:crypto';
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
import { UtteranceHistory, type HistoryEntry } from './history.ts';
import { saveEmptyAudioClip } from './empty-audio-clips.ts';
import { DesktopServer } from './server.ts';
import { SoundFeedback, outcomeSound } from './sounds.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { SensorPipeline } from '../core/pipeline.ts';
import { IntentPreferences } from './intent-preferences.ts';
import { CleanupPreference } from './cleanup-preference.ts';
import type { TranscriptionCleanupSetting } from '../core/transcription-cleanup/setting.ts';
import { migrateDesktopStorage } from './storage-migration.ts';
import { ActivityHistory } from './activity-history.ts';
import { agentChoiceStates, type AgentActions } from '../agents/choice-intents.ts';
import type { AgentDraftOutcome, AgentDraftRequest } from '../agents/types.ts';

/** A connected panel must confirm a forwarded draft within this time. */
const draftConfirmationMilliseconds = 5000;

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

  // One record per continued utterance (docs/speech-timing.md, D4). Frames
  // the pipeline reported as superseded (attemptSuperseded) belong to a
  // continuation chain; only they are deferred, never a row merely because of
  // its outcome. A chain member's row waits in `supersededRows`, unpublished
  // and held against paste/label/delete, until the final attempt of its chain
  // settles; it is then retired or published as an ordinary row. Both
  // collections are emptied when their chain settles, on every exit path.
  private readonly chainMembers = new Set<number>();
  private readonly supersededRows = new Map<number, HistoryEntry>();
  // Superseded frames named by a settled chain before they finished. Not
  // expected (the sensor worker is serial); such a row is simply kept.
  private readonly unsettledSuperseded = new Set<number>();
  // Frames still in progress whose WAV has been published, so a chain's final
  // attempt is known to own the whole utterance before anything is removed.
  private readonly recordedAudio = new Set<number>();
  // Retirements run after dispatch, off the sensor worker; close() awaits them.
  private readonly retirements = new Set<Promise<void>>();

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
  private navigation?: { clientId: number; token: string };
  private modelDiscovery?: Promise<unknown>;
  private readonly frameComposerRevisions = new Map<number, number>();
  private router?: UserSensorRouter;
  private pipeline?: Pick<SensorPipeline, 'submitText'>;
  private readonly intentPreferences: IntentPreferences;
  private readonly cleanupPreference: CleanupPreference;
  private lastAgentActions?: AgentActions;
  private routingRevision = 0;
  private cachedAgentActions?: {
    context: InteractionContext;
    routingRevision: number;
    actions: AgentActions;
  };
  // Panels that hold composer drafts, by client, with the sequence of their
  // latest panel report. The most recently active panel receives a draft.
  private readonly draftHosts = new Map<number, number>();
  private draftReportSequence = 0;
  private readonly pendingDrafts = new Map<
    string,
    { clientId: number; finish(outcome: AgentDraftOutcome): void }
  >();

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
      /** The live transcription cleanup switch; absent hides the UI control. */
      cleanup?: TranscriptionCleanupSetting;
    },
    private readonly run: RunCommand = command,
  ) {
    this.history = new UtteranceHistory(options.database);
    this.intentPreferences = new IntentPreferences(
      join(dirname(options.database), 'disabled-intents.json'),
    );
    this.cleanupPreference = new CleanupPreference(
      join(dirname(options.database), 'transcription-cleanup.json'),
    );
    this.databaseLock = new InstanceLock(options.database + '.lock');
    this.sounds = new SoundFeedback(log, signal, options.sounds && !options.preview, run);
    this.server = new DesktopServer(
      options.socket,
      () => this.snapshot(),
      (request, clientId) => this.handle(request, clientId),
      (clientId) => {
        this.draftHosts.delete(clientId);
        this.abandonDrafts(clientId, 'The panel disconnected before confirming the draft.');
        const navigationRemoved = this.navigation?.clientId === clientId;
        if (navigationRemoved) {
          this.navigation = undefined;
        }
        this.setPanelKeyboardFocus(false, clientId);
        if (this.mediaClients.delete(clientId)) {
          this.pause.setMediaPlaying(this.mediaClients.size > 0);
        }

        let stateBroadcast = false;
        if (clientId === this.panelClient) {
          stateBroadcast = this.setPanelState('', false, clientId);
        }
        if (clientId === this.composerClient) {
          this.setComposerFocus('', 0);
          this.server.broadcast();
          stateBroadcast = true;
        }

        if (navigationRemoved && !stateBroadcast) {
          // Activity/Previous owns navigation without a selected conversation.
          // Otherwise the conversation cleanup already published this change.
          this.server.broadcast();
        }
      },
    );
    options.agents?.setDraftHost((request, signal) => this.requestDraft(request, signal));
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
      selectSession: (context, index) => this.selectSession(context, index),
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
      screenshotCaptured: async (id, screenshot) => {
        await this.history.saveScreenshot(id, screenshot);
      },
      audioCaptured: async (id, samples) => {
        if (await this.history.saveAudio(id, samples)) {
          this.recordedAudio.add(id);
        }
      },
      emptyAudioCaptured: (clip) => saveEmptyAudioClip(dirname(options.database), clip),
      intentRequested: (id, request) => this.history.saveIntentRequest(id, request),
      intentRecognized: (id, intent) => {
        this.history.setIntent(id, intent);
        this.server.broadcast();
      },
      transcriptionCleanup: (id, record) => {
        this.history.saveCleanup(id, record);
        this.server.broadcast();
      },
      labelPrevious: (id, correct) => {
        const target = this.history.labelPrevious(id, correct);
        if (target) {
          this.publishFeedback(target);
        }
        return target;
      },
      outcome: (id, outcome, destination) => {
        this.history.setOutcome(id, outcome);

        // A predicted send is not a delivered utterance. Skips/errors have no
        // success cue, and preview mode must not imply that text was delivered.
        const cue = outcomeSound(outcome, destination);
        if (cue) {
          this.sounds.play(cue);
        }

        this.server.broadcast();
      },
      attemptSuperseded: (id) => {
        this.chainMembers.add(id);
      },
      continuationSettled: (finalId, supersededIds) => {
        this.settleContinuation(finalId, supersededIds);
      },
      finished: (id) => {
        this.frameComposerRevisions.delete(id);
        this.processing.delete(id);
        this.delivery.finish(id);
        this.recordedAudio.delete(id);
        const entry = this.history.finish(id);
        const chainSettled = this.unsettledSuperseded.delete(id);

        if (entry && this.chainMembers.has(id) && !chainSettled) {
          // Its continuation normally owns the whole utterance; decide when
          // that chain settles (settleContinuation) rather than show it now.
          this.history.holdForRetirement(entry.id);
          this.supersededRows.set(id, entry);
        } else if (entry && entry.outcome !== 'processing' && entry.outcome !== 'delivering') {
          this.publishActivity(entry);
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
    for (const [name, registration] of router.processors) {
      if (registration.llmEligible) {
        router.setEnabled(name, !disabled.inference.has(name), 'inference');
      }
      if (registration.prefixes.length) {
        router.setEnabled(name, !disabled.shortcut.has(name), 'shortcut');
      }
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

      // Apply the saved cleanup choice before the pipeline accepts any
      // utterance. A missing file keeps cleanup off.
      if (this.options.cleanup) {
        this.options.cleanup.set(await this.cleanupPreference.load());
        this.options.cleanup.on('change', this.cleanupChanged);
      }

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

  private readonly cleanupChanged = () => {
    this.server.broadcast();
  };

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

  /** Attach the live queue after CLI routing and sensors have been constructed. */
  connectPipeline(pipeline: Pick<SensorPipeline, 'submitText'>): void {
    this.pipeline = pipeline;
    this.server.broadcast();
  }

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
      textInputAvailable: Boolean(this.pipeline),
      sessions: this.options.agents?.snapshot() ?? [],
      sessionOrderRevision: this.options.agents?.order().revision ?? '',
      sessionControlsAvailable: Boolean(this.options.agents),
      previousSessions: this.options.agents?.previousSnapshot() ?? [],
      intents: this.router?.intentStates({ interaction: this.interactionContext() }) ?? [],
      // Null hides the switch (no cleanup support in this listener).
      transcriptionCleanup: this.options.cleanup ? { enabled: this.options.cleanup.enabled } : null,
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
    const order = this.options.agents?.order();
    return {
      agentNavigation:
        this.navigation && order
          ? {
              ...this.navigation,
              ids: order.ids,
              orderRevision: order.revision,
            }
          : undefined,
      agentSessionId: id,
      agentComposerFocused: Boolean(
        id && this.composerSession === id && this.composerClient === this.panelClient,
      ),
      revision: this.interactionRevision,
      ...this.options.agents?.interaction(id),
    };
  }

  private selectSession(context: InteractionContext, index: number): boolean {
    const captured = context.agentNavigation;
    const order = this.options.agents?.order();
    if (
      !captured ||
      !this.navigation ||
      !order ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 8 ||
      captured.clientId !== this.navigation.clientId ||
      captured.token !== this.navigation.token ||
      captured.orderRevision !== order.revision ||
      !captured.ids[index] ||
      captured.ids[index] !== order.ids[index]
    ) {
      return false;
    }
    return this.server.publishTo(captured.clientId, {
      type: 'agent-select',
      id: captured.ids[index],
      token: captured.token,
      orderRevision: captured.orderRevision,
    });
  }

  /** Bind tab/focus together; return whether the resulting snapshot was sent. */
  private setPanelState(id: string, focused: boolean, clientId: number): boolean {
    // A stale/disconnecting observer must not clear another UI's selected tab.
    if (!id && clientId !== this.panelClient) {
      return false;
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
      return true;
    }
    return false;
  }

  private publishActivity(entry: HistoryEntry): void {
    this.server.publish({
      type: 'activity-entry',
      sessionId: this.activityHistory.sessionId,
      entry: this.activityHistory.update(entry, this.history.feedback(entry.id)),
    });
  }

  /**
   * The final attempt of a continued utterance has settled, just before its
   * own `finished`. Its superseded predecessors are retired only when the final
   * attempt owns the whole utterance: its row exists and its WAV, which
   * contains every earlier part's raw audio, was published. Its outcome does
   * not matter; an error, cancellation or ignored result is the record the
   * user recovers from, including the pipeline's recovered-failure record with
   * the earlier words. A fresh PNG is not required: without one, the earlier
   * screen is lost with its attempt rather than attached to the final record.
   * If the final attempt does not own the utterance (its WAV or row could not
   * be written), the predecessors are kept as explicit residual rows.
   */
  private settleContinuation(finalId: number, supersededIds: readonly number[]): void {
    const owned = this.history.entryId(finalId) !== undefined && this.recordedAudio.has(finalId);

    const predecessors: HistoryEntry[] = [];
    for (const id of supersededIds) {
      this.chainMembers.delete(id);
      const entry = this.supersededRows.get(id);
      if (entry) {
        this.supersededRows.delete(id);
        predecessors.push(entry);
      } else if (this.processing.has(id)) {
        this.unsettledSuperseded.add(id);
      }
    }

    if (!predecessors.length) {
      return;
    }

    if (!owned) {
      this.log(
        'retention-incomplete',
        `Keeping superseded ${predecessors.map((entry) => entry.id).join(', ')}: ` +
          'the final attempt was not fully recorded',
        finalId,
      );
      for (const entry of predecessors) {
        this.history.releaseRetirement(entry.id);
        // Publish only a row that still exists: never recreate a card.
        const current = this.history.find(entry.id);
        if (current) {
          this.publishActivity(current);
        }
      }
      return;
    }

    const retirement = this.retire(predecessors).finally(() => {
      this.retirements.delete(retirement);
    });
    this.retirements.add(retirement);
  }

  /**
   * Remove superseded rows and their recordings one at a time. A row that
   * cannot be retired (for example, one with an earlier paste reference, or a
   * failed file or SQLite removal) stays as an explicit residual row, logged
   * as `retention-incomplete` and shown as a normal Activity card; nothing
   * reports a removal that did not happen. Files are removed first, so such a
   * row may have lost some recordings; the final attempt owns the audio.
   */
  private async retire(entries: HistoryEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.history.retireSuperseded(entry.id);
        this.history.releaseRetirement(entry.id);
        this.log('retired', `Superseded attempt ${entry.id}; its continuation keeps the utterance`);
        this.server.publish({
          type: 'history-deleted',
          id: entry.id,
          sessionId: this.activityHistory.sessionId,
        });
      } catch (error) {
        // Kept as an explicit residual row. With files removed first, some of
        // its recordings may already be gone; the final attempt owns the audio.
        this.history.releaseRetirement(entry.id);
        const message = error instanceof Error ? error.message : String(error);
        this.log('retention-incomplete', `Keeping superseded ${entry.id}: ${message}`);
        const current = this.history.find(entry.id);
        if (current) {
          this.publishActivity(current);
        }
      }
    }
    this.server.broadcast();
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

  /**
   * Prefer the panel that currently owns visible navigation; otherwise the
   * draft-capable panel that reported most recently. Each UI instance keeps its
   * own drafts, so exactly one panel is asked and must answer.
   */
  private draftClient(): number | undefined {
    const visible = this.navigation?.clientId;
    if (visible !== undefined && this.draftHosts.has(visible)) {
      return visible;
    }
    let newest: number | undefined;
    let newestSequence = -1;
    for (const [clientId, sequence] of this.draftHosts) {
      if (sequence > newestSequence) {
        newest = clientId;
        newestSequence = sequence;
      }
    }
    return newest;
  }

  /**
   * Forward an agent's draft to one panel and wait for its explicit answer.
   * Once sent, timeout, disconnect or turn cancellation are `unconfirmed`: the
   * panel may already have applied it. Never retried automatically.
   */
  private requestDraft(
    request: AgentDraftRequest,
    signal: AbortSignal,
  ): Promise<AgentDraftOutcome> {
    const clientId = this.draftClient();
    if (clientId === undefined || signal.aborted) {
      return Promise.resolve({ outcome: 'offline', reason: '' });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (outcome: AgentDraftOutcome) => {
        if (!this.pendingDrafts.delete(requestId)) {
          return;
        }
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
        resolve(outcome);
      };
      const timer = setTimeout(
        () =>
          finish({
            outcome: 'unconfirmed',
            reason: 'The panel did not confirm the draft within 5 seconds.',
          }),
        draftConfirmationMilliseconds,
      );
      const cancelled = () =>
        finish({
          outcome: 'unconfirmed',
          reason: 'The agent turn ended before the panel confirmed the draft.',
        });

      this.pendingDrafts.set(requestId, { clientId, finish });
      signal.addEventListener('abort', cancelled, { once: true });

      const sent = this.server.publishTo(clientId, {
        type: 'agent-draft',
        requestId,
        id: request.sessionId,
        text: request.text,
        ifDraftExists: request.ifDraftExists,
        focus: request.focus,
        source: request.source,
      });
      if (!sent) {
        finish({ outcome: 'offline', reason: 'The panel disconnected.' });
      }
    });
  }

  private abandonDrafts(clientId: number | undefined, reason: string): void {
    for (const pending of [...this.pendingDrafts.values()]) {
      if (clientId === undefined || pending.clientId === clientId) {
        pending.finish({ outcome: 'unconfirmed', reason });
      }
    }
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

    if (request.action === 'agent-tool-page') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.groupId !== 'string' ||
        typeof request.epoch !== 'string' ||
        typeof request.revision !== 'string' ||
        (request.callRevision !== undefined &&
          (typeof request.callRevision !== 'string' || request.callRevision.length > 36)) ||
        typeof request.requestId !== 'string' ||
        request.requestId.length > 128 ||
        !Number.isSafeInteger(request.index) ||
        !Number.isSafeInteger(request.offset)
      ) {
        throw Error('Expected a tool group, revision and page position');
      }
      if (clientId !== this.panelClient || request.id !== this.panelSession) {
        throw Error('This conversation is no longer selected');
      }
      return this.options.agents.toolPage({
        id: request.id,
        groupId: request.groupId,
        epoch: request.epoch,
        revision: request.revision,
        callRevision: request.callRevision as string | undefined,
        index: request.index as number,
        offset: request.offset as number,
      });
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
        typeof request.enabled !== 'boolean' ||
        (request.mode !== undefined && request.mode !== 'inference' && request.mode !== 'shortcut')
      ) {
        throw Error('Expected an intent name and boolean enabled state');
      }
      const router = this.router;
      const name = request.name;
      const enabled = request.enabled;
      const mode = request.mode;
      router.validateEnabled(name, enabled, mode);
      await this.intentPreferences.setEnabled(
        name,
        enabled,
        () => router.setEnabled(name, enabled, mode),
        mode,
      );
      this.log(
        'intent-control',
        `${name} (${mode ?? 'both'}): ${enabled ? 'enabled' : 'disabled'}`,
      );
      return enabled ? 'intent-enabled' : 'intent-disabled';
    }

    if (request.action === 'set-transcription-cleanup') {
      if (!this.options.cleanup || typeof request.enabled !== 'boolean') {
        throw Error('Expected a boolean transcription cleanup state');
      }
      const cleanup = this.options.cleanup;
      const enabled = request.enabled;
      await this.cleanupPreference.set(enabled, () => cleanup.set(enabled));
      this.log('cleanup-control', `Transcription cleanup ${enabled ? 'enabled' : 'disabled'}`);
      return enabled ? 'cleanup-enabled' : 'cleanup-disabled';
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

    if (request.action === 'agent-draft-result') {
      const outcomes = ['inserted', 'appended', 'conflict', 'unavailable'];
      if (
        typeof request.requestId !== 'string' ||
        typeof request.outcome !== 'string' ||
        !outcomes.includes(request.outcome) ||
        (request.reason !== undefined &&
          (typeof request.reason !== 'string' || request.reason.length > 300))
      ) {
        throw Error('Expected a draft request id and outcome');
      }
      // Only the panel that was asked can answer; a late answer is refused.
      const pending = this.pendingDrafts.get(request.requestId);
      if (!pending || pending.clientId !== clientId) {
        throw Error('This draft request has expired');
      }
      pending.finish({
        outcome: request.outcome as AgentDraftOutcome['outcome'],
        reason: (request.reason as string | undefined) ?? '',
      });
      return 'draft-recorded';
    }

    if (request.action === 'panel-state') {
      if (
        typeof request.id !== 'string' ||
        (request.draftHost !== undefined && typeof request.draftHost !== 'boolean') ||
        (request.visible !== undefined && typeof request.visible !== 'boolean') ||
        (request.navigationToken !== undefined &&
          (typeof request.navigationToken !== 'string' || request.navigationToken.length > 128)) ||
        typeof request.composerFocused !== 'boolean' ||
        (request.keyboardFocused !== undefined && typeof request.keyboardFocused !== 'boolean') ||
        (!request.id && request.composerFocused) ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw Error('Expected a visible agent session id (or empty id) and composerFocused');
      }
      // New clients report Activity/Previous visibility too. Older adapters
      // keep their existing conversation behavior, without voice navigation.
      const previousNavigation = this.navigation;
      if (
        request.visible === true &&
        typeof request.navigationToken === 'string' &&
        request.navigationToken
      ) {
        this.navigation = { clientId, token: request.navigationToken };
      } else if (this.navigation?.clientId === clientId) {
        this.navigation = undefined;
      }
      // Only UIs that implement agent-draft advertise it; older ones omit it.
      if (request.draftHost === true) {
        this.draftHosts.set(clientId, ++this.draftReportSequence);
      } else {
        this.draftHosts.delete(clientId);
      }
      this.setPanelKeyboardFocus(
        request.keyboardFocused === true || request.composerFocused,
        clientId,
      );
      const stateBroadcast = this.setPanelState(request.id, request.composerFocused, clientId);
      if (previousNavigation?.clientId !== this.navigation?.clientId && !stateBroadcast) {
        // Only navigation presence/ownership affects intent availability. The
        // token is not in snapshots; updating it must not copy every transcript.
        // Selection/focus changes already broadcast the updated navigation.
        this.server.broadcast();
      }
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

    if (request.action === 'submit-utterance') {
      if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000) {
        throw Error('Enter between 1 and 4000 characters');
      }
      if (typeof request.target !== 'string' || !/^0x[0-9a-f]+$/i.test(request.target)) {
        throw Error('Select an application window before sending');
      }
      if (this.panelKeyboardFocused) {
        throw Error('Release Companion keyboard focus before sending');
      }
      if (!this.pipeline) {
        throw Error('Text input is not ready yet');
      }
      // Explicit text works while the microphone is paused. It joins the same
      // bounded FIFO; capture and delivery still reject a changed application.
      if (!this.pipeline.submitText(request.text, this.signal, request.target)) {
        throw Error('The utterance queue is full or stopping; try again shortly');
      }
      return 'queued';
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

    if (request.action === 'agent-models') {
      if (!this.options.agents) {
        throw Error('Agent sessions are unavailable');
      }
      // Coalesce concurrent UI refreshes into one bounded Pi discovery process.
      if (!this.modelDiscovery) {
        this.modelDiscovery = this.options.agents.models(this.signal).finally(() => {
          this.modelDiscovery = undefined;
        });
      }
      return this.modelDiscovery;
    }

    // A static allowlist plus one configuration read: no discovery process to
    // coalesce, and independent of Pi so a Pi failure cannot block Claude.
    if (request.action === 'claude-models') {
      if (!this.options.agents) {
        throw Error('Agent sessions are unavailable');
      }
      return this.options.agents.claudeModels();
    }

    if (request.action === 'set-agent-model') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.model !== 'string' ||
        request.model.length > 300
      ) {
        throw Error('Expected a conversation and configured model identifier');
      }
      if (this.options.preview) {
        return 'preview';
      }
      await this.options.agents.setModel(request.id, request.model, this.signal);
      return 'model-selected';
    }

    if (request.action === 'set-agent-thinking') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.thinking !== 'string'
      ) {
        throw Error('Expected a conversation and effort level');
      }
      if (this.options.preview) {
        return 'preview';
      }
      await this.options.agents.setThinking(request.id, request.thinking, this.signal);
      return 'thinking-selected';
    }

    if (request.action === 'move-agent') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.beforeId !== 'string' ||
        typeof request.revision !== 'string'
      ) {
        throw Error('Expected a conversation, insertion target and current order revision');
      }
      this.options.agents.move(request.id, request.beforeId, request.revision);
      return 'moved';
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
    this.options.agents?.setDraftHost(undefined);
    this.abandonDrafts(undefined, 'Companion is shutting down.');
    this.ready = false;
    this.speaking = false;
    this.pause.off('change', this.pauseChanged);
    this.options.cleanup?.off('change', this.cleanupChanged);

    try {
      // The pipeline is idle by now; let pending retirements finish while the
      // database and clients are still available.
      await Promise.allSettled([...this.retirements]);
      await this.server.close();
      await this.sounds.close();
    } finally {
      this.history.close();
      await this.databaseLock.close();
    }
  }
}
