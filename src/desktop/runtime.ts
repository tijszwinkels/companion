import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Activity, LabelPreviousResult } from '../core/activity.ts';
import type { CaptureAdmission, CaptureStoragePolicy } from '../capture-storage/policy.ts';
import type { InteractionContext, Log } from '../core/frame.ts';
import { PauseControl } from '../core/pause-control.ts';
import { DeliveryControl } from '../core/delivery-control.ts';
import { failureOutcome } from '../core/delivery-error.ts';
import { activeWindow, type RunCommand } from '../sensors/screen/capture.ts';
import { command } from '../system/command.ts';
import { InstanceLock } from '../system/instance-lock.ts';
import { typeText } from '../system/type-text.ts';
import { UtteranceHistory, type HistoryEntry, type OriginalProblem } from './history.ts';
import { saveEmptyAudioClip } from './empty-audio-clips.ts';
import { DesktopServer, type SnapshotOptions } from './server.ts';
import { SoundFeedback, outcomeSound } from './sounds.ts';
import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { SensorPipeline } from '../core/pipeline.ts';
import { IntentPreferences } from './intent-preferences.ts';
import { CleanupPreference } from './cleanup-preference.ts';
import type { TranscriptionCleanupSetting } from '../core/transcription-cleanup/setting.ts';
import { migrateDesktopStorage } from './storage-migration.ts';
import { ActivityHistory } from './activity-history.ts';
import { agentChoiceStates, type AgentActions } from '../agents/choice-intents.ts';
import type {
  AgentBrowserOpenOutcome,
  AgentBrowserOpenRequest,
  AgentDraftOutcome,
  AgentDraftRequest,
} from '../agents/types.ts';

/** A connected panel must confirm a forwarded draft within this time. */
const draftConfirmationMilliseconds = 5000;

/**
 * A panel answers a browser-open request once the page loaded or failed, or
 * after its own shorter wait (about 8 seconds) with "loading". This bound
 * only covers a panel that never answers.
 */
const browserConfirmationMilliseconds = 15000;

/** Outcomes a panel may report for a browser-open request. */
const browserPanelOutcomes = new Set<AgentBrowserOpenOutcome['outcome']>([
  'loaded',
  'loading',
  'load-failed',
  'superseded',
  'cancelled',
  'refused',
  'not-selected',
  'busy',
  'panel-hidden',
  'unsupported',
]);

/**
 * Actions that act on the desktop itself: the compositor's focused window,
 * keyboard delivery, media playback reports, composer focus, composer
 * drafts and the capture-storage switch. A remote panel (such as the phone
 * gateway) cannot observe or own any of these, so the listener refuses them
 * for remote connections.
 */
const desktopOnlyActions = new Set([
  'paste',
  // Capture storage is a desktop privacy setting; v1 has no remote control.
  'set-capture-storage',
  'submit-utterance',
  'media-playback',
  'composer-focus',
  'agent-draft-result',
  'agent-browser-open-result',
]);

/**
 * A remote panel observes and controls conversations without becoming the
 * desktop's selected conversation. Its selection is private to its connection,
 * so looking at a chat on the phone never redirects desktop dictation, voice
 * navigation, keyboard focus guards or agent drafts.
 */
interface RemoteClient {
  /** Conversation shown by this remote panel, or empty for other pages. */
  selection: string;
  /** Last actions sent to this client, to avoid resending unchanged controls. */
  lastActionsKey: string;
}

/** Shown wherever labeling is refused because capture storage is off. */
const labelingRequiresStorage = 'Labeling requires capture storage';

/**
 * The live utterance database. Capture storage keeps its preference beside
 * it, and needs that location even when the desktop service is disabled.
 */
export function defaultDatabasePath(): string {
  return join(homedir(), 'companion', 'utterances.sqlite');
}

