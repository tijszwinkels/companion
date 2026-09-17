import type { UserSensorRouter } from './router.ts';

export interface Screenshot {
  png: Buffer;
  capturedAt: number;
  window: { address: string; app: string; title: string };
  width: number;
  height: number;
}

/** One observation. The screenshot is taken when speech ends, before ASR. */
export interface UserSensorFrame {
  id: number;
  observedAt: number;
  utterance: string;
  screenshot: Screenshot;
}

export interface Intent {
  name: string;
  instruction: string;
}

export interface UserSensorProcessor extends Intent {
  subscribe(router: UserSensorRouter): void;
  process(frame: UserSensorFrame, signal: AbortSignal): Promise<void>;
}

export type Log = (stage: string, detail: string, frameId?: number) => void;
