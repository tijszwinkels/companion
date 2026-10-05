import { EventEmitter } from 'node:events';

/**
 * The live on/off state of automatic transcription cleanup.
 *
 * Off by default. The desktop runtime loads the persisted choice at startup
 * and changes it when the user clicks the switch; the router reads `enabled`
 * once at the start of each routed utterance, so a click during processing
 * applies to the next utterance, never halfway through one.
 *
 * Emits `change` after the value changed, so the desktop can publish it.
 */
export class TranscriptionCleanupSetting extends EventEmitter {
  private value = false;

  get enabled(): boolean {
    return this.value;
  }

  set(enabled: boolean): void {
    if (enabled === this.value) {
      return;
    }

    this.value = enabled;
    this.emit('change');
  }
}
