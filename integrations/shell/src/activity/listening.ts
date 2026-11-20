/**
 * The listening state as the Activity column and the list's Activity entry
 * show it, from the phone Store's state.
 *
 * The title and its description are the desktop StatusView's wording, as
 * the phone derives them (`listeningStatus` of the phone Activity page):
 * Listening, Paused, Paused for media, Not running. Below it, while
 * listening, what the microphone is doing now: hearing speech, processing,
 * or ready. Pause and Resume are offered while Companion runs.
 */

import { listeningStatus } from '../../../mobile/src/components/Activity.tsx';
import type { AppState } from '../../../mobile/src/store.ts';

export interface ListeningView {
  /** `Listening`, `Paused`, `Paused for media` or `Not running`. */
  title: string;
  /** One more line: why it is paused, or what the microphone is doing. */
  detail: string;
  /** The short form for the column's header (`listening`, `paused`, `not running`). */
  short: string;
  /** Whether listening is paused (or nothing is known yet): Resume, not Pause. */
  paused: boolean;
  /** Whether Companion runs and reports itself ready, so Pause or Resume can be asked. */
  running: boolean;
  /** Whether speech is heard now. */
  speaking: boolean;
}

export function listeningView(state: AppState): ListeningView {
  const status = listeningStatus(state);
  const engine = state.engine;
  const running = state.connection.status === 'online' && engine?.ready === true;
  const paused = !engine || engine.paused;

  let detail = status.description;
  let short = 'listening';
  if (!running) {
    short = 'not running';
  } else if (paused) {
    short = 'paused';
  } else {
    // Listening: what the microphone is doing now. Speech and processing
    // can overlap (an earlier utterance is still being processed).
    const parts: string[] = [];
    if (engine?.speaking) {
      parts.push('Hearing speech');
    }
    if (engine && engine.processing > 0) {
      parts.push(`Processing ${engine.processing}…`);
    }
    if (parts.length === 0) {
      parts.push('Ready for speech');
    }
    detail = parts.join(' · ');
  }
  if (running && engine?.preview) {
    detail = `${detail} · preview mode`;
  }

  return {
    title: status.title,
    detail,
    short,
    paused,
    running,
    speaking: running && !paused && engine?.speaking === true,
  };
}
