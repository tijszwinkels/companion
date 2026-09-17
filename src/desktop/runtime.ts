import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Activity } from '../core/activity.ts';
import type { Log } from '../core/frame.ts';
import { PauseControl } from '../core/pause-control.ts';
import { activeWindow } from '../sensors/screen/capture.ts';
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
  private readonly manuallyRecovered = new Set<number>();
  private ready = false;
  private pasting = false;

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
  ) {
    this.history = new UtteranceHistory(options.database);
    this.sounds = new SoundFeedback(log, signal, options.sounds && !options.preview);
    this.server = new DesktopServer(
      options.socket,
      () => this.snapshot(),
      (request) => this.handle(request),
    );

    this.activity = {
      deliveryAllowed: (id) => !this.manuallyRecovered.has(id),
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
        this.manuallyRecovered.delete(id);
        this.history.finish(id);
        this.server.broadcast();
      },
    };
  }

  async start(): Promise<void> {
    // Acquire the single-instance socket before opening/recovering the database.
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
  }

  private readonly pauseChanged = () => {
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

    // A user can select a transcript while the model is still considering it.
    // That explicit action supersedes an automatic send which has not started.
    // Keep the original model decision for evaluation when it eventually arrives.
    const frameId = this.history.activeFrameId(entry.id);

    if (frameId !== undefined) {
      this.manuallyRecovered.add(frameId);
    }
    let application: string | null = null;

    try {
      // Give the overlay time to unmap and return keyboard focus. Its original
      // target is checked again immediately before typing; focus is never forced.
      await delay(150, undefined, { signal: this.signal });
      const window = await activeWindow(this.signal);
      application = window.address === request.target ? window.class : null;
      let outcome: string;

      if (window.address !== request.target) {
        outcome = 'skipped';
      } else if (this.options.preview) {
        outcome = 'preview';
      } else {
        const delivered = await typeText(entry.utterance, request.target, this.signal);
        outcome = delivered ? 'sent' : 'skipped';
      }

      this.history.finishPaste(eventId, outcome, application);
      this.log('paste', `${outcome}: ${entry.id}`);

      if (outcome === 'sent') {
        this.sounds.play('sent');
      }

      return outcome;
    } catch (error) {
      this.history.finishPaste(eventId, this.signal.aborted ? 'cancelled' : 'error', application);
      throw error;
    } finally {
      this.pasting = false;
    }
  }

  async close(): Promise<void> {
    this.pause.off('change', this.pauseChanged);
    await this.server.close();
    await this.sounds.close();
    this.history.close();
  }
}
