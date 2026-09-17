import type { UserSensorRouter } from './router.ts';

/** A window image and the identity needed to check focus before text delivery. */
export interface Screenshot {
  /** PNG bytes kept in memory; only the detector converts them to base64. */
  png: Buffer;

  /** Unix time in milliseconds, recorded after the capture has been checked. */
  capturedAt: number;

  window: {
    /** Hyprland's window identity. App name/title alone cannot identify a window. */
    address: string;
    app: string;
    title: string;
  };

  /** Dimensions of the resulting image, after clipping and scaling. */
  width: number;
  height: number;
}

/**
 * The message that flows from the sensors through the router to a processor.
 * Its screenshot is captured at speech end, before transcription can delay it.
 */
export interface UserSensorFrame {
  /** Session-local sequence number, also used to correlate CLI log messages. */
  id: number;

  /** Unix time in milliseconds when this observation entered the pipeline. */
  observedAt: number;

  utterance: string;
  screenshot: Screenshot;
}

/** The part of a processor's registration that the LLM needs to see. */
export interface Intent {
  name: string;
  instruction: string;
}

/** A processor can be selected by the LLM, by a spoken prefix, or by both. */
export interface UserSensorProcessor {
  name: string;

  /** Omit this for commands that must only run when explicitly requested. */
  instruction?: string;

  /** Case-insensitive command prefixes, removed before process receives a frame. */
  prefixes?: readonly string[];

  subscribe(router: UserSensorRouter): void;

  /** LLM routing preserves the frame; prefix routing copies it with the remaining text. */
  process(frame: UserSensorFrame, signal: AbortSignal): Promise<void>;
}

/** Logging is injected so the modules do not depend on terminal presentation. */
export type Log = (stage: string, detail: string, frameId?: number) => void;
