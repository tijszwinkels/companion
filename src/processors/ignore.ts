import type { Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { UserSensorRouter } from '../core/router.ts';

/** A normal routing result for speech that calls for no application action. */
export class Ignore implements UserSensorProcessor {
  readonly name = 'IGNORE';

  // This is the user's prompt text; formatting must not change its contents.
  readonly instruction =
    'Choose this if the utterance is likely not meant to be sent to the system in any of the other defined intents. This can happen, for example, if the user is talking to someone else, talking to himself, or listening to a podcast.';

  constructor(private readonly log: Log) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame): Promise<void> {
    this.log('processor', 'Ignored', frame.id);
  }
}