/** No Omarchy types or commands belong here; any local UI can use this service. */
export function desktopPaths(): { database: string; socket: string } {
  const runtime = process.env.XDG_RUNTIME_DIR;

  if (!runtime) {
    throw Error(
      'XDG_RUNTIME_DIR is required for desktop integration; use --no-desktop to disable it',
    );
  }

  return {
    database: defaultDatabasePath(),
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
  // Frames still in progress whose WAV was deliberately not saved because
  // capture storage was off. Such an attempt also owns the whole utterance:
  // there is simply no recording. An I/O failure is in neither set.
  private readonly unrecordedAudio = new Set<number>();
  // Capture-storage admission of each frame still in progress, from its
  // transcript. Every capture write and spoken label rechecks it.
  private readonly frameStorage = new Map<number, CaptureAdmission>();
  // Frames in progress for which capture storage refused a write, and those
  // for which a WAV or PNG was published. A frame that was refused and saved
  // nothing is recorded as "Not saved" once all its writes have settled.
  private readonly refusedCaptures = new Set<number>();
  private readonly savedCaptures = new Set<number>();
  // Originals found missing or corrupt after they were saved (a refused label
  // or history question, or an Activity page refresh). The database keeps
  // what was published; this records what is known to be usable now, so
  // clients stop offering labels and screenshot-dependent actions for them.
  // In memory: each listener run rediscovers losses when they matter.
  private readonly lostOriginals = new Map<string, OriginalProblem>();
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
  // Connections that declared the remote role, keyed by server client ID.
  private readonly remoteClients = new Map<number, RemoteClient>();
  private readonly pendingDrafts = new Map<
    string,
    { clientId: number; finish(outcome: AgentDraftOutcome): void }
  >();
  // Panels with a built-in browser (the standalone native window), by client,
  // with the sequence of their latest panel report, like draft hosts.
  private readonly browserHosts = new Map<number, number>();
  private readonly pendingBrowserOpens = new Map<
    string,
    { clientId: number; finish(outcome: AgentBrowserOpenOutcome): void }
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
      /**
       * The shared capture-storage policy, already loaded. It gates every
       * Activity capture write and all labeling (docs/capture-storage.md).
       */
      captureStorage: CaptureStoragePolicy;
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
      (snapshotOptions) => this.snapshot(snapshotOptions),
      (request, clientId) => this.handle(request, clientId),
      (clientId) => {
        // A remote panel never owned desktop routing state; only forget it.
        if (this.remoteClients.delete(clientId)) {
          return;
        }
        this.draftHosts.delete(clientId);
        this.abandonDrafts(clientId, 'The panel disconnected before confirming the draft.');
        this.browserHosts.delete(clientId);
        this.abandonBrowserOpens(clientId, 'The panel disconnected before confirming.');
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
    options.agents?.setBrowserHost((request, signal) => this.requestBrowserOpen(request, signal));
    this.unsubscribeAgents = options.agents?.subscribe((event) => {
      if (event.type === 'agent-turn-completed') {
        this.sounds.play('agent-completed');
      }
      if (event.type === 'agent-removed' && event.id === this.panelSession) {
        this.setPanelState('', false, this.panelClient);
      }
      // Clients upsert `agent-session` by ID, so a late flush for a closed
      // conversation (for example a rolled-back model choice) would add its
      // tab back. Incremental clients no longer receive the periodic full
      // snapshot that used to remove it again, so never publish that delta.
      if (event.type === 'agent-session' && !options.agents?.has(event.session.id)) {
        return;
      }
      this.server.publish(event);
      this.publishAgentActions();
      this.publishRemoteAgentActions();
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
      captureClock: () => options.captureStorage.time(),
      admitCapture: (capturedFrom) => options.captureStorage.admit(capturedFrom),
      transcribed: (transcript) => {
        if (transcript.storage && !this.frameStorage.has(transcript.id)) {
          this.frameStorage.set(transcript.id, transcript.storage);
        }
        const storage = options.captureStorage.allows(transcript.storage) ? 'on' : 'off';
        this.history.add(transcript, storage);
        this.server.broadcast();
      },
      screenshotCaptured: async (id, screenshot) => {
        const saved = await options.captureStorage.publish(this.frameStorage.get(id), (current) =>
          this.history.saveScreenshot(id, screenshot, current),
        );
        if (saved === 'saved') {
          this.savedCaptures.add(id);
        } else if (saved === undefined) {
          this.refusedCaptures.add(id);
        }
      },
      audioCaptured: async (id, samples) => {
        const saved = await options.captureStorage.publish(this.frameStorage.get(id), (current) =>
          this.history.saveAudio(id, samples, current),
        );
        if (saved === 'saved') {
          this.recordedAudio.add(id);
          this.savedCaptures.add(id);
        } else if (saved === undefined) {
          this.unrecordedAudio.add(id);
          this.refusedCaptures.add(id);
        }
      },
      emptyAudioCaptured: (clip) =>
        options.captureStorage.publish(clip.storage, (current) =>
          saveEmptyAudioClip(dirname(options.database), clip, current),
        ),
      intentRequested: (id, request) => this.history.saveIntentRequest(id, request),
      intentRecognized: (id, intent) => {
        this.history.setIntent(id, intent);
        this.server.broadcast();
      },
      transcriptionCleanup: (id, record) => {
        this.history.saveCleanup(id, record);
        this.server.broadcast();
      },
      labelPrevious: (id, correct) => this.labelPrevious(id, correct),
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

        // Hold its row at once if it already has one: the replaced attempt can
        // still be finishing (for example, a model ignoring cancellation), and
        // no paste, label or question may start from it meanwhile. A row that
        // appears later is held at `finished`.
        const row = this.history.entryId(id);
        if (row) {
          this.history.holdForRetirement(row);
        }
      },
      continuationSettled: (finalId, supersededIds) => {
        this.settleContinuation(finalId, supersededIds);
      },
      finished: (id) => {
        this.frameComposerRevisions.delete(id);
        this.processing.delete(id);
        this.delivery.finish(id);
        this.recordedAudio.delete(id);
        this.unrecordedAudio.delete(id);
        this.frameStorage.delete(id);

        // Every write of this frame has settled (the pipeline awaits them).
        // If storage was turned off before anything was published, say so
        // honestly. A partly saved capture keeps "on"; labeling still needs
        // each of its files and refuses it.
        if (this.refusedCaptures.delete(id) && !this.savedCaptures.has(id)) {
          this.history.markCaptureNotSaved(id);
        }
        this.savedCaptures.delete(id);

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
    this.publishRemoteAgentActions();
  };

  /**
   * Choice and stop controls for one remote client's own selection. Built from
   * the same interaction data and voice-collision rules as the desktop panel,
   * but never from the desktop's selected conversation.
   */
  private remoteAgentActions(selection: string): AgentActions {
    const id = this.options.agents?.has(selection) ? selection : '';
    const interaction: InteractionContext = {
      agentSessionId: id,
      agentComposerFocused: false,
      revision: this.interactionRevision,
      ...(id ? this.options.agents?.interaction(id) : {}),
    };
    return {
      sessionId: id,
      choices: agentChoiceStates({ interaction }, this.router?.reservedPrefixes() ?? []),
      stopRunId: interaction.agentRunId ?? '',
    };
  }

  /** Send each remote client its controls when they change; skip unchanged ones. */
  private publishRemoteAgentActions(onlyClientId?: number): void {
    for (const [clientId, remote] of this.remoteClients) {
      if (onlyClientId !== undefined && clientId !== onlyClientId) {
        continue;
      }

      const actions = this.remoteAgentActions(remote.selection);

      // Choice sets are small and immutable; serializing them is the simplest
      // exact change check, and it runs once per remote client per event.
      const key = JSON.stringify(actions);
      if (key === remote.lastActionsKey) {
        continue;
      }

      remote.lastActionsKey = key;
      this.server.publishTo(clientId, { type: 'remote-agent-actions', actions });
    }
  }

  /**
   * Choice, stop-run and tool-page requests must come from the panel that is
   * showing that conversation. Desktop panels use the global selection;
   * remote panels use their own connection's selection.
   */
  private showsConversation(clientId: number, id: unknown): boolean {
    const remote = this.remoteClients.get(clientId);
    if (remote) {
      return typeof id === 'string' && id !== '' && remote.selection === id;
    }
    return clientId === this.panelClient && id === this.panelSession;
  }

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

      // The CLI loaded the capture-storage choice before constructing this
      // runtime; only publish its later changes.
      this.options.captureStorage.on('change', this.captureStorageChanged);

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

  private readonly captureStorageChanged = () => {
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

  /**
   * The UI state message body. With `sessions: false` (a connection that keeps
   * conversations from incremental agent events), the conversation fields are
   * omitted rather than resent: absence means "unchanged since the connect
   * snapshot and the events that followed it".
   */
  private snapshot(options: SnapshotOptions): object {
    const agents = this.options.agents;
    const conversations = options.sessions
      ? {
          sessions: agents?.snapshot() ?? [],
          sessionOrderRevision: agents?.order().revision ?? '',
          previousSessions: agents?.previousSnapshot() ?? [],
        }
      : {};

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
      history: this.ready ? this.history.snapshot().map((entry) => this.current(entry)) : [],
      activitySessionId: this.activityHistory.sessionId,
      activityHistoryCount: this.activityHistory.count,
      historyDeletionAvailable: !this.options.preview,
      textInputAvailable: Boolean(this.pipeline),
      ...conversations,
      sessionControlsAvailable: Boolean(agents),
      intents: this.router?.intentStates({ interaction: this.interactionContext() }) ?? [],
      // Null hides the switch (no cleanup support in this listener).
      transcriptionCleanup: this.options.cleanup ? { enabled: this.options.cleanup.enabled } : null,
      // Absent in older listeners: clients treat that as unavailable, not off.
      captureStorage: this.options.captureStorage.state,
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
      index >= MAX_OPEN_AGENT_SESSIONS ||
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

  /**
   * Label one entry from its original capture. Refused, with nothing
   * written, while capture storage is off, or when the entry's own capture
   * was not saved or is no longer readable. The policy is checked again
   * after the file checks, at the synchronous write: an Off (even a quick
   * off→on) that happened meanwhile wins.
   */
  private async labelEntry(id: string, correct: boolean, actualIntent?: string | null) {
    const storage = this.options.captureStorage;
    if (!storage.enabled) {
      throw Error(labelingRequiresStorage);
    }
    const generation = storage.generation;

    const unavailable = await this.history.labelingUnavailable(id);
    if (unavailable) {
      this.noteLostOriginal(id, unavailable);
      throw Error(unavailable.reason);
    }

    if (!storage.enabled || storage.generation !== generation) {
      throw Error(labelingRequiresStorage);
    }
    this.history.label(id, correct, actualIntent);
    this.publishFeedback(id);
  }

  /**
   * Spoken "label previous correct/incorrect". Besides the checks of
   * `labelEntry`, the command itself must have been admitted while storage
   * was on, and that admission must still hold: a command spoken while off
   * is never revived by turning storage on before it is routed.
   */
  private async labelPrevious(frameId: number, correct: boolean): Promise<LabelPreviousResult> {
    const storage = this.options.captureStorage;
    const command = this.frameStorage.get(frameId);
    if (!storage.allows(command)) {
      return { outcome: 'skipped', reason: labelingRequiresStorage };
    }

    const target = this.history.previousLabelTarget(frameId);
    if (!target) {
      return { outcome: 'skipped', reason: 'No preceding intent available in history to label' };
    }

    const unavailable = await this.history.labelingUnavailable(target);
    if (unavailable) {
      this.noteLostOriginal(target, unavailable);
      return { outcome: 'skipped', reason: unavailable.reason };
    }

    if (!storage.allows(command)) {
      return { outcome: 'skipped', reason: labelingRequiresStorage };
    }
    this.history.label(target, correct);
    this.publishFeedback(target);
    return { outcome: 'labeled', id: target };
  }

  private publishActivity(entry: HistoryEntry): void {
    this.server.publish({
      type: 'activity-entry',
      sessionId: this.activityHistory.sessionId,
      entry: this.activityHistory.update(this.current(entry), this.history.feedback(entry.id)),
    });
  }

  /** An entry as clients should see it now, including originals found lost. */
  private current(entry: HistoryEntry): HistoryEntry {
    const lost = this.lostOriginals.get(entry.id);
    if (!lost) {
      return entry;
    }
    return {
      ...entry,
      labelingUnavailable: entry.labelingUnavailable ?? lost.reason,
      screenshotUnavailable: entry.screenshotUnavailable || lost.screenshot,
    };
  }

  /**
   * An original turned out to be missing or unusable. Remember it and update
   * this run's Activity card at once, so fresh pages and other clients stop
   * offering labels (and, without a screenshot, history questions). A
   * problem the database already records needs no extra entry.
   */
  private noteLostOriginal(id: string, problem: OriginalProblem | undefined): void {
    const entry = this.history.find(id);
    if (!entry) {
      return;
    }
    // Keep publication provenance in the database. This cache holds only
    // the result of checking the originals now; a restored usable file can
    // clear a former loss on the next explicit page refresh.
    const lost = problem?.reason === entry.labelingUnavailable ? undefined : problem;
    const known = this.lostOriginals.get(id);
    if (known?.reason === lost?.reason && known?.screenshot === lost?.screenshot) {
      return;
    }
    if (lost) {
      this.lostOriginals.set(id, lost);
    } else {
      this.lostOriginals.delete(id);
    }
    if (this.activityHistory.has(id)) {
      this.publishActivity(entry);
    }
  }

  /**
   * The final attempt of a continued utterance has settled, just before its
   * own `finished`. Its superseded predecessors are retired only when the final
   * attempt owns the whole utterance: its row exists and its WAV, which
   * contains every earlier part's raw audio, was published, or was
   * deliberately not saved because capture storage was off. In that case
   * there is no recording to own, and the final row is still the one record
   * of the utterance; a predecessor's files from before an Off are removed
   * with it, like any superseded attempt's. Its outcome does
   * not matter; an error, cancellation or ignored result is the record the
   * user recovers from, including the pipeline's recovered-failure record with
   * the earlier words. A fresh PNG is not required: without one, the earlier
   * screen is lost with its attempt rather than attached to the final record.
   * If the final attempt does not own the utterance (its WAV or row could not
   * be written), the predecessors are kept as explicit residual rows.
   */
  private settleContinuation(finalId: number, supersededIds: readonly number[]): void {
    const owned =
      this.history.entryId(finalId) !== undefined &&
      (this.recordedAudio.has(finalId) || this.unrecordedAudio.has(finalId));

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
      entry: this.activityHistory.update(this.current(entry), this.history.feedback(id)),
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

  /**
   * The native panel that shows web pages: the visible navigation owner if it
   * has a browser, otherwise the browser panel that reported most recently.
   * Remote panels never report one, so they are never asked.
   */
  private browserClient(): number | undefined {
    const visible = this.navigation?.clientId;
    if (visible !== undefined && this.browserHosts.has(visible)) {
      return visible;
    }
    let newest: number | undefined;
    let newestSequence = -1;
    for (const [clientId, sequence] of this.browserHosts) {
      if (sequence > newestSequence) {
        newest = clientId;
        newestSequence = sequence;
      }
    }
    return newest;
  }

  /**
   * Ask one native panel to show a web page for the calling conversation and
   * wait for its explicit answer. The request is a one-time event, never part
   * of snapshots, so reconnects cannot replay it. Once sent, timeout,
   * disconnect or turn cancellation are `unconfirmed`. Never retried.
   */
  private requestBrowserOpen(
    request: AgentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<AgentBrowserOpenOutcome> {
    if (signal.aborted) {
      return Promise.resolve({ outcome: 'offline', reason: 'The agent turn has ended.' });
    }
    const clientId = this.browserClient();
    if (clientId === undefined) {
      // A connected panel without a browser (Quickshell, an older UI) is not
      // the same as no panel at all.
      if (this.draftHosts.size > 0) {
        return Promise.resolve({
          outcome: 'unsupported',
          reason: 'The connected Companion panel has no built-in browser.',
        });
      }
      return Promise.resolve({ outcome: 'offline', reason: '' });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (outcome: AgentBrowserOpenOutcome) => {
        if (!this.pendingBrowserOpens.delete(requestId)) {
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
            reason: 'The panel did not answer within 15 seconds.',
          }),
        browserConfirmationMilliseconds,
      );
      const cancelled = () =>
        finish({
          outcome: 'unconfirmed',
          reason: 'The agent turn ended before the panel answered.',
        });

      this.pendingBrowserOpens.set(requestId, { clientId, finish });
      signal.addEventListener('abort', cancelled, { once: true });

      const sent = this.server.publishTo(clientId, {
        type: 'agent-browser-open',
        requestId,
        id: request.sessionId,
        url: request.url,
      });
      if (!sent) {
        finish({ outcome: 'offline', reason: 'The panel disconnected.' });
      }
    });
  }

  private abandonBrowserOpens(clientId: number | undefined, reason: string): void {
    for (const pending of [...this.pendingBrowserOpens.values()]) {
      if (clientId === undefined || pending.clientId === clientId) {
        pending.finish({ outcome: 'unconfirmed', reason });
      }
    }
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
    const remote = this.remoteClients.get(clientId);

    if (request.action === 'client-role') {
      // Declared once, before any other report, so this connection never
      // becomes a desktop selection, navigation owner or draft host.
      if (request.role !== 'remote') {
        throw Error('Expected role "remote"');
      }
      if (remote) {
        return 'role-recorded';
      }
      if (
        this.panelClient === clientId ||
        this.composerClient === clientId ||
        this.navigation?.clientId === clientId ||
        this.draftHosts.has(clientId) ||
        this.browserHosts.has(clientId) ||
        this.mediaClients.has(clientId)
      ) {
        throw Error('Declare the remote role before reporting desktop panel state');
      }
      this.remoteClients.set(clientId, { selection: '', lastActionsKey: '' });
      this.publishRemoteAgentActions(clientId);
      return 'role-recorded';
    }

    if (remote && typeof request.action === 'string' && desktopOnlyActions.has(request.action)) {
      throw Error('This action is only available on the desktop');
    }

    if (request.action === 'start-agent') {
      if (!remote) {
        throw Error('Only remote panels start typed conversations this way');
      }
      if (!this.options.agents) {
        throw Error('Agent sessions are unavailable');
      }
      if (typeof request.text !== 'string') {
        throw Error('Enter between 1 and 4000 characters');
      }
      if (request.profile !== 'coding' && request.profile !== 'quickQuestion') {
        throw Error('Expected profile "coding" or "quickQuestion"');
      }
      if (this.options.preview) {
        return 'preview';
      }
      const id = this.options.agents.startRemote(request.text, request.profile, this.signal);
      return { outcome: 'started', id };
    }

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

    if (request.action === 'agent-history-page') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.epoch !== 'string' ||
        typeof request.requestId !== 'string' ||
        request.requestId.length > 128 ||
        !['before', 'after'].includes(request.direction as string) ||
        !Number.isSafeInteger(request.index) ||
        !Number.isSafeInteger(request.offset) ||
        (request.anchor !== undefined &&
          (typeof request.anchor !== 'string' || request.anchor.length > 200))
      ) {
        throw Error('Expected a conversation, epoch and history position');
      }
      if (!this.showsConversation(clientId, request.id)) {
        throw Error('This conversation is no longer selected');
      }
      return this.options.agents.historyPage({
        id: request.id,
        epoch: request.epoch,
        direction: request.direction as 'before' | 'after',
        index: request.index as number,
        offset: request.offset as number,
        anchor: request.anchor as string | undefined,
      });
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
      if (!this.showsConversation(clientId, request.id)) {
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
      const after = request.after as number;
      const through = request.through as number;

      // Refresh what this page says about originals: a saved file that has
      // since disappeared or become corrupt must not keep offering labels
      // or questions. Validate one bounded original at a time, only on an
      // explicit page read; no watcher or repeated microphone-state scan.
      const page = this.activityHistory.page(after, through);
      for (const entry of page.entries) {
        if ('deleted' in entry) {
          continue;
        }
        const problem = await this.history.labelingUnavailable(entry.id);
        this.noteLostOriginal(entry.id, problem);
      }
      return this.activityHistory.page(after, through);
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
        await this.labelEntry(
          request.id,
          request.correct,
          request.actualIntent as string | null | undefined,
        );
        return 'labeled';
      }
      if (!this.options.agents) {
        throw Error('Coding sessions are unavailable');
      }
      if (this.options.preview) {
        return 'preview';
      }
      // Decide the conversation screenshot copy now, before the asynchronous
      // read: a request made while capture storage was off stays unsaved even
      // if storage is turned on before the read completes.
      const storage = this.options.captureStorage.admit();
      let recorded: Awaited<ReturnType<UtteranceHistory['recordedFrame']>>;
      try {
        recorded = await this.history.recordedFrame(request.id);
      } catch (error) {
        // A missing or invalid original screenshot: stop offering this.
        const message = error instanceof Error ? error.message : String(error);
        if (/screenshot/i.test(message)) {
          this.noteLostOriginal(request.id, { reason: message, screenshot: true });
        }
        throw error;
      }
      const frame = { ...recorded, storage };
      // A phone may reuse the saved frame, but must not redirect desktop focus.
      this.options.agents.start(frame, this.signal, 'coding', undefined, Boolean(remote));
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

    if (request.action === 'set-capture-storage') {
      // Strictly a boolean; anything else is refused without a change.
      if (typeof request.enabled !== 'boolean') {
        throw Error('Expected a boolean capture storage state');
      }
      const enabled = request.enabled;
      await this.options.captureStorage.setEnabled(enabled);
      this.log(
        'capture-storage',
        enabled
          ? 'Saving captured audio and screenshots'
          : 'Captured audio and screenshots not saved',
      );
      return enabled ? 'capture-storage-enabled' : 'capture-storage-disabled';
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

    if (request.action === 'agent-browser-open-result') {
      if (
        typeof request.requestId !== 'string' ||
        typeof request.outcome !== 'string' ||
        !browserPanelOutcomes.has(request.outcome as AgentBrowserOpenOutcome['outcome']) ||
        (request.reason !== undefined &&
          (typeof request.reason !== 'string' || request.reason.length > 600)) ||
        (request.url !== undefined &&
          (typeof request.url !== 'string' || request.url.length > 4096))
      ) {
        throw Error('Expected a browser request id and outcome');
      }
      // Only the panel that was asked can answer; a late answer is refused.
      const pending = this.pendingBrowserOpens.get(request.requestId);
      if (!pending || pending.clientId !== clientId) {
        throw Error('This browser request has expired');
      }
      const outcome: AgentBrowserOpenOutcome = {
        outcome: request.outcome as AgentBrowserOpenOutcome['outcome'],
        reason: (request.reason as string | undefined) ?? '',
      };
      // Page text (such as its title) is never forwarded to the agent.
      if (typeof request.url === 'string' && request.url) {
        outcome.url = request.url;
      }
      pending.finish(outcome);
      return 'browser-recorded';
    }

    if (request.action === 'panel-state' && remote) {
      // Remote panels report only which conversation they show. Focus,
      // navigation and draft fields describe the desktop and are ignored.
      if (
        typeof request.id !== 'string' ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw Error('Expected a visible agent session id (or empty id)');
      }
      remote.selection = request.id;
      this.publishRemoteAgentActions(clientId);
      return 'panel-recorded';
    }

    if (request.action === 'panel-state') {
      if (
        typeof request.id !== 'string' ||
        (request.draftHost !== undefined && typeof request.draftHost !== 'boolean') ||
        (request.browserHost !== undefined && typeof request.browserHost !== 'boolean') ||
        (request.visible !== undefined && typeof request.visible !== 'boolean') ||
        (request.navigationToken !== undefined &&
          (typeof request.navigationToken !== 'string' || request.navigationToken.length > 128)) ||
        typeof request.composerFocused !== 'boolean' ||
        (request.keyboardFocused !== undefined && typeof request.keyboardFocused !== 'boolean') ||
        (request.incrementalSessions !== undefined &&
          typeof request.incrementalSessions !== 'boolean') ||
        (!request.id && request.composerFocused) ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw Error('Expected a visible agent session id (or empty id) and composerFocused');
      }
      // Clients that apply agent-session/order/history/removed/restored events
      // to retained conversations say so once; routine state messages to them
      // then omit transcripts. Older adapters keep receiving full snapshots.
      if (request.incrementalSessions === true) {
        this.server.enableIncrementalSessions(clientId);
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
      // Only the standalone native window has the built-in browser.
      if (request.browserHost === true) {
        this.browserHosts.set(clientId, ++this.draftReportSequence);
      } else {
        this.browserHosts.delete(clientId);
        this.abandonBrowserOpens(clientId, 'The panel no longer offers its browser.');
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
      if (!this.showsConversation(clientId, request.id)) {
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
        !this.showsConversation(clientId, request.id) ||
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

    if (request.action === 'cancel-agent-wake') {
      if (remote) {
        throw Error('Timer controls require the native desktop');
      }
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.timerId !== 'string'
      ) {
        throw Error('Expected a conversation and timer ID');
      }
      return String(this.options.agents.cancelWake(request.id, request.timerId).outcome);
    }

    if (
      request.action === 'stop-agent' ||
      request.action === 'close-agent' ||
      request.action === 'reopen-agent'
    ) {
      if (!this.options.agents || typeof request.id !== 'string') {
        throw Error('Expected an agent session id');
      }
      let cancelledTimers = 0;
      if (request.action === 'close-agent') {
        cancelledTimers = await this.options.agents.remove(request.id);
      } else if (request.action === 'reopen-agent') {
        await this.options.agents.reopen(request.id, !remote);
        return 'reopened';
      } else {
        cancelledTimers = await this.options.agents.stop(request.id);
      }
      const outcome = request.action === 'close-agent' ? 'closed' : 'stopped';
      return cancelledTimers ? `${outcome}; cancelled ${cancelledTimers} pending timers` : outcome;
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
    this.options.agents?.setBrowserHost(undefined);
    this.abandonBrowserOpens(undefined, 'Companion is shutting down.');
    this.ready = false;
    this.speaking = false;
    this.pause.off('change', this.pauseChanged);
    this.options.cleanup?.off('change', this.cleanupChanged);
    this.options.captureStorage.off('change', this.captureStorageChanged);

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
