import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { IntentMode, UserSensorRouter } from '../core/router.ts';
import { voiceLabel } from '../core/voice-shortcut.ts';

// Accept only complete cardinal labels, never a partial or ambiguous navigation request.
const spokenNumbers = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
];

// Inferred requests count every number they mention, so these only ever cause a skip.
const otherNumberWords =
  /^(?:zero|seventeen|eighteen|nineteen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|million|billion)s?$/u;
const ordinalWords =
  /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|(?:thir|four|fif|six|seven|eigh|nine)teenth|(?:twen|thir|for|fif|six|seven|eigh|nine)tieth|hundredth|thousandth|millionth)$/u;

// "That one" or "the next one" is a pronoun, not an explicit session number.
const pronounDeterminers = new Set([
  'a',
  'an',
  'another',
  'any',
  'each',
  'every',
  'last',
  'latest',
  'new',
  'next',
  'no',
  'old',
  'only',
  'other',
  'previous',
  'right',
  'same',
  'some',
  'that',
  'the',
  'these',
  'this',
  'those',
  'what',
  'which',
]);

/** Exact shortcut suffix: one complete numeral or cardinal label, nothing else. */
function shortcutIndex(utterance: string): number {
  const label = voiceLabel(utterance);
  return /^(?:[1-9]|[1-9][0-9])$/u.test(label) ? Number(label) - 1 : spokenNumbers.indexOf(label);
}

/**
 * The model chose navigation but supplies no target. Accept exactly one explicit
 * number in the whole utterance; any second, ordinal, decimal, signed or
 * out-of-range number makes the request ambiguous, never a guess.
 */
function inferredIndex(utterance: string): number {
  const words = [
    ...utterance
      .toLowerCase()
      .matchAll(/(?<![\p{L}\p{N}])([-+−]?)([\p{L}\p{N}]+(?:[.,'’][\p{L}\p{N}]+)*)/gu),
  ];
  const indexes: number[] = [];

  for (const [position, [, sign, word]] of words.entries()) {
    if (/\p{N}/u.test(word)) {
      indexes.push(!sign && /^[1-9][0-9]?$/u.test(word) ? Number(word) - 1 : -1);
    } else if (spokenNumbers.includes(word)) {
      const pronoun =
        word === 'one' &&
        (pronounDeterminers.has(words[position - 1]?.[2] ?? '') ||
          words[position + 1]?.[2] === 'of');
      if (!pronoun) {
        indexes.push(spokenNumbers.indexOf(word));
      }
    } else if (otherNumberWords.test(word) || ordinalWords.test(word)) {
      indexes.push(-1);
    }
  }
  return indexes.length === 1 ? indexes[0] : -1;
}

/**
 * Reserve the entire command prefix, including invalid/out-of-range requests.
 * Inference may also choose this intent; its target comes only from the words.
 */
export class GoToSession implements UserSensorProcessor {
  readonly id = 'go-to-session';
  readonly label = `Go to session 1–${MAX_OPEN_AGENT_SESSIONS}`;
  readonly name = 'GO_TO_SESSION';
  readonly prefixes = ['go to session'];
  readonly acceptsEmptyPrefix = true;
  readonly dependencies = {};

  readonly instruction =
    'Choose this if the user asks to switch to, go to, open or show one of the conversations listed in the assistant sidebar by its session number, for example "let\'s switch to session six". Do not choose this for text that the user is dictating into the active application, for a question to the assistant about sessions, or for a request to start, continue or close a conversation.';

  constructor(
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  availableForInference(context: IntentContext): boolean {
    return Boolean(context.interaction?.agentNavigation?.ids.length);
  }

  availableForPrefix(context: IntentContext): boolean {
    return Boolean(context.interaction?.agentNavigation?.ids.length);
  }

  async process(
    frame: UserSensorFrame,
    signal: AbortSignal,
    route: IntentMode = 'shortcut',
  ): Promise<void> {
    signal.throwIfAborted();
    const inferred = route === 'inference';
    const index = inferred ? inferredIndex(frame.utterance) : shortcutIndex(frame.utterance);
    const context = frame.interaction;
    if (index < 0 || index >= MAX_OPEN_AGENT_SESSIONS || !context?.agentNavigation?.ids[index]) {
      this.log(
        'skipped',
        inferred
          ? `Inferred session navigation requires exactly one existing session number from 1 to ${MAX_OPEN_AGENT_SESSIONS}`
          : `Go to session requires an existing session number from 1 to ${MAX_OPEN_AGENT_SESSIONS}`,
        frame.id,
      );
      this.activity.outcome?.(frame.id, 'skipped');
      return;
    }
    if (this.preview) {
      this.log('preview', `Would select session ${index + 1}`, frame.id);
      this.activity.outcome?.(frame.id, 'preview');
      return;
    }
    const selected = this.activity.selectSession?.(context, index) === true;
    this.log(
      selected ? 'session' : 'skipped',
      selected
        ? `Selected session ${index + 1}`
        : 'Session navigation target changed while processing',
      frame.id,
    );
    this.activity.outcome?.(frame.id, selected ? 'selected' : 'skipped');
  }
}
