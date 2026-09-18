import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Activity } from '../core/activity.ts';
import type { Log } from '../core/frame.ts';
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

/** No Omarchy types or commands belong here; any local UI can use this service. */
export function desktopPaths(): { database: string; socket: string } {
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
  const runtime = process.env.XDG_RUNTIME_DIR;

  if (!runtime) {
    throw Error(
      'XDG_RUNTIME_DIR is required for desktop integration; use --no-desktop to disable it',
    );
  }

  return {
    database: join(state, 'companion', 'utterances.sqlite'),
    socket: join(runtime, 'companion', 'control.sock'),
  };
}

/** Owns storage, UI notifications, sound feedback, and explicit history recovery. */
export class DesktopRuntime {
  readonly activity: Activity;
  private readonly history: UtteranceHistory;
  private readonly server: DesktopServer;
  private readonly sounds: SoundFeedback;
  private readonly processing = new Set<number>();
  private readonly delivery = new DeliveryControl();
  private readonly databaseLock: InstanceLock;
  private ready = false;
  private pasting = false;
  private speaking = false;

  constructor(
    private readonly pause: PauseControl,
    private readonly log: Log,
    private readonly signal: AbortSignal,
    private readonly options: {
      database: string;
      socket: string;
      preview: boolean;
      sounds: boolean;
    },
    private readonly run: RunCommand = command,
  ) {
    this.history = new UtteranceHistory(options.database);
    this.databaseLock = new InstanceLock(options.database + '.lock');
    this.sounds = new SoundFeedback(log, signal, options.sounds && !options.preview);
    this.server = new DesktopServer(
      options.socket,
      () => this.snapshot(),
      (request) => this.handle(request),
    );

    this.activity = {
      speechChanged: (speaking) => {
        const next = speaking && !this.pause.paused;
        if (this.speaking !== next) {
          this.speaking = next;
          this.server.broadcast();
        }
      },
      delivery: this.delivery,
      deliveryStarted: (id) => {
        this.history.markDeliveryStarted(id);
        this.server.broadcast();
      },
      processing: (id) => {
        this.processing.add(id);
        this.sounds.play('processing');
        this.server.broadcast();
      },
      transcribed: (transcript) => {
        this.history.add(transcript);
        this.server.broadcast();
      },
      intentRecognized: (id, intent) => {
        this.history.setIntent(id, intent);
        this.server.broadcast();
      },
      outcome: (id, outcome) => {
        this.history.setOutcome(id, outcome);

        // A predicted send is not a delivered utterance. Skips/errors have no
        // success cue, and preview mode must not imply that text was delivered.
        if (outcome === 'sent' || outcome === 'ignored') {
          this.sounds.play(outcome);
        }

        this.server.broadcast();
      },
      finished: (id) => {
        this.processing.delete(id);
        this.delivery.finish(id);
        this.history.finish(id);
        this.server.broadcast();
      },
    };
  }

  async start(): Promise<void> {
    // Hold database ownership from before recovery until after SQLite closes.
    // The separate socket lock protects stale-socket recovery, including when
    // another caller uses the same database with a different socket path.
    await this.databaseLock.acquire();

    try {
      await this.server.start();
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
      this.pause.paused ? 'Microphone and pending work stopped' : 'Microphone resuming',
    );
    this.server.broadcast();
  };

  private snapshot(): object {
    return {
      protocol: 1,
      ready: this.ready,
      paused: this.pause.paused,
      speaking: this.speaking,
      soundsEnabled: this.sounds.enabled,
      processing: this.processing.size,
      preview: this.options.preview,
      history: this.ready ? this.history.snapshot() : [],
    };
  }

  private async handle(value: unknown): Promise<string> {
    this.signal.throwIfAborted();

    if (!this.ready || !value || typeof value !== 'object') {
      throw Error('Companion is not ready');
    }

    const request = value as Record<string, unknown>;

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
    this.pasting = true;

    // The shared delivery owner either supersedes a pending automatic send or
    // rejects recovery if that utterance is already being typed.
    const frameId = this.history.activeFrameId(entry.id);
    let application: string | null = null;

    try {
      const target = request.target;
      const outcome = await this.delivery.recover(frameId, this.signal, async () => {
        // Bound the initial focus lookup as well as typing. A wedged compositor
        // cannot hold the shared keyboard queue indefinitely. Recheck only when
        // this request reaches the front; focus may change while it waits.
        const deadline = AbortSignal.any([this.signal, AbortSignal.timeout(5000)]);
        await delay(150, undefined, { signal: deadline });
        const window = await activeWindow(deadline, this.run);
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
          deadline,
          this.run,
          () => true,
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
