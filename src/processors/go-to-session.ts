import { MAX_OPEN_AGENT_SESSIONS } from '../agents/session-limit.ts';
import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame, UserSensorProcessor } from '../core/frame.ts';
import type { IntentMode, UserSensorRouter } from '../core/router.ts';
import { voiceLabel } from '../core/voice-shortcut.ts';

// Accept only complete cardinal labels, never a partial or ambiguous navigation request.
const unitWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const smallNumbers = [
  ...unitWords,
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const tensWords = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * One English cardinal: a single word ("seven", "thirty") or a tens word and a
 * unit joined by one space or hyphen ("twenty one", "thirty-two"). Callers
 * apply the open-session range; larger values here are simply out of range.
 */
function cardinalValue(first: string, unit?: string): number | undefined {
  const tens = tensWords.indexOf(first);
  if (unit !== undefined) {
    return tens >= 0 && unitWords.includes(unit)
      ? (tens + 2) * 10 + unitWords.indexOf(unit) + 1
      : undefined;
  }
  if (tens >= 0) return (tens + 2) * 10;
  const small = smallNumbers.indexOf(first);
  return small >= 0 ? small + 1 : undefined;
}

// Inferred requests count every number they mention, so these only ever cause a skip
// (plurals such as "twentys" and words with no session position).
const otherNumberWords =
  /^(?:zero|seventeen|eighteen|nineteen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|dozen|hundred|thousand|million|billion|trillion|half|halves|quarter)(?:s|ish)?$/u;
// Words next to a number that make it approximate or one of several choices.
// They are matched as the neighbouring word, so punctuation cannot hide them:
// "about twenty-one", "twenty-one, or so", "twenty-one or something", "thirty odd".
const approximateBefore = new Set([
  'about',
  'around',
  'approximately',
  'roughly',
  'nearly',
  'almost',
  'circa',
  'some',
  'maybe',
  'perhaps',
  'over',
  'under',
]);
const approximateAfter = new Set(['or', 'something', 'odd', 'ish', 'plus', 'thereabouts']);
// A spoken sign or decimal marker right before a number, across any punctuation:
// "minus six", "minus, twenty-one", "point... six".
const markerBefore = new Set(['minus', 'negative', 'plus', 'point', 'dot']);
// A number word with something attached ("fiveish", "twentyish", "sixes",
// "twentyfive", "twenties") is a number, but never an exact position.
const numberStems = [
  ...smallNumbers,
  ...tensWords,
  'zero',
  'dozen',
  'hundred',
  'thousand',
  'million',
  'billion',
  'trillion',
];
const attachedSuffixes = new Set([
  'ish',
  's',
  'es',
  'th',
  'ths',
  'fold',
  'something',
  'odd',
  'some',
  ...smallNumbers,
]);
const tensForms = /^(?:twen|thir|for|fif|six|seven|eigh|nine)ti(?:es|eths?)$/u;
function attachedNumber(word: string): boolean {
  return (
    tensForms.test(word) ||
    numberStems.some(
      (stem) => word.startsWith(stem) && attachedSuffixes.has(word.slice(stem.length)),
    )
  );
}
// Every dash ASR may write (hyphen, non-breaking hyphen, en/em dash, minus...)
// reads as "-", so a sign, compound or attachment looks the same in all forms.
const dashes = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu;
// The separator a spoken compound may use: one space or one hyphen.
const compoundJoin = /^(?:\s+|-)$/u;
const ordinalWords =
  /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|(?:thir|four|fif|six|seven|eigh|nine)teenth|(?:twen|thir|for|fif|six|seven|eigh|nine)tieth|hundredth|thousandth|millionth)$/u;

// "One" is often a pronoun ("that one", "the left one", "one of them"). It is a
// target only right after a navigation noun; elsewhere it is an ambiguous mention.
const explicitOne = /(?:session|tab|conversation|chat|number)\s+$/u;

/** Exact shortcut suffix: one complete numeral or cardinal label, nothing else. */
export function shortcutIndex(utterance: string): number {
  const label = voiceLabel(utterance).replace(dashes, '-');
  if (/^(?:[1-9]|[1-9][0-9])$/u.test(label)) return Number(label) - 1;
  const words = /^([a-z]+)(?:[ -]([a-z]+))?$/u.exec(label);
  const value = words ? cardinalValue(words[1], words[2]) : undefined;
  return value === undefined ? -1 : value - 1;
}

/**
 * The model chose navigation but supplies no target. Accept exactly one explicit
 * number in the whole utterance; any second, ordinal, decimal, signed,
 * approximate or out-of-range number makes the request ambiguous, never a guess. Punctuation
 * separates words, so it cannot hide a mention or join two of them.
 */
export function inferredIndex(utterance: string): number {
  const text = utterance.toLowerCase().replace(dashes, '-');
  const indexes: number[] = [];

  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

  for (let position = 0; position < words.length; position++) {
    const { word, start } = words[position];
    // "twenty one" and "twenty-one" are one number, so the unit is consumed here.
    const next = words[position + 1];
    const unit =
      tensWords.includes(word) &&
      next &&
      unitWords.includes(next.word) &&
      compoundJoin.test(text.slice(words[position].end, next.start))
        ? next
        : undefined;
    const previous = words[position - 1]?.word ?? '';
    if (unit) position++;
    const following = words[position + 1]?.word ?? '';
    const end = unit ? unit.end : words[position].end;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // A written or spoken sign ("-6", "- six", "-, six", "minus, six") or
    // decimal/grouping part (".6", "point six", "6.5", "1,000", "6:30").
    // Approximate: attached to another word by a hyphen ("twenty-something",
    // "6-ish", "3-4"), or next to a qualifier across any punctuation.
    const malformed =
      /[-+−][^\p{L}\p{N}]*$/u.test(before) ||
      markerBefore.has(previous) ||
      /[.,:]$/u.test(before) ||
      /^[.,:]\p{N}/u.test(after) ||
      /^-[\p{L}\p{N}]/u.test(after) ||
      approximateBefore.has(previous) ||
      approximateAfter.has(following);
    const value = cardinalValue(word, unit?.word);

    if (/\p{N}/u.test(word)) {
      indexes.push(!malformed && /^[1-9][0-9]?$/u.test(word) ? Number(word) - 1 : -1);
    } else if (value !== undefined) {
      const explicit = word !== 'one' || explicitOne.test(before);
      indexes.push(!malformed && explicit ? value - 1 : -1);
    } else if (otherNumberWords.test(word) || ordinalWords.test(word) || attachedNumber(word)) {
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
