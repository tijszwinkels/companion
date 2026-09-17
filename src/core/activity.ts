/** Results describe actual delivery, rather than just the model's chosen intent. */
export type UtteranceOutcome = 'sent' | 'ignored' | 'skipped' | 'preview' | 'error' | 'cancelled';

/** Desktop observers receive text before classification, even if capture failed. */
export interface Transcript {
  id: number;
  observedAt: number;
  utterance: string;
  application?: { address: string; app: string; title: string };
}

/** Optional feedback keeps the sensor pipeline independent of desktop services. */
export interface Activity {
  /** An explicit manual recovery may supersede a still-pending automatic send. */
  deliveryAllowed?(id: number): boolean;
  processing?(id: number): void;
  transcribed?(transcript: Transcript): void;
  intentRecognized?(id: number, intent: string): void;
  outcome?(id: number, outcome: UtteranceOutcome): void;
  finished?(id: number): void;
}
