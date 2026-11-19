import assert from 'node:assert/strict';
import test from 'node:test';

import type { Activity } from '../../src/core/activity.ts';
import type { InteractionContext, UserSensorFrame } from '../../src/core/frame.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { PopOutSession } from '../../src/processors/pop-out-session.ts';
import { frame, signal } from '../helpers.ts';

/**
 * Generated combinations for inferred session navigation (review R4/R5): every
 * position 1–40 in each written form, combined with attached suffixes,
 * qualifiers, sign/decimal markers and the separators speech recognition may
 * put between them. Expectations come from the generator, not from the parser:
 * a plain number from 1 to 32 is a target; anything else is refused. Both
 * GO_TO_SESSION and POP_OUT_SESSION are driven through their processors.
 */

const units = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const small = [
  ...units,
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
const tens = ['twenty', 'thirty', 'forty'];

/** Every way a position may be written: digits, words, hyphen/space/U+2011 compounds. */
function forms(position: number): string[] {
  if (position < 20) return [String(position), small[position - 1]];
  const ten = tens[Math.floor(position / 10) - 2];
  const unit = position % 10;
  if (!unit) return [String(position), ten];
  const word = units[unit - 1];
  return [String(position), `${ten}-${word}`, `${ten} ${word}`, `${ten}‑${word}`];
}

const separators = [' ', ', ', '... ', ' — ', '; ', ' - '];
const attached = ['ish', '-ish', '‑ish', 's', 'th', 'something', '-something', '–odd'];
const qualifiersAfter = ['or so', 'or something', 'odd', 'something', 'plus', 'or thereabouts'];
const qualifiersBefore = ['about', 'around', 'roughly', 'nearly', 'maybe'];
const markerWords = ['minus', 'negative', 'plus', 'point', 'dot'];
const markerSymbols = ['-', '−', '+', '‑', '–'];
// Ordinary words after the number never change it.
const harmlessAfter = ['please', 'about the budget', 'so I can read it', 'now'];

interface Case {
  utterance: string;
  /** Zero-based position, or -1 for a refusal. */
  expected: number;
}

function cases(prefix: string): Case[] {
  const all: Case[] = [];
  for (let position = 1; position <= 40; position++) {
    const target = position <= 32 ? position - 1 : -1;
    for (const number of forms(position)) {
      all.push({ utterance: `${prefix} ${number}`, expected: target });
      for (const separator of separators.slice(0, 3)) {
        for (const words of harmlessAfter) {
          all.push({ utterance: `${prefix} ${number}${separator}${words}`, expected: target });
        }
      }
      for (const suffix of attached) {
        all.push({ utterance: `${prefix} ${number}${suffix}`, expected: -1 });
      }
      for (const separator of separators) {
        for (const qualifier of qualifiersAfter) {
          all.push({ utterance: `${prefix} ${number}${separator}${qualifier}`, expected: -1 });
        }
        for (const qualifier of qualifiersBefore) {
          all.push({ utterance: `${prefix} ${qualifier}${separator}${number}`, expected: -1 });
        }
        for (const marker of markerWords) {
          all.push({ utterance: `${prefix} ${marker}${separator}${number}`, expected: -1 });
        }
        for (const symbol of markerSymbols) {
          all.push({
            utterance: `${prefix} ${symbol}${separator.trimEnd()}${number}`,
            expected: -1,
          });
        }
      }
      // A second number of any form is ambiguous.
      all.push({ utterance: `${prefix} ${number} or 2`, expected: -1 });
      all.push({ utterance: `${prefix} ${number}, or two`, expected: -1 });
      all.push({ utterance: `${prefix} ${number} and a half`, expected: -1 });
      all.push({ utterance: `${prefix} ${number}.5`, expected: -1 });
    }
  }
  return all;
}

const navigation = {
  clientId: 1,
  token: 'visible-page',
  orderRevision: 'unchanged',
  ids: Array.from({ length: 40 }, (_, index) => `session-${index + 1}`),
  popoutHost: true,
};
const interaction: InteractionContext = {
  agentNavigation: navigation,
  agentSessionId: '',
  agentComposerFocused: false,
  revision: 1,
};

for (const [name, prefix, create] of [
  [
    'GO_TO_SESSION',
    'please switch to session',
    (activity: Activity) => new GoToSession(() => {}, false, activity),
  ],
  [
    'POP_OUT_SESSION',
    'please pop out session',
    (activity: Activity) => new PopOutSession(() => {}, false, activity),
  ],
] as const) {
  test(`${name}: generated number, suffix, qualifier and marker combinations`, async () => {
    let chosen = -1;
    const activity: Activity = {
      selectSession: (_context, index) => ((chosen = index), true),
      popOutSession: (_context, index) => ((chosen = index), true),
    };
    const processor = create(activity);
    const failures: string[] = [];
    const all = cases(prefix);
    for (const { utterance, expected } of all) {
      chosen = -1;
      const input: UserSensorFrame = { ...frame, utterance, interaction };
      await processor.process(input, signal(), 'inference');
      if (chosen !== expected) {
        failures.push(`${JSON.stringify(utterance)}: got ${chosen}, expected ${expected}`);
      }
    }
    assert.ok(all.length > 5000, `generated ${all.length} cases`);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${all.length} differ`);
  });
}
