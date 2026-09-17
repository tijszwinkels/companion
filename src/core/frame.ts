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

/** A processor describes its intent and handles frames classified with that name. */
export interface UserSensorProcessor extends Intent {
  subscribe(router: UserSensorRouter): void;

  /** Receives the original frame; the detector returns no rewritten payload. */
  process(frame: UserSensorFrame, signal: AbortSignal): Promise<void>;
}

/** Logging is injected so the modules do not depend on terminal presentation. */
export type Log = (stage: string, detail: string, frameId?: number) => void;
