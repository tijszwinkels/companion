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
import {
  activePopout,
  chooseVoiceTarget,
  followNavigationSelection,
  nativeFocusKey,
  nativeViewKey,
  parseNativeViewReport,
  startNavigationSelection,
  type ConnectionView,
  type NativeViewRecord,
  type NavigationSelection,
  type VoiceTarget,
} from './native-views.ts';
import { SoundFeedback, outcomeSound } from './sounds.ts';
import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import { MAX_DIRECT_USER_MESSAGE_LENGTH } from '../agents/message-limits.ts';
import type { AgentSessions } from '../agents/sessions.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { SensorPipeline } from '../core/pipeline.ts';
import type { ComputerMicrophoneSwitch } from '../sensors/audio/computer-microphone.ts';
import type { BrowserMicrophones, BrowserStreamEnd } from '../sensors/audio/browser-microphones.ts';
import type {
  DictationAppendRequest,
  DictationAppendResult,
  DictationController,
  DictationSummary,
} from '../core/dictation/controller.ts';
import { IntentPreferences } from './intent-preferences.ts';
import { CleanupPreference } from './cleanup-preference.ts';
import type { TranscriptionCleanupSetting } from '../core/transcription-cleanup/setting.ts';
import { migrateDesktopStorage } from './storage-migration.ts';
import { ActivityHistory } from './activity-history.ts';
import { DraftStore, type DraftChange } from './draft-store.ts';
import { agentChoiceStates, type AgentActions } from '../agents/choice-intents.ts';
import {
  agentHarnesses,
  type AgentBrowserOpenOutcome,
  type AgentBrowserOpenRequest,
  type AgentDraftOutcome,
  type AgentDraftRequest,
  type AgentHarness,
} from '../agents/types.ts';
import {
  presentPanelOutcomes,
  type AgentPresentOutcome,
  type AgentPresentRequest,
  type PresentPanelOutcome,
} from '../agents/session-presentation.ts';

/** The recording panel must confirm each appended transcript chunk within this time. */
const recordingAppendConfirmationMilliseconds = 5000;

/**
 * A panel answers a browser-open request once the page loaded or failed, or
 * after its own shorter wait (about 8 seconds) with "loading". This bound
 * only covers a panel that never answers.
 */
const browserConfirmationMilliseconds = 15000;

/**
 * A native panel answers a pop-out/return request once its window exists (or
 * is gone) and it has waited briefly for activation. This bound only covers
 * a panel that never answers.
 */
const presentConfirmationMilliseconds = 15000;

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
 * Validate a native panel's `agent-present-result` and convert it to the
 * caller's outcome. Only the panel's own outcomes are accepted: `offline` and
 * `unconfirmed` are decided by the listener, never claimed by a panel.
 */
function presentResult(request: Record<string, unknown>): AgentPresentOutcome {
  const keys = Object.keys(request);
  const known = ['action', 'requestId', 'outcome', 'reason', 'focused'];
  if (
    keys.some((key) => !known.includes(key)) ||
    typeof request.requestId !== 'string' ||
    request.requestId.length > 128 ||
    typeof request.outcome !== 'string' ||
    !presentPanelOutcomes.includes(request.outcome as PresentPanelOutcome) ||
    (request.reason !== undefined &&
      (typeof request.reason !== 'string' || request.reason.length > 300))
  ) {
    throw Error('Expected a presentation request id and outcome');
  }

  const outcome = request.outcome as PresentPanelOutcome;
  const reason = (request.reason as string | undefined) ?? '';

  if (outcome === 'shown' || outcome === 'returned') {
    // The panel must say whether it observed focus; requesting activation
    // is not the same as the compositor granting it.
    if (typeof request.focused !== 'boolean') {
      throw Error('Expected focused: true or false with a shown/returned outcome');
    }
    return { outcome, focused: request.focused, reason };
  }

  if (request.focused !== undefined) {
    throw Error('Only shown/returned outcomes report focus');
  }
  return { outcome, reason };
}

/**
 * Actions that act on the desktop itself: the compositor's focused window,
 * keyboard delivery, media playback reports, composer focus, agent-draft
 * answers, the capture-storage switch and the defaults for new sessions. A
 * remote panel (such as the phone gateway) cannot observe or own any of
 * these, so the listener refuses them for remote connections. (`draft-set`
 * is checked where it is handled: a remote draft host may write drafts.
 * `set-application-chat-read`/`-send` have their own rule for remote
 * connections, see `checkRemotePermissionChange`.)
 */
const desktopOnlyActions = new Set([
  'paste',
  // Capture storage is a desktop privacy setting; v1 has no remote control.
  'set-capture-storage',
  // Only the desktop Activity page shows the defaults for new sessions.
  'coding-defaults',
  'set-coding-defaults',
  'submit-utterance',
  'media-playback',
  'composer-focus',
  'agent-draft-result',
  'agent-browser-open-result',
  // Pop-out windows are native desktop windows.
  'agent-present-result',
  // Manual recording uses the desktop microphone and a desktop composer.
  'start-recording',
  'stop-recording',
  'recording-append-result',
]);

/** The start of every refusal of a listener started without a desktop. */
const withoutDesktop = 'This Companion runs without a desktop';

/**
 * Requests that need the computer's own desktop, refused for every client
 * (desktop or remote) when the listener runs without one (`--headless`, see
 * "Running without a desktop" in src/desktop/README.md). Each refusal says
 * plainly what this Companion cannot do, so a panel shows it as the reason.
 * Checked before the remote rule above, so a paired browser hears why too.
 * Without `--headless` this table is never consulted.
 */
const withoutDesktopRefusals: ReadonlyMap<string, string> = new Map([
  // Pause and Resume are not here: whether anything can listen is decided
  // in one place, `nothingCanListen`.
  ['set-computer-microphone', `${withoutDesktop} and has no microphone of its own.`],
  ['start-recording', `${withoutDesktop} and has no microphone to record with.`],
  ['stop-recording', `${withoutDesktop} and has no microphone to record with.`],
  ['recording-append-result', `${withoutDesktop} and has no microphone to record with.`],
  // No speakers: sound feedback stays off.
  ['toggle-sounds', `${withoutDesktop} and has no sound feedback.`],
  // No compositor: no focused application to type into, no media to follow.
  ['paste', `${withoutDesktop}: it cannot type into applications.`],
  ['submit-utterance', `${withoutDesktop}: it cannot type into applications.`],
  ['media-playback', `${withoutDesktop}: it does not pause for media playback.`],
]);

/**
 * A remote panel observes and controls conversations without becoming the
 * desktop's selected conversation. Its selection is private to its connection,
 * so looking at a chat on the phone never redirects desktop dictation, voice
 * navigation, keyboard focus guards or an agent draft's `focus`. A remote
 * panel may still be a draft host (see `draftHosts`): it then reads and
 * writes the same drafts as desktop editors.
 */
interface RemoteClient {
  /** Conversation shown by this remote panel, or empty for other pages. */
  selection: string;
  /**
   * The selection while this panel's latest report said `visible: true`,
   * else empty. Only this counts as showing a conversation for the unread
   * mark. A closed conversation is forgotten here and in `selection`, so a
   * stale report neither shows nor controls it after it is reopened.
   */
  visibleSelection: string;
  /** Last actions sent to this client, to avoid resending unchanged controls. */
  lastActionsKey: string;
}

/**
 * The listener's microphones, attached in live microphone mode only
 * (`connectMicrophones`). See src/sensors/audio/README.md.
 */
export interface ListenerMicrophones {
  /** The computer's microphone switch (D8). */
  computer: ComputerMicrophoneSwitch;
  /** Listening browsers' streams. */
  browsers: BrowserMicrophones;
}

/**
 * The microphones in the listener's state (`microphones`), absent in other
 * modes and in older listeners. See src/desktop/README.md, "Microphones and listening browsers".
 */
export interface MicrophonesState {
  /** The computer's microphone switch is on. */
  computer: boolean;
  /**
   * The microphones that listen now, the computer's first: empty while
   * paused, and when the computer's is switched off and no browser listens
   * (Companion then hears nothing).
   */
  listening: { id: string; kind: 'computer' | 'browser'; name: string }[];
  /** A remote connection may open an audio stream (`audio-start`). */
  streams: boolean;
}

/** The computer's microphone in `MicrophonesState.listening`. */
const computerMicrophoneEntry = { id: 'computer', kind: 'computer', name: 'Computer' } as const;

/**
 * Largest `audio-chunk` piece, in bytes of 16-bit samples: 8 KiB, the
 * gateway's own bound (`maximumAudioChunkBytes` in src/remote/protocol.ts),
 * 256 ms of sound. Its base64 text is at most 10,924 characters.
 */
const maximumAudioChunkBytes = 8 * 1024;

