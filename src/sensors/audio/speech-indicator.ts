/**
 * "Hearing speech" across several microphones.
 *
 * Purpose: each listening period reports its own speech transitions through
 * `Activity.speechChanged` (true at speech onset, false when it ends or the
 * period stops). With several microphones listening at once, the indicator
 * the user sees is on while ANY microphone hears speech. This joins the
 * reports of every period into that one value.
 *
 * Input:  `reporter(microphone)` gives each period its own `speechChanged`.
 * Output: every report is passed on to `changed(anySpeaking)` at once, in
 *         the same call. With only one microphone the value passed on is
 *         exactly the value reported, so the indicator behaves as before.
 */
export class SpeechIndicator {
  /** Microphones whose latest report was `true`. */
  private readonly speaking = new Set<string>();

  constructor(private readonly changed: (anySpeaking: boolean) => void) {}

  /** The `speechChanged` callback for one microphone's listening periods. */
  reporter(microphone: string): (speaking: boolean) => void {
    return (speaking) => {
      if (speaking) {
        this.speaking.add(microphone);
      } else {
        this.speaking.delete(microphone);
      }

      // Every report is passed on, not only changes of the joined value:
      // the receiver may itself ignore a report (for example while paused)
      // and must see the next one again.
      this.changed(this.speaking.size > 0);
    };
  }
}