/** Strict base64: whole groups of four, padding only at the end. */
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Longest device name an `audio-start` may carry (the gateway's pairing bound is lower). */
const maximumMicrophoneNameLength = 100;

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
  // Desktop connections whose latest panel-state said `visible: true`. Only
  // their main view and pop-out windows show a conversation for the unread
  // mark (see showsVisibly); a report without `visible` counts as hidden.
  private readonly visibleDesktopClients = new Set<number>();
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
  // Draft hosts: connections whose latest panel report said `draftHost: true`,
  // with that report's sequence. Desktop editors and remote panels (a
  // gateway connection whose client asked for drafts) alike read and write
  // drafts; only a desktop host is ever asked to show a conversation
  // (`desktopDraftClient`).
  private readonly draftHosts = new Map<number, number>();
  // The authoritative unsent text of every conversation's text box (last
  // received write wins). Read and written only by the draft hosts: trusted
  // desktop editors and remote panels whose client asked for drafts; never
  // sent to other remote panels or to applications.
  private readonly drafts = new DraftStore((id) => this.knownConversation(id));
  // Per draft host, desktop or remote: the conversation whose send awaits
  // its reply there (reported in panel-state). Agent drafts for it are
  // refused meanwhile, as the editor itself did when it owned drafts.
  private readonly pendingDraftSends = new Map<number, string>();
  private draftReportSequence = 0;
  // Connections that declared the remote role, keyed by server client ID.
  private readonly remoteClients = new Map<number, RemoteClient>();
  // Desktop connections that reported panel state, with the fingerprint of
  // the `agent-view-actions` last sent to each (see publishViewAgentActions).
  private readonly viewActionKeys = new Map<number, string>();
  private readonly pendingDrafts = new Map<
    string,
    { clientId: number; finish(outcome: AgentDraftOutcome): void }
  >();
  // Manual recording into a conversation's text box; absent outside
  // microphone mode. Appends still waiting for the owning panel's answer.
  private dictation?: DictationController;
  // The computer's microphone switch and listening browsers; absent outside
  // microphone mode.
  private microphones?: ListenerMicrophones;
  // This run's Activity entries heard by a browser's microphone, by entry ID:
  // the device name shown with the entry. The computer's speech and typed
  // text have none.
  private readonly entryMicrophones = new Map<string, string>();
  private readonly pendingRecordingAppends = new Map<
    string,
    { clientId: number; finish(result: DictationAppendResult): void }
  >();
  // Panels with a built-in browser (the standalone native window), by client,
  // with the sequence of their latest panel report, like draft hosts.
  private readonly browserHosts = new Map<number, number>();
  private readonly pendingBrowserOpens = new Map<
    string,
    { clientId: number; finish(outcome: AgentBrowserOpenOutcome): void }
  >();
  // Native panels that can pop conversations out into their own windows, by
  // client, with their latest validated pop-out report (native-views.ts).
  // Only desktop connections that declared `popoutHost` appear here.
  private readonly nativeViews = new Map<number, NativeViewRecord>();
  // The conversation most recently chosen by voice navigation and shown,
  // while that choice lasts; it is the voice target first. A navigation
  // dispatched but not shown yet waits beside it in `pendingNavigation` and
  // replaces it only once shown (native-views.ts).
  private navigationSelection?: NavigationSelection;
  private pendingNavigation?: NavigationSelection;
  private readonly pendingPresents = new Map<
    string,
    {
      clientId: number;
      presentation: AgentPresentRequest['presentation'];
      finish(outcome: AgentPresentOutcome): void;
    }
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
      /**
       * Started without a desktop (`--headless`): no sound feedback, no
       * typing into applications, no microphone of the computer, no panel
       * browser and no pop-out windows. Each of these is refused with a
       * plain reason (`withoutDesktopRefusals`); conversations, their store,
       * widgets and the control socket work as usual. Absent: the desktop.
       */
      headless?: boolean;
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
    this.sounds = new SoundFeedback(
      log,
      signal,
      options.sounds && !options.preview && !options.headless,
      run,
    );
    this.server = new DesktopServer(
      options.socket,
      (snapshotOptions) => this.snapshot(snapshotOptions),
      (request, clientId) => this.handle(request, clientId),
      (clientId) => {
        // A remote panel never owned desktop routing state; only forget it,
        // and the draft hosting and pending send it may have reported.
        if (this.remoteClients.delete(clientId)) {
          this.draftHosts.delete(clientId);
          this.pendingDraftSends.delete(clientId);
          // A closed connection (its page closed, the gateway lost it or
          // revoked its device) ends its audio stream and listening period.
          this.microphones?.browsers.stop(clientId, 'disconnected');
          return;
        }
        this.viewActionKeys.delete(clientId);
        this.visibleDesktopClients.delete(clientId);
        this.draftHosts.delete(clientId);
        this.pendingDraftSends.delete(clientId);
        this.abandonDrafts(clientId, 'The panel disconnected before confirming the draft.');
        this.browserHosts.delete(clientId);
        this.abandonBrowserOpens(clientId, 'The panel disconnected before confirming.');
        // Its pop-out windows went with it. A request already sent may have
        // been carried out, so it is unconfirmed rather than offline.
        this.abandonPresents(clientId, 'The panel disconnected before answering.');
        const viewsRemoved = this.forgetNativeViews(clientId);
        // A recording belongs to the panel that started it. Its words can
        // only go to that panel's draft, so stop and deliver nothing more.
        this.abandonRecordingAppends(clientId, 'The panel disconnected before confirming.');
        if (this.dictation?.ownedBy(clientId)) {
          this.dictation.abandon('disconnected');
        }
        const navigationRemoved = this.navigation?.clientId === clientId;
        if (navigationRemoved) {
          this.navigation = undefined;
        }
        this.followNavigationSelection();
        this.setPanelKeyboardFocus(false, clientId);
        if (this.mediaClients.delete(clientId)) {
          this.pause.setMediaPlaying(this.mediaClients.size > 0);
        }

        let stateBroadcast = false;
        if (clientId === this.panelClient) {
          stateBroadcast = this.setPanelState('', '', clientId, false);
        }
        if (clientId === this.composerClient) {
          this.setComposerFocus('', 0);
          this.server.broadcast();
          stateBroadcast = true;
        }

        if ((navigationRemoved || viewsRemoved) && !stateBroadcast) {
          // Activity/Previous owns navigation without a selected conversation.
          // Otherwise the conversation cleanup already published this change.
          this.server.broadcast();
        }
      },
    );
    options.agents?.setDraftHost((request, signal) => this.requestDraft(request, signal));
    this.drafts.subscribe((change) => this.publishDraft(change));
    options.agents?.setBrowserHost((request, signal) => this.requestBrowserOpen(request, signal));
    options.agents?.setPresentationHost({
      available: () => this.nativeViews.size > 0,
      present: (request, signal) => this.requestPresent(request, signal),
    });
    options.agents?.setViewers({ showsVisibly: (id) => this.showsVisibly(id) });
    this.unsubscribeAgents = options.agents?.subscribe((event) => {
      if (event.type === 'agent-turn-completed') {
        this.sounds.play('agent-completed');
      }
      if (event.type === 'agent-removed' && event.id === this.panelSession) {
        this.setPanelState('', '', this.panelClient, false);
      }
      // A closed conversation no longer has a window, even before the panel
      // reports so; an utterance captured for it must not stay current.
      if (event.type === 'agent-removed') {
        this.removeFromNativeViews(event.id);
        // A remote panel that still reports the closed conversation neither
        // shows it nor controls it once it is reopened; it has to report it
        // again (its controls are republished below).
        for (const remote of this.remoteClients.values()) {
          if (remote.selection === event.id) {
            remote.selection = '';
          }
          if (remote.visibleSelection === event.id) {
            remote.visibleSelection = '';
          }
        }
        // A conversation reopened later (same ID) is not chosen again.
        if (this.navigationSelection?.id === event.id) {
          this.endNavigationSelection();
        }
        if (this.pendingNavigation?.id === event.id) {
          this.pendingNavigation = undefined;
        }
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
      this.publishViewAgentActions();
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
        context.agentSessionId === (this.voiceTarget()?.id ?? '') &&
        this.options.agents?.has(context.agentSessionId) === true,
      selectSession: (context, index) => this.navigateToSession(context, index, 'sidebar'),
      popOutSession: (context, index) => this.navigateToSession(context, index, 'window'),
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
        this.rememberMicrophone(transcript.id, transcript.microphone);
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
    this.publishViewAgentActions();
    this.publishRemoteAgentActions();
  };

  /**
   * Choice and stop controls for one open conversation, independent of which
   * conversation is the voice target. Built from the same interaction data
   * (busy, closing, global running capacity, current run) and voice-collision
   * rules as the voice projection in agentActions(). An unknown or empty id
   * yields an empty set.
   */
  private conversationAgentActions(selection: string): AgentActions {
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

  /**
   * The open conversations one desktop connection shows: its main view's
   * conversation while it owns the panel selection, then its own visible
   * pop-out windows. This is exactly the set `showsConversation` accepts.
   */
  private viewConversationIds(clientId: number): string[] {
    const ids: string[] = [];

    if (clientId === this.panelClient && this.panelSession) {
      ids.push(this.panelSession);
    }

    for (const popout of this.nativeViews.get(clientId)?.report.popouts ?? []) {
      if (!ids.includes(popout.id)) {
        ids.push(popout.id);
      }
    }

    return ids.filter((id) => this.options.agents?.has(id) === true);
  }

  /**
   * Everything the view controls of these conversations are derived from,
   * without their potentially long descriptions. Choice sets are immutable
   * and identified by their revision; collision reasons change only with the
   * routing revision. Equal fingerprints therefore mean equal controls, so
   * streamed tokens do not rebuild or serialize every choice set.
   */
  private viewActionFingerprint(ids: readonly string[]): string {
    const conversations = ids.map((id) => {
      const interaction = this.options.agents?.interaction(id);
      return [
        id,
        interaction?.agentChoices?.revision ?? '',
        interaction?.agentRunId ?? '',
        interaction?.agentFollowUpUnavailableReason ?? '',
      ];
    });
    return JSON.stringify([this.routingRevision, conversations]);
  }

  /**
   * Controls for the conversations one desktop connection shows (from
   * viewConversationIds), so a view never displays a choice whose click would
   * be refused on visibility grounds. At most one main view plus
   * `maximumPopouts` windows.
   *
   * No entry claims a label is speakable: that depends on the voice target,
   * which only the singular `agent-actions` describes. `voiceReason` keeps
   * only why an unavailable choice cannot be selected (busy, closing, the
   * running limit), for the view's tooltip.
   */
  private viewAgentActions(ids: readonly string[]): AgentActions[] {
    const actions: AgentActions[] = [];

    for (const id of ids) {
      const conversation = this.conversationAgentActions(id);
      const unavailableReason =
        this.options.agents?.interaction(id).agentFollowUpUnavailableReason ||
        'Available when the agent finishes';

      actions.push({
        ...conversation,
        choices: conversation.choices.map((choice) => ({
          ...choice,
          voiceAvailable: false,
          voiceReason: choice.available ? '' : unavailableReason,
        })),
      });
    }

    return actions;
  }

  /**
   * Send each desktop connection the controls of the conversations it shows,
   * skipping unchanged ones. Connections join on their first desktop
   * `panel-state` report, so they always receive one projection (possibly
   * empty) and can tell it apart from an older listener that sends none.
   * Remote connections are never included: they receive only their own
   * `remote-agent-actions`, and the gateway also refuses this event.
   */
  private publishViewAgentActions(): void {
    for (const [clientId, previousKey] of this.viewActionKeys) {
      if (this.remoteClients.has(clientId)) {
        continue;
      }

      const ids = this.viewConversationIds(clientId);
      const key = this.viewActionFingerprint(ids);
      if (key === previousKey) {
        continue;
      }

      this.viewActionKeys.set(clientId, key);
      this.server.publishTo(clientId, {
        type: 'agent-view-actions',
        actions: this.viewAgentActions(ids),
      });
    }
  }

  /** Send each remote client its controls when they change; skip unchanged ones. */
  private publishRemoteAgentActions(onlyClientId?: number): void {
    for (const [clientId, remote] of this.remoteClients) {
      if (onlyClientId !== undefined && clientId !== onlyClientId) {
        continue;
      }

      // A remote client's controls follow its own selection, never the desktop's.
      const actions = this.conversationAgentActions(remote.selection);

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
   * The conversations some connection shows on a visible page right now,
   * for the shared unread mark ("Unread mark" in the README):
   *
   * - the desktop main view: the panel selection (`panelSession`), while the
   *   connection that owns it last reported `visible: true`. Desktop panels
   *   report an empty id while hidden or on Activity, Previous sessions or
   *   the browser, and a pop-out host while its selection is popped out
   *   (which is when it shows the compact rail);
   * - every pop-out window of a desktop connection that last reported
   *   `visible: true` (pop-out reports list visible windows only);
   * - each remote connection's selection while it reported `visible: true`.
   *
   * Focus is never required. Only open conversations are returned.
   */
  private visiblyShownConversations(): Set<string> {
    const shown = new Set<string>();

    if (this.panelSession && this.visibleDesktopClients.has(this.panelClient)) {
      shown.add(this.panelSession);
    }

    for (const [clientId, record] of this.nativeViews) {
      if (!this.visibleDesktopClients.has(clientId)) {
        continue;
      }
      for (const popout of record.report.popouts) {
        shown.add(popout.id);
      }
    }

    for (const remote of this.remoteClients.values()) {
      if (remote.visibleSelection) {
        shown.add(remote.visibleSelection);
      }
    }

    for (const id of shown) {
      if (this.options.agents?.has(id) !== true) {
        shown.delete(id);
      }
    }
    return shown;
  }

  /** Whether any connection shows `id` on a visible page (AgentSessions asks). */
  private showsVisibly(id: string): boolean {
    return this.visiblyShownConversations().has(id);
  }

  /**
   * Clear the unread mark of every conversation shown on a visible page.
   * Called after every panel report, desktop or remote, because only a
   * report can make a conversation shown; markRead ignores read ones.
   */
  private markShownConversationsRead(): void {
    for (const id of this.visiblyShownConversations()) {
      this.options.agents?.markRead(id);
    }
  }

  /**
   * The rule for a remote connection changing an application's chat
   * permission for conversation `id`; throws when it may not:
   * - allowing (`allowing`) needs this connection's own selection to be `id`
   *   and its latest report to have said `visible: true` (`visibleSelection`);
   * - stopping needs only its selection to be `id`, visible or not, so that
   *   turning access off is never harder than turning it on.
   * A connection whose visibility was withdrawn (its client left) can allow
   * nothing. The record is looked up on every call: a connection that has
   * gone, or a conversation that closed (which clears the selection), fails.
   * The messages say what the person can do and name no other device.
   */
  private checkRemotePermissionChange(clientId: number, id: string, allowing: boolean): void {
    const remote = this.remoteClients.get(clientId);
    if (!remote || id === '' || remote.selection !== id) {
      throw Error('Open this conversation on this device first');
    }
    if (allowing && remote.visibleSelection !== id) {
      throw Error('Show this conversation on this device first');
    }
  }

  /**
   * Choice, stop-run and tool-page requests must come from the panel that is
   * showing that conversation. Desktop panels use the global selection or one
   * of their own visible pop-out windows; remote panels use their own
   * connection's selection.
   */
  private showsConversation(clientId: number, id: unknown): boolean {
    const remote = this.remoteClients.get(clientId);
    if (remote) {
      return typeof id === 'string' && id !== '' && remote.selection === id;
    }
    if (clientId === this.panelClient && id === this.panelSession) {
      return true;
    }
    if (typeof id !== 'string' || id === '') {
      return false;
    }
    const views = this.nativeViews.get(clientId);
    return views?.report.popouts.some((popout) => popout.id === id) === true;
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

      // The phone gateway reaches widget views through a private socket next
      // to the control socket (src/widgets/socket.ts). The desktop does not
      // need it, so a failure is reported and the listener carries on.
      try {
        await this.options.agents?.serveWidgetsPrivately(
          join(dirname(this.options.socket), 'widgets.sock'),
        );
      } catch (error) {
        this.log('desktop', `Widget socket unavailable: ${String(error)}`);
      }

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
      // later without restarting. Preview mode remains silent throughout,
      // and without a desktop there is nothing to play them on.
      if (!this.options.preview && !this.options.headless) {
        await this.sounds.initialize();
      }

      // Nothing can listen: shown as paused, and Resume is refused.
      if (this.nothingCanListen() && !this.pause.paused) {
        this.pause.toggle();
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

  /**
   * Whether this listener has no microphone at all, so listening is off for
   * good: without a desktop (`--headless`) no microphone of the computer is
   * opened, and no listening browsers are attached either. This is the one
   * place that decides it; `start` then shows listening as paused and
   * `toggle-pause` refuses to resume. Once browsers may listen without a
   * desktop, Pause and Resume apply to them (one Pause for everything) and
   * this answer becomes false.
   */
  private nothingCanListen(): boolean {
    return this.options.headless === true && this.microphones === undefined;
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

  /**
   * Attach manual recording (microphone mode only). Its state is published to
   * every panel; its final summary goes only to the panel that started it.
   * The conversation being recorded into cannot be closed meanwhile.
   */
  connectDictation(dictation: DictationController): void {
    this.dictation = dictation;
    dictation.on('change', this.dictationChanged);
    dictation.on('finished', this.dictationFinished);
    this.options.agents?.setCloseGuard((id) => dictation.closeRefusal(id));
    this.server.broadcast();
  }

  private readonly dictationChanged = () => {
    this.server.broadcast();
  };

  /**
   * Attach the computer's microphone switch and listening browsers (live
   * microphone mode only). Their state is published to every panel; the end
   * of a browser's stream that its connection did not ask for is told to
   * that connection only (`audio-ended`).
   */
  connectMicrophones(microphones: ListenerMicrophones): void {
    this.microphones = microphones;
    microphones.computer.on('change', this.microphonesChanged);
    microphones.browsers.changed = this.microphonesChanged;
    microphones.browsers.ended = (owner, streamId, reason) => {
      this.browserStreamEnded(owner, streamId, reason);
    };
    this.server.broadcast();
  }

  private readonly microphonesChanged = () => {
    this.server.broadcast();
  };

  /** Tell a connection that its stream ended without its asking. */
  private browserStreamEnded(owner: number, streamId: string, reason: BrowserStreamEnd): void {
    if (reason === 'stopped' || reason === 'disconnected') {
      return;
    }
    this.server.publishTo(owner, { type: 'audio-ended', streamId, reason });
  }

  /** The microphones as the state shows them; undefined outside microphone mode. */
  private microphonesState(): MicrophonesState | undefined {
    const microphones = this.microphones;
    if (!microphones) {
      return undefined;
    }

    const listening: MicrophonesState['listening'] = [];
    if (!this.pause.paused) {
      // Listed only while its ordinary listening period actually runs: not
      // while switched off, between a lost recorder and its retry, or while
      // Record has the microphone.
      if (microphones.computer.enabled && microphones.computer.listening) {
        listening.push({ ...computerMicrophoneEntry });
      }
      for (const browser of microphones.browsers.list) {
        listening.push({ id: browser.id, kind: 'browser', name: browser.name });
      }
    }

    return { computer: microphones.computer.enabled, listening, streams: true };
  }

  /** Remember which browser heard frame `id`, for its Activity entry. */
  private rememberMicrophone(id: number, microphone: string | undefined): void {
    if (microphone === undefined) {
      return;
    }
    const entryId = this.history.entryId(id);
    const name = this.microphones?.browsers.nameOf(microphone);
    if (entryId && name !== undefined) {
      this.entryMicrophones.set(entryId, name);
    }
  }

  private readonly dictationFinished = (summary: DictationSummary) => {
    this.server.publishTo(summary.clientId, {
      type: 'recording-finished',
      recordingId: summary.recordingId,
      id: summary.sessionId,
      reason: summary.reason,
      complete: summary.complete,
      message: summary.message,
    });
  };

  /**
   * Send one transcript chunk to the panel that started the recording and
   * wait for its answer, like an agent draft. Once sent, a timeout,
   * disconnect or abandoned recording is `unconfirmed`: the panel may already
   * have appended it, so the recording never resends it.
   */
  private requestRecordingAppend(
    request: DictationAppendRequest,
    signal: AbortSignal,
  ): Promise<DictationAppendResult> {
    if (signal.aborted) {
      return Promise.resolve({ outcome: 'offline', reason: 'The recording has ended.' });
    }

    // The chunk is added to the listener's draft in one step: read, a space
    // if needed, append. An agent's or another editor's change made just
    // before is kept, never replaced by an older copy. A long final chunk is
    // kept whole up to the storage ceiling, or refused whole.
    const current = this.drafts.read(request.sessionId).text;
    const separator = current === '' || /\s$/.test(current) ? '' : ' ';
    const applied = this.drafts.append(request.sessionId, separator + request.text, {
      kind: 'recording',
      clientId: request.clientId,
    });
    if (!applied.accepted) {
      return Promise.resolve({ outcome: 'unavailable', reason: applied.reason });
    }
    const length = this.drafts.read(request.sessionId).text.length;

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (result: DictationAppendResult) => {
        if (!this.pendingRecordingAppends.delete(requestId)) {
          return;
        }
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
        resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish({
            outcome: 'unconfirmed',
            reason: 'The panel did not confirm the transcript within 5 seconds.',
          }),
        recordingAppendConfirmationMilliseconds,
      );
      const cancelled = () =>
        finish({
          outcome: 'unconfirmed',
          reason: 'The recording ended before the panel confirmed the transcript.',
        });

      this.pendingRecordingAppends.set(requestId, {
        clientId: request.clientId,
        finish: (result) =>
          finish(result.outcome === 'appended' ? { outcome: 'appended', length } : result),
      });
      signal.addEventListener('abort', cancelled, { once: true });

      // The owning panel only acknowledges (its recording bookkeeping); the
      // text reaches every editor as an ordinary draft change.
      const sent = this.server.publishTo(request.clientId, {
        type: 'recording-append',
        requestId,
        recordingId: request.recordingId,
        id: request.sessionId,
        sequence: request.sequence,
        text: request.text,
        applied: true,
        length,
      });
      if (!sent) {
        finish({ outcome: 'offline', reason: 'The panel disconnected.' });
      }
    });
  }

  private abandonRecordingAppends(clientId: number | undefined, reason: string): void {
    for (const pending of [...this.pendingRecordingAppends.values()]) {
      if (clientId === undefined || pending.clientId === clientId) {
        pending.finish({ outcome: 'unconfirmed', reason });
      }
    }
  }

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
      // The listener's clock when this message was built, in milliseconds
      // since the Unix epoch. A client on another machine compares it with
      // its own clock on receipt to show turn durations and message times
      // correctly (see "Listener time" in src/desktop/README.md).
      listenerTime: agents?.now() ?? Date.now(),
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
      // Manual recording: whether this listener offers it, and the current
      // recording ({recordingId, sessionId, state}) or null. No text.
      recordingAvailable: Boolean(this.dictation),
      recording: this.dictation?.status ?? null,
      ...conversations,
      sessionControlsAvailable: Boolean(agents),
      intents: this.router?.intentStates({ interaction: this.interactionContext() }) ?? [],
      // Null hides the switch (no cleanup support in this listener).
      transcriptionCleanup: this.options.cleanup ? { enabled: this.options.cleanup.enabled } : null,
      // Absent in older listeners: clients treat that as unavailable, not off.
      captureStorage: this.options.captureStorage.state,
      // Absent outside microphone mode and in older listeners: no switch for
      // the computer's microphone, and no browser can listen.
      microphones: this.microphonesState(),
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

  /**
   * The conversation a spoken follow-up addresses right now: an active pop-out
   * window, else the visible sidebar conversation, else a single pop-out beside
   * the compact rail (native-views.ts explains the order).
   */
  private voiceTarget(): VoiceTarget | undefined {
    const agents = this.options.agents;
    if (!agents) {
      return undefined;
    }
    return chooseVoiceTarget({
      panelSession: this.panelSession,
      panelClient: this.panelClient,
      views: this.nativeViews,
      isOpen: (id) => agents.has(id),
      navigation: this.navigationSelection,
    });
  }

  private interactionContext(): InteractionContext {
    const target = this.voiceTarget();
    const id = target?.id ?? '';
    const order = this.options.agents?.order();
    // Only the chosen view's own focused composer earns the strong "focused
    // composer" instruction. An active window alone, or a lone pop-out beside
    // the compact rail, keeps the ordinary unfocused wording.
    const composerFocused =
      target !== undefined &&
      target.source !== 'popout-only' &&
      this.composerSession === id &&
      this.composerClient === target.clientId;
    return {
      agentNavigation:
        this.navigation && order
          ? {
              ...this.navigation,
              ids: order.ids,
              orderRevision: order.revision,
              popoutHost: this.nativeViews.has(this.navigation.clientId),
            }
          : undefined,
      agentSessionId: id,
      agentComposerFocused: composerFocused,
      agentTargetSource: target?.source,
      revision: this.interactionRevision,
      ...this.options.agents?.interaction(id),
    };
  }

  /**
   * Voice navigation: "go to session N" (`sidebar`: select its tab, or focus
   * its window when it is popped out) or "pop out session N" (`window`: show
   * it in its own window). The number is resolved against the order and UI
   * captured before transcription; anything that changed since refuses it.
   *
   * A navigation the owning UI was asked to carry out also makes that
   * conversation the voice target once the UI shows it (see
   * NavigationSelection), so the next utterance goes to it rather than to a
   * pop-out window that kept focus.
   */
  private navigateToSession(
    context: InteractionContext,
    index: number,
    presentation: 'sidebar' | 'window',
  ): boolean {
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
    // Only a UI that reported pop-out windows can open one.
    if (presentation === 'window' && !this.nativeViews.has(captured.clientId)) {
      return false;
    }

    const id = captured.ids[index];
    const request: Record<string, unknown> = {
      type: 'agent-select',
      id,
      token: captured.token,
      orderRevision: captured.orderRevision,
    };
    if (presentation === 'window') {
      request.presentation = 'window';
    }
    if (!this.server.publishTo(captured.clientId, request)) {
      return false;
    }

    // It becomes the voice target once the UI shows the conversation. It
    // may already do so (for example the sidebar shows it behind an active
    // pop-out window), and then no report follows. Otherwise it waits as
    // pending; the choice in effect stays until it is shown, so a request
    // the UI refuses (a pop-out blocked by an unconfirmed send) changes
    // nothing. It replaces any earlier pending navigation.
    const next = startNavigationSelection(
      id,
      captured.clientId,
      presentation,
      this.connectionView(captured.clientId),
      captured.token,
    );
    if (!next.arrived) {
      this.pendingNavigation = next;
      return true;
    }
    this.pendingNavigation = undefined;
    this.navigationSelection = next;
    // The voice target may have changed: utterances captured before this
    // navigation must not be delivered to the previous one.
    this.interactionRevision++;
    this.server.broadcast();
    this.publishViewAgentActions();
    return true;
  }

  /** What one desktop connection shows now, for NavigationSelection. */
  private connectionView(clientId: number): ConnectionView {
    return {
      mainId: clientId === this.panelClient ? this.panelSession : '',
      composerId: clientId === this.composerClient ? this.composerSession : '',
      report: this.nativeViews.get(clientId)?.report,
    };
  }

  /**
   * Keep, start or end voice navigation choices after the desktop state
   * changed (native-views.ts). The choice in effect ends once its UI no
   * longer owns navigation, no longer shows the conversation, or after a
   * genuine later selection or focus change there. A pending navigation
   * takes its place once shown, and is dropped when its UI acted otherwise.
   * Returns whether the voice target may have changed; the caller
   * broadcasts.
   */
  private followNavigationSelection(): boolean {
    let changed = false;

    const selection = this.navigationSelection;
    if (selection) {
      const next = this.followOnOwner(selection);
      if (next) {
        this.navigationSelection = next;
      } else {
        this.endNavigationSelection();
        changed = true;
      }
    }

    const pending = this.pendingNavigation;
    if (pending) {
      const next = this.followOnOwner(pending);
      this.pendingNavigation = next?.arrived ? undefined : next;
      if (next?.arrived) {
        this.navigationSelection = next;
        this.interactionRevision++;
        changed = true;
      }
    }
    return changed;
  }

  /** followNavigationSelection on its UI, which must still own navigation. */
  private followOnOwner(selection: NavigationSelection): NavigationSelection | undefined {
    if (this.navigation?.clientId !== selection.clientId) {
      return undefined;
    }
    return followNavigationSelection(
      selection,
      this.connectionView(selection.clientId),
      this.navigation.token,
    );
  }

  private endNavigationSelection(): void {
    const selection = this.navigationSelection;
    this.navigationSelection = undefined;
    // Only a choice in effect was the voice target.
    if (selection?.arrived) {
      this.interactionRevision++;
    }
  }

  /**
   * Bind tab/focus together; return whether the resulting snapshot was sent.
   *
   * `id` is the conversation visible in the client's main view (or empty) and
   * `composer` the conversation whose composer has keyboard focus (or empty).
   * For a legacy client the composer can only be the main conversation. A
   * native pop-out host also reports the composer of its active window, and
   * may clear its own composer focus while its main view is empty.
   */
  private setPanelState(
    id: string,
    composer: string,
    clientId: number,
    nativeHost: boolean,
  ): boolean {
    const previousRevision = this.interactionRevision;
    this.applyPanelState(id, composer, clientId, nativeHost);
    if (this.interactionRevision !== previousRevision) {
      this.server.broadcast();
      return true;
    }
    return false;
  }

  /** setPanelState without its broadcast; the caller publishes the change. */
  private applyPanelState(
    id: string,
    composer: string,
    clientId: number,
    nativeHost: boolean,
  ): void {
    // A stale/disconnecting observer must not clear another UI's selected tab.
    const reportsMain = id !== '' || clientId === this.panelClient;
    if (!reportsMain && !nativeHost) {
      return;
    }
    if (reportsMain) {
      const owner = id ? clientId : 0;
      if (id !== this.panelSession || owner !== this.panelClient) {
        this.panelSession = id;
        this.panelClient = owner;
        this.interactionRevision++;
      }
    }
    if (composer || clientId === this.composerClient) {
      this.setComposerFocus(composer, composer ? clientId : 0);
    }
  }

  /**
   * Store one client's validated pop-out report (or its absence). Any semantic
   * change invalidates utterances captured before it, even when the same
   * conversation stays the target (for example moving from the sidebar into
   * its own window). Returns whether anything changed.
   */
  private updateNativeViews(
    clientId: number,
    report: ReturnType<typeof parseNativeViewReport>,
  ): boolean {
    const previous = this.nativeViews.get(clientId);

    if (!report) {
      if (!previous) {
        return false;
      }
      // The panel withdrew the capability: forget its windows, and answer
      // requests already sent to it honestly instead of retargeting them.
      this.abandonPresents(clientId, 'The panel no longer offers pop-out windows.');
      return this.forgetNativeViews(clientId);
    }

    const key = nativeViewKey(report);
    if (previous && previous.key === key) {
      // Identical report: keep its place in the order, change nothing.
      return false;
    }

    const focusChanged = nativeFocusKey(previous?.report) !== nativeFocusKey(report);
    this.nativeViews.set(clientId, { report, key, sequence: ++this.draftReportSequence });
    this.interactionRevision++;
    if (focusChanged) {
      // Keyboard focus moved between windows: pending keyboard delivery that
      // was decided before the move must not type into the new focus.
      this.composerRevision++;
    }
    return true;
  }

  /** Drop one client's pop-out windows; returns whether it had any state. */
  private forgetNativeViews(clientId: number): boolean {
    const previous = this.nativeViews.get(clientId);
    if (!previous) {
      return false;
    }
    this.nativeViews.delete(clientId);
    this.interactionRevision++;
    if (nativeFocusKey(previous.report) !== '') {
      this.composerRevision++;
    }
    // A window composer's focus went with its window. Without this, a
    // following legacy report (which only describes the main view) would
    // leave that composer looking focused, and keyboard delivery that expects
    // no Companion composer (History paste) would be refused.
    const windowComposer =
      this.composerClient === clientId &&
      previous.report.popouts.some((popout) => popout.id === this.composerSession);
    if (windowComposer) {
      this.setComposerFocus('', 0);
    }
    return true;
  }

  /** A conversation was closed: remove its windows from every report. */
  private removeFromNativeViews(id: string): void {
    let changed = false;
    for (const [clientId, record] of this.nativeViews) {
      if (!record.report.popouts.some((popout) => popout.id === id)) {
        continue;
      }
      const report = {
        rail: record.report.rail,
        popouts: record.report.popouts.filter((popout) => popout.id !== id),
      };
      changed = this.updateNativeViews(clientId, report) || changed;
      if (this.composerSession === id && this.composerClient === clientId) {
        this.setComposerFocus('', 0);
      }
    }
    if (changed) {
      this.server.broadcast();
    }
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
    const microphone = this.entryMicrophones.get(entry.id);
    if (microphone !== undefined) {
      entry = { ...entry, microphone };
    }

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
        this.entryMicrophones.delete(entry.id);
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

  /** Open or saved conversations the listener knows; drafts exist only for those. */
  private knownConversation(id: string): boolean {
    const agents = this.options.agents;
    if (!agents || typeof id !== 'string' || id === '') {
      return false;
    }
    return agents.has(id) || agents.hasSaved(id);
  }

  /**
   * Every draft host, desktop or remote, learns each accepted draft change.
   * The editor that wrote it gets its own edit ID back, so it does not apply
   * its own edit a second time (no echo). Remote panels that are not draft
   * hosts never receive drafts.
   */
  private publishDraft(change: DraftChange): void {
    for (const clientId of this.draftHosts.keys()) {
      const own = change.writer.clientId === clientId ? change.writer.editId : undefined;
      this.server.publishTo(clientId, {
        type: 'draft',
        id: change.sessionId,
        text: change.text,
        source: change.source,
        sequence: change.sequence,
        ...(own ? { editId: own } : {}),
      });
    }
  }

  /**
   * Record that `clientId`'s latest panel report declared it a draft host.
   * A newly attached host reads every draft once (`draft-snapshot`), then
   * every change (`publishDraft`). Reading never writes: the snapshot
   * changes nothing in the map.
   */
  private attachDraftHost(clientId: number): void {
    const attached = this.draftHosts.has(clientId);
    this.draftHosts.set(clientId, ++this.draftReportSequence);
    if (attached) {
      return;
    }

    this.server.publishTo(clientId, {
      type: 'draft-snapshot',
      sequence: this.drafts.latestSequence(),
      drafts: this.drafts.snapshot().map((change) => ({
        id: change.sessionId,
        text: change.text,
        source: change.source,
        sequence: change.sequence,
      })),
    });
  }

  /**
   * A remote panel's report, already validated: `draftHost` true makes (or
   * keeps) it a draft host, anything else ends that, as for a desktop
   * editor. The gateway adds `draftHost: true` to every report of a
   * connection whose client asked for drafts and to no other, so for a
   * gateway connection this holds from its first report to its disconnect.
   * `pendingSend` counts only for a draft host: a panel without the draft
   * has no send of it to wait for.
   */
  private updateRemoteDraftHost(clientId: number, draftHost: boolean, pendingSend: unknown): void {
    if (!draftHost) {
      this.draftHosts.delete(clientId);
      this.pendingDraftSends.delete(clientId);
      return;
    }

    this.attachDraftHost(clientId);
    if (typeof pendingSend === 'string' && pendingSend !== '') {
      this.pendingDraftSends.set(clientId, pendingSend.slice(0, 200));
    } else {
      this.pendingDraftSends.delete(clientId);
    }
  }

  /**
   * The desktop draft host asked to show a conversation for an agent draft
   * with `focus`: the panel that currently owns visible navigation, otherwise
   * the desktop draft host that reported most recently. Remote draft hosts
   * are never chosen: an agent's `focus` moves only the desktop.
   */
  private desktopDraftClient(): number | undefined {
    const visible = this.navigation?.clientId;
    if (visible !== undefined && this.draftHosts.has(visible)) {
      return visible;
    }
    let newest: number | undefined;
    let newestSequence = -1;
    for (const [clientId, sequence] of this.draftHosts) {
      if (this.remoteClients.has(clientId)) {
        continue;
      }
      if (sequence > newestSequence) {
        newest = clientId;
        newestSequence = sequence;
      }
    }
    return newest;
  }

  /**
   * An agent's proposed draft, applied to the listener's draft map in one
   * step: it never overwrites text the person wrote, and appends below it
   * only when asked (DraftStore.propose). Every desktop editor then shows it
   * as an ordinary draft change, with the agent's provenance; so does every
   * remote draft host. With `focus`, the desktop panel that owns navigation
   * is asked to show the conversation (never a remote one). Without any
   * connected draft host, desktop or remote, nobody could review it:
   * `offline`, nothing is stored.
   */
  private requestDraft(
    request: AgentDraftRequest,
    signal: AbortSignal,
  ): Promise<AgentDraftOutcome> {
    if (this.draftHosts.size === 0 || signal.aborted) {
      return Promise.resolve({ outcome: 'offline', reason: '' });
    }

    for (const pendingId of this.pendingDraftSends.values()) {
      if (pendingId === request.sessionId) {
        return Promise.resolve({
          outcome: 'conflict',
          reason: "A message from that conversation's input is still being sent.",
        });
      }
    }

    let source = request.source.title || 'another conversation';
    if ('kind' in request.source && request.source.kind === 'external') {
      source = `external (unverified) · ${request.source.title}`;
    }
    const result = this.drafts.propose({
      sessionId: request.sessionId,
      text: request.text,
      ifDraftExists: request.ifDraftExists,
      source: source,
    });
    if (result.outcome === 'conflict') {
      return Promise.resolve({ outcome: 'conflict', reason: result.reason });
    }

    // Only a desktop panel is moved; with only remote draft hosts connected
    // the draft is stored and shown there, and nothing changes selection.
    const focusClient = this.desktopDraftClient();
    if (request.focus && focusClient !== undefined) {
      this.server.publishTo(focusClient, { type: 'agent-draft-focus', id: request.sessionId });
    }
    return Promise.resolve({ outcome: result.outcome, reason: '' });
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
    // The panel browser belongs to the native desktop panel. Without a
    // desktop the agent learns that, rather than "no panel is connected"
    // while a paired browser shows the conversation.
    if (this.options.headless) {
      return Promise.resolve({
        outcome: 'unsupported',
        reason: `${withoutDesktop}; it has no panel browser.`,
      });
    }
    const clientId = this.browserClient();
    if (clientId === undefined) {
      // A connected panel without a browser (Quickshell, an older UI) is not
      // the same as no panel at all. Remote draft hosts are not desktop panels.
      if (this.desktopDraftClient() !== undefined) {
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

  /**
   * The native panel that owns pop-out windows: the visible navigation owner
   * if it offers them, otherwise the pop-out host that reported most recently.
   * Remote panels can never become one.
   */
  private presentClient(): number | undefined {
    const visible = this.navigation?.clientId;
    if (visible !== undefined && this.nativeViews.has(visible)) {
      return visible;
    }
    let newest: number | undefined;
    let newestSequence = -1;
    for (const [clientId, record] of this.nativeViews) {
      if (record.sequence > newestSequence) {
        newest = clientId;
        newestSequence = record.sequence;
      }
    }
    return newest;
  }

  /**
   * Ask one native panel to pop a conversation out into its own window, or to
   * return it to the sidebar, and wait for its explicit answer. The request
   * is a one-time event, never part of snapshots, so reconnects cannot replay
   * it. Before sending, no panel means `offline` (and a connected panel
   * without pop-out windows `unsupported`). Once sent, timeout, disconnect,
   * capability withdrawal or turn cancellation are `unconfirmed`: the panel
   * may already have acted. Never retried or redirected to another panel.
   */
  private requestPresent(
    request: AgentPresentRequest,
    signal: AbortSignal,
  ): Promise<AgentPresentOutcome> {
    if (signal.aborted) {
      return Promise.resolve({ outcome: 'offline', reason: 'The agent turn has ended.' });
    }
    // Pop-out windows are native desktop windows (see requestBrowserOpen).
    if (this.options.headless) {
      return Promise.resolve({
        outcome: 'unsupported',
        reason: `${withoutDesktop}; it has no conversation windows.`,
      });
    }
    const clientId = this.presentClient();
    if (clientId === undefined) {
      // Remote draft hosts are not desktop panels: without one it is offline.
      if (this.desktopDraftClient() !== undefined) {
        return Promise.resolve({
          outcome: 'unsupported',
          reason: 'The connected Companion panel cannot open conversation windows.',
        });
      }
      return Promise.resolve({ outcome: 'offline', reason: '' });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (outcome: AgentPresentOutcome) => {
        if (!this.pendingPresents.delete(requestId)) {
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
        presentConfirmationMilliseconds,
      );
      const cancelled = () =>
        finish({
          outcome: 'unconfirmed',
          reason: 'The agent turn ended before the panel answered.',
        });

      this.pendingPresents.set(requestId, {
        clientId,
        presentation: request.presentation,
        finish,
      });
      signal.addEventListener('abort', cancelled, { once: true });

      const sent = this.server.publishTo(clientId, {
        type: 'agent-present',
        requestId,
        id: request.sessionId,
        presentation: request.presentation,
        focus: request.focus,
      });
      if (!sent) {
        finish({ outcome: 'offline', reason: 'The panel disconnected.' });
      }
    });
  }

  private abandonPresents(clientId: number | undefined, reason: string): void {
    for (const pending of [...this.pendingPresents.values()]) {
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

  /**
   * A listening browser's audio stream, relayed by the remote gateway (see
   * src/desktop/README.md, "Microphones and listening browsers"). Remote connections only:
   * the gateway adds the device's name to `audio-start`, and a connection
   * feeds and stops only its own stream.
   *
   * - `audio-start {deviceName}` opens the connection's stream (ending an
   *   earlier one of the same connection) and answers `{streamId}`.
   * - `audio-chunk {data}`: one piece, base64 of 2–8192 bytes of 16 kHz mono
   *   signed 16-bit little-endian samples (an even number of bytes). Never
   *   waits; answered only when refused (src/desktop/server.ts).
   * - `audio-stop {streamId?}` ends it: `stopped`, or `not-streaming` when
   *   there was none (or it is not the named one: the gateway names the
   *   stream it means, so a late stop never ends a newer stream).
   */
  private handleAudioStream(
    request: Record<string, unknown>,
    clientId: number,
    remote: boolean,
  ): unknown {
    if (!remote) {
      throw Error('Only remote panels stream audio');
    }
    const browsers = this.microphones?.browsers;
    if (!browsers) {
      throw Error('Listening here is not available');
    }

    if (request.action === 'audio-start') {
      const name = request.deviceName;
      if (
        typeof name !== 'string' ||
        name.trim() === '' ||
        name.length > maximumMicrophoneNameLength
      ) {
        throw Error(`Expected a device name of 1–${maximumMicrophoneNameLength} characters`);
      }
      return { streamId: browsers.start(clientId, name) };
    }

    if (request.action === 'audio-stop') {
      if (request.streamId !== undefined && typeof request.streamId !== 'string') {
        throw Error('Expected the stream ID as text');
      }
      const stopped = browsers.stop(clientId, 'stopped', request.streamId);
      return stopped ? 'stopped' : 'not-streaming';
    }

    const data = request.data;
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > Math.ceil(maximumAudioChunkBytes / 3) * 4 ||
      !base64Pattern.test(data)
    ) {
      throw Error('Expected base64 audio of at most 8 KiB');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > maximumAudioChunkBytes || bytes.length % 2 !== 0) {
      throw Error('Expected whole 16-bit samples, at most 8 KiB');
    }
    browsers.push(clientId, bytes);
    return 'received';
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
        this.mediaClients.has(clientId) ||
        // Any accepted desktop panel report, which may also have recorded
        // pop-out windows and page visibility that only a desktop
        // disconnect clears.
        this.viewActionKeys.has(clientId)
      ) {
        throw Error('Declare the remote role before reporting desktop panel state');
      }
      this.remoteClients.set(clientId, {
        selection: '',
        visibleSelection: '',
        lastActionsKey: '',
      });
      // A remote panel only ever receives controls for its own selection.
      this.viewActionKeys.delete(clientId);
      this.publishRemoteAgentActions(clientId);
      return 'role-recorded';
    }

    if (request.action === 'withdraw-visibility') {
      // Sent by the gateway when its client has left while requests still
      // drain (src/remote/relay.ts): the page is gone, so the connection
      // stops showing anything for the unread mark. The selection stays for
      // the draining requests. Idempotent and never refused for a remote.
      if (!remote) {
        throw Error('Only remote panels can withdraw their visibility');
      }
      remote.visibleSelection = '';
      // Nobody sees its drafts any more either: it stops being a draft host,
      // so agent proposals no longer count it as a reviewer, and its pending
      // send no longer blocks them. Requests it sent before this one were
      // handled first (in order), so an admitted send has already cleared.
      this.draftHosts.delete(clientId);
      this.pendingDraftSends.delete(clientId);
      return 'visibility-withdrawn';
    }

    if (request.action === 'report-refused') {
      // Sent by the gateway when it refused one of its client's panel
      // reports (request rate or pending bound; src/remote/relay.ts). That
      // report may have hidden the page or moved it, so this connection stops
      // counting as visible, and its selection ends unless the refused report
      // named the same conversation (a hide keeps it, so Stop still works).
      // It only ever lowers what the connection shows: it never selects a
      // conversation and leaves draft hosting and a pending send alone.
      // Never waits; never refused for a remote connection with a valid `id`.
      if (!remote) {
        throw Error('Only remote panels can report a refused panel report');
      }
      if (typeof request.id !== 'string') {
        throw Error("Expected the refused report's conversation id (or empty id)");
      }
      remote.visibleSelection = '';
      if (remote.selection !== request.id) {
        remote.selection = '';
        this.publishRemoteAgentActions(clientId);
      }
      return 'report-refused';
    }

    // Without a desktop, its abilities are refused with their reason for
    // every client, before the remote rule below would give a vaguer one.
    if (this.options.headless && typeof request.action === 'string') {
      const refusal = withoutDesktopRefusals.get(request.action);
      if (refusal !== undefined) {
        throw Error(refusal);
      }
    }

    if (remote && typeof request.action === 'string' && desktopOnlyActions.has(request.action)) {
      throw Error('This action is only available on the desktop');
    }

    if (
      request.action === 'audio-start' ||
      request.action === 'audio-chunk' ||
      request.action === 'audio-stop'
    ) {
      return this.handleAudioStream(request, clientId, remote !== undefined);
    }

    if (request.action === 'set-computer-microphone') {
      if (!this.microphones) {
        throw Error("The computer's microphone switch is unavailable");
      }
      if (typeof request.enabled !== 'boolean') {
        throw Error('Expected enabled: true or false');
      }
      if (this.microphones.computer.set(request.enabled)) {
        this.log(
          'microphone',
          request.enabled ? "Computer's microphone on" : "Computer's microphone off",
        );
      }
      return request.enabled ? 'computer-microphone-on' : 'computer-microphone-off';
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
      this.entryMicrophones.delete(request.id);
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

    if (
      request.action === 'set-application-chat-read' ||
      request.action === 'set-application-chat-send'
    ) {
      if (!this.options.agents || typeof request.id !== 'string') {
        throw Error('Expected a conversation');
      }
      const id = request.id;

      // Who may change the permission (src/desktop/README.md, "Application
      // chat access from a paired device"). The check runs now and again when
      // the change leaves the application's queue, so a selection or
      // visibility that changed while it waited counts. A desktop connection
      // keeps exactly its previous rule; a remote connection has its own.
      let validateShown: () => void;
      if (remote) {
        // Anything but an explicit `false` asks to allow, so it needs the
        // stricter check (the application service refuses non-booleans).
        const allowing = request.allowed !== false;
        validateShown = () => {
          this.checkRemotePermissionChange(clientId, id, allowing);
        };
      } else {
        validateShown = () => {
          if (!this.showsConversation(clientId, id) || this.remoteClients.has(clientId)) {
            throw Error('This conversation is no longer selected on the desktop');
          }
        };
      }
      validateShown();

      if (this.options.preview) {
        return 'preview';
      }
      const setPermission =
        request.action === 'set-application-chat-read'
          ? this.options.agents.setApplicationChatRead.bind(this.options.agents)
          : this.options.agents.setApplicationChatSend.bind(this.options.agents);
      return setPermission(
        id,
        {
          applicationId: request.applicationId,
          version: request.version,
          revision: request.revision,
          allowed: request.allowed,
        },
        validateShown,
      );
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

    if (request.action === 'start-recording') {
      if (
        typeof request.id !== 'string' ||
        !Number.isSafeInteger(request.draftLength) ||
        (request.draftLength as number) < 0
      ) {
        throw Error('Expected a conversation id and the current draft length');
      }
      if (!this.dictation) {
        throw Error('Recording is not available in this listener mode');
      }
      // Only the panel showing that conversation may record into it; the
      // words go to that panel's draft, never to whichever tab is selected later.
      if (!this.options.agents?.has(request.id) || !this.showsConversation(clientId, request.id)) {
        throw Error('Open this conversation to record into its text box');
      }
      // A close admitted earlier is still saving; its draft is about to go.
      // Checked in the same tick as `start`, so no close can slip between.
      if (this.options.agents.isClosing(request.id)) {
        throw Error('This conversation is closing');
      }
      const status = this.dictation.start({
        clientId,
        sessionId: request.id,
        draftLength: request.draftLength as number,
        append: (append, signal) => this.requestRecordingAppend(append, signal),
      });
      return { outcome: 'recording', recordingId: status.recordingId, id: status.sessionId };
    }

    if (request.action === 'stop-recording') {
      if (typeof request.id !== 'string') {
        throw Error('Expected a conversation id');
      }
      const status = this.dictation?.status;
      if (!status || status.sessionId !== request.id || !this.dictation!.ownedBy(clientId)) {
        throw Error('This conversation is not recording in this panel');
      }
      this.dictation!.stop('stopped');
      return 'finishing';
    }

    if (request.action === 'recording-append-result') {
      if (
        typeof request.requestId !== 'string' ||
        (request.outcome !== 'appended' && request.outcome !== 'unavailable') ||
        (request.outcome === 'appended' &&
          (!Number.isSafeInteger(request.length) || (request.length as number) < 0)) ||
        (request.reason !== undefined &&
          (typeof request.reason !== 'string' || request.reason.length > 300))
      ) {
        throw Error('Expected a recording append request id and outcome');
      }
      // Only the panel that was asked can answer, once; a late answer is refused.
      const pending = this.pendingRecordingAppends.get(request.requestId);
      if (!pending || pending.clientId !== clientId) {
        throw Error('This recording append request has expired');
      }
      pending.finish(
        request.outcome === 'appended'
          ? { outcome: 'appended', length: request.length as number }
          : { outcome: 'unavailable', reason: (request.reason as string | undefined) ?? '' },
      );
      return 'recording-recorded';
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

    if (request.action === 'agent-present-result') {
      const outcome = presentResult(request);
      // Only the panel that was asked can answer, once; a late answer is refused.
      const pending = this.pendingPresents.get(request.requestId as string);
      if (!pending || pending.clientId !== clientId) {
        throw Error('This presentation request has expired');
      }
      // "shown" answers a window request and "returned" a sidebar request; a
      // mismatch is refused and the request stays pending (then unconfirmed).
      if (
        (outcome.outcome === 'shown' && pending.presentation !== 'window') ||
        (outcome.outcome === 'returned' && pending.presentation !== 'sidebar')
      ) {
        throw Error('This outcome does not answer the presentation request');
      }
      pending.finish(outcome);
      return 'present-recorded';
    }

    if (request.action === 'panel-state' && remote) {
      // Remote panels report which conversation they show, whether their
      // page is visible and, as draft hosts, a send they are waiting for.
      // Focus and navigation fields describe the desktop and are ignored.
      //
      // A report refused below still means the page moved on (for example
      // to a conversation that has just closed), so it no longer shows what
      // the previous report recorded: the connection's selection and
      // visibility end. Otherwise a permission change waiting in an
      // application's queue could be allowed for a conversation the person
      // has left (src/desktop/README.md, "Application chat access from a
      // paired device").
      const refused = (message: string): Error => {
        remote.selection = '';
        remote.visibleSelection = '';
        this.publishRemoteAgentActions(clientId);
        return Error(message);
      };
      if (
        typeof request.id !== 'string' ||
        (request.id !== '' && !this.options.agents?.has(request.id))
      ) {
        throw refused('Expected a visible agent session id (or empty id)');
      }
      if (request.visible !== undefined && typeof request.visible !== 'boolean') {
        throw refused('Expected visible to be true or false');
      }
      if (request.draftHost !== undefined && typeof request.draftHost !== 'boolean') {
        throw refused('Expected draftHost to be true or false');
      }
      if (request.pendingSend !== undefined && typeof request.pendingSend !== 'string') {
        throw refused('Expected pendingSend to be a conversation id or empty');
      }
      // Pop-out windows are desktop windows; a remote panel cannot claim any.
      if (
        request.popoutHost !== undefined ||
        request.rail !== undefined ||
        request.popouts !== undefined
      ) {
        throw refused('Remote panels cannot report pop-out windows');
      }
      remote.selection = request.id;
      // Every report is complete: one without `visible` (an older phone app)
      // counts as not visible, so it never reads a conversation.
      remote.visibleSelection = request.visible === true ? request.id : '';
      this.updateRemoteDraftHost(clientId, request.draftHost === true, request.pendingSend);
      this.publishRemoteAgentActions(clientId);
      this.markShownConversationsRead();
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
      // A native UI with pop-out windows adds them to the same report. They
      // are validated completely before any state below changes.
      const nativeReport = parseNativeViewReport(
        request,
        (id) => this.options.agents?.has(id) === true,
      );
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
      if (typeof request.pendingSend === 'string' && request.pendingSend !== '') {
        this.pendingDraftSends.set(clientId, request.pendingSend.slice(0, 200));
      } else {
        this.pendingDraftSends.delete(clientId);
      }
      // Only UIs that implement agent-draft advertise it; older ones omit it.
      if (request.draftHost === true) {
        this.attachDraftHost(clientId);
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
      // For a pop-out host, `id`, `composerFocused` and `keyboardFocused`
      // describe only the main sidebar view; its windows come in `popouts`.
      const viewsChanged = this.updateNativeViews(clientId, nativeReport);
      const active = activePopout(nativeReport);
      // Keyboard delivery guards cover every native surface: the main panel,
      // or an active pop-out window (which always holds keyboard focus).
      this.setPanelKeyboardFocus(
        request.keyboardFocused === true || request.composerFocused || active !== undefined,
        clientId,
      );
      // Keyboard focus is in one place: an active window decides alone,
      // otherwise the main view's composer does.
      let composer = '';
      if (active) {
        composer = active.composerFocused ? active.id : '';
      } else if (request.composerFocused) {
        composer = request.id;
      }
      const revisionBeforePanel = this.interactionRevision;
      this.applyPanelState(request.id, composer, clientId, nativeReport !== undefined);
      // A voice navigation choice takes effect when its UI shows the chosen
      // conversation and lasts until that UI genuinely changes its selection
      // or focus, or stops owning navigation (native-views.ts). Decided
      // before the snapshot below, so the voice indication it carries agrees.
      this.followNavigationSelection();
      let stateBroadcast = false;
      if (this.interactionRevision !== revisionBeforePanel) {
        this.server.broadcast();
        stateBroadcast = true;
      }
      // Leaving the conversation being recorded into (another tab, Activity,
      // Previous sessions or a hidden panel) stops capture. The remaining
      // words still go to the original conversation's draft. Moving that
      // conversation into (or out of) its own window keeps it shown.
      const recording = this.dictation?.status;
      const recordingShown =
        recording !== undefined &&
        (recording.sessionId === request.id ||
          nativeReport?.popouts.some((popout) => popout.id === recording.sessionId) === true);
      this.dictation?.ownerViewChanged(
        clientId,
        recordingShown && recording ? recording.sessionId : request.id,
      );
      const navigationChanged = previousNavigation?.clientId !== this.navigation?.clientId;
      if ((navigationChanged || viewsChanged) && !stateBroadcast) {
        // Only navigation presence/ownership affects intent availability. The
        // token is not in snapshots; updating it must not copy every transcript.
        // Selection/focus changes already broadcast the updated navigation.
        // Pop-out changes can move the voice target, which snapshots show.
        this.server.broadcast();
      }
      // A report can add or retract this connection's views, and taking the
      // panel selection retracts another connection's main view. The first
      // report also subscribes this connection to its view controls.
      if (!this.viewActionKeys.has(clientId)) {
        this.viewActionKeys.set(clientId, '');
      }
      this.publishViewAgentActions();
      // Selecting a conversation while visible, or becoming visible with it
      // selected, reads it. Validated above, so the report is complete here.
      if (request.visible === true) {
        this.visibleDesktopClients.add(clientId);
      } else {
        this.visibleDesktopClients.delete(clientId);
      }
      this.markShownConversationsRead();
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
        this.followNavigationSelection();
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
      if (
        typeof request.text !== 'string' ||
        !request.text.trim() ||
        request.text.length > MAX_DIRECT_USER_MESSAGE_LENGTH
      ) {
        throw Error(`Enter between 1 and ${MAX_DIRECT_USER_MESSAGE_LENGTH} characters`);
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

    if (request.action === 'draft-set') {
      // Only a draft host may write: a desktop editor, or a remote panel
      // whose reports declare it one. The edit names its conversation; the
      // last one received wins. Other remote panels hear the same refusal as
      // before remote draft hosts existed.
      if (remote && !this.draftHosts.has(clientId)) {
        throw Error('This action is only available on the desktop');
      }
      if (!this.draftHosts.has(clientId)) {
        throw Error('Only a desktop editor can change drafts');
      }
      if (
        typeof request.id !== 'string' ||
        typeof request.text !== 'string' ||
        typeof request.editId !== 'string' ||
        request.editId.length === 0 ||
        request.editId.length > 100
      ) {
        throw Error('Expected a conversation id, draft text and an edit id');
      }
      // Recorded words may pass the editing bound (up to the storage
      // ceiling), but only from the panel recording into that conversation.
      // A remote panel can never record, so it never owns the dictation.
      const status = this.dictation?.status;
      const recording =
        !remote &&
        request.recording === true &&
        status !== undefined &&
        status.sessionId === request.id &&
        this.dictation!.ownedBy(clientId);
      return this.drafts.write(
        request.id,
        request.text,
        { kind: recording ? 'recording' : 'editor', clientId: clientId, editId: request.editId },
        recording ? 'storage' : 'edit',
      );
    }

    if (request.action === 'send-agent') {
      if (
        !this.options.agents ||
        typeof request.id !== 'string' ||
        typeof request.text !== 'string'
      ) {
        throw Error('Expected an agent session id and follow-up text');
      }
      // Remote panels may send as much as the desktop composer (8,000
      // characters, `MAX_DIRECT_USER_MESSAGE_LENGTH`); `followUp` checks
      // that bound itself. The phone protocol checks it before relaying.
      if (
        remote &&
        (!request.text.trim() || request.text.length > MAX_DIRECT_USER_MESSAGE_LENGTH)
      ) {
        throw Error(`A follow-up requires 1–${MAX_DIRECT_USER_MESSAGE_LENGTH} characters`);
      }
      this.options.agents.followUp(request.id, request.text, this.signal);
      // A send from a draft host (a desktop editor, or a remote panel that
      // hosts drafts) came from the conversation's draft: clear it, but only
      // if it is still exactly the sent text (typing since then stays).
      // Other desktop clients clear too, as before; other remote panels
      // never had the draft, so their sends leave it alone.
      if (!remote || this.draftHosts.has(clientId)) {
        this.drafts.clearIfEqual(request.id, request.text);
      }
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

    // Reads only the configuration file; no Pi discovery.
    if (request.action === 'coding-defaults') {
      if (!this.options.agents) {
        throw Error('Agent sessions are unavailable');
      }
      return this.options.agents.codingDefaults();
    }

    if (request.action === 'set-coding-defaults') {
      if (
        !this.options.agents ||
        !agentHarnesses.includes(request.harness as AgentHarness) ||
        (request.model !== undefined &&
          (typeof request.model !== 'string' ||
            request.model === '' ||
            request.model.length > 300)) ||
        typeof request.revision !== 'string' ||
        request.revision.length > 100
      ) {
        throw Error('Expected a harness, an optional model and the defaults revision');
      }
      if (this.options.preview) {
        return 'preview';
      }
      return this.options.agents.setCodingDefaults(
        {
          harness: request.harness as AgentHarness,
          ...(request.model !== undefined ? { model: request.model as string } : {}),
          revision: request.revision,
        },
        this.signal,
      );
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
      if (this.nothingCanListen()) {
        throw Error(`${withoutDesktop} and has no microphone: listening stays off.`);
      }
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
    this.options.agents?.setPresentationHost(undefined);
    this.abandonPresents(undefined, 'Companion is shutting down.');
    this.dictation?.abandon('shutdown');
    this.dictation?.off('change', this.dictationChanged);
    this.dictation?.off('finished', this.dictationFinished);
    this.microphones?.computer.off('change', this.microphonesChanged);
    this.options.agents?.setCloseGuard(undefined);
    this.abandonRecordingAppends(undefined, 'Companion is shutting down.');
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
