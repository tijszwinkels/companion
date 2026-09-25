/**
 * `get_search_content`'s `findText`: locate passages in retained content.
 *
 * This reimplements the contract of pi-web-access's `content-find.ts` (MIT),
 * so results read the same in both harnesses:
 * - `exact` and `case-insensitive` find every literal occurrence;
 * - `fuzzy` matches paragraphs containing most of the query's words, allowing
 *   small spelling differences (edit distance 1 for words of 5–8 characters,
 *   2 from 9 characters) and ignoring case and diacritics;
 * - each match gets 400 characters of context on both sides, overlapping
 *   ranges merge, and the output stops before 20,000 characters, saying how
 *   many matches it shows.
 * Snippets collapse whitespace; the offsets remain those of the stored text.
 */
export type FindMode = 'exact' | 'case-insensitive' | 'fuzzy';

const contextCharacters = 400;
const maximumOutputCharacters = 20_000;

interface Match {
  query: string;
  start: number;
  end: number;
}

interface Range {
  start: number;
  end: number;
  matches: Match[];
}

export interface FindResult {
  text: string;
  matchCount: number;
  returnedMatches: number;
}

function normalizeWord(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

/** Whether two words are within `maximum` single-character edits of each other. */
function withinEditDistance(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) {
    return false;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = i;

    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      current[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    // Every later row can only be larger than this row's minimum.
    if (rowMinimum > maximum) {
      return false;
    }
    previous = current;
  }

  return previous[right.length] <= maximum;
}

function allowedEdits(word: string): number {
  if (word.length >= 9) {
    return 2;
  }
  return word.length >= 5 ? 1 : 0;
}

function literalMatches(text: string, query: string, caseInsensitive: boolean): Match[] {
  const haystack = caseInsensitive ? text.toLocaleLowerCase() : text;
  const needle = caseInsensitive ? query.toLocaleLowerCase() : query;
  const matches: Match[] = [];

  let start = haystack.indexOf(needle);
  while (start >= 0) {
    matches.push({ query, start, end: start + query.length });
    start = haystack.indexOf(needle, start + Math.max(needle.length, 1));
  }

  return matches;
}

function fuzzyMatches(text: string, query: string): Match[] {
  const queryWords = normalizeWord(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (queryWords.length === 0) {
    return [];
  }

  const required = queryWords.length === 1 ? 1 : Math.ceil(queryWords.length * 0.6);
  const matches: Match[] = [];

  // A paragraph is a run of non-empty lines.
  for (const paragraph of text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
    if (paragraph[0].trim().length === 0 || paragraph.index === undefined) {
      continue;
    }

    const words = [...paragraph[0].matchAll(/[\p{L}\p{N}]+/gu)];
    const resembles = (queryWord: string, word: string) =>
      withinEditDistance(queryWord, normalizeWord(word), allowedEdits(queryWord));

    const matchedQueryWords = queryWords.filter((queryWord) =>
      words.some((word) => resembles(queryWord, word[0])),
    );
    if (matchedQueryWords.length < required) {
      continue;
    }

    // The match starts at the paragraph's first word resembling a query word.
    const first = words.find((word) =>
      matchedQueryWords.some((queryWord) => resembles(queryWord, word[0])),
    );
    const start = paragraph.index + (first?.index ?? 0);
    matches.push({ query, start, end: start + (first?.[0].length ?? query.length) });
  }

  return matches;
}

function mergeRanges(textLength: number, matches: Match[]): Range[] {
  const ranges: Range[] = [];
  const ordered = [...matches].sort((left, right) => left.start - right.start);

  for (const match of ordered) {
    const start = Math.max(0, match.start - contextCharacters);
    const end = Math.min(textLength, match.end + contextCharacters);
    const previous = ranges.at(-1);

    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.matches.push(match);
    } else {
      ranges.push({ start, end, matches: [match] });
    }
  }

  return ranges;
}

/** Find `queries` in `text`. `queries` must already be trimmed and non-empty. */
export function findContent(text: string, queries: string[], mode: FindMode): FindResult {
  const uniqueQueries = [...new Set(queries)];
  const matches: Match[] = [];
  for (const query of uniqueQueries) {
    if (mode === 'fuzzy') {
      matches.push(...fuzzyMatches(text, query));
    } else {
      matches.push(...literalMatches(text, query, mode === 'case-insensitive'));
    }
  }

  const heading =
    matches.length > 0 ? `Text matches (${mode})` : `Text matches (${mode}): no matches`;
  const sections = [heading];
  let outputLength = heading.length;
  let returnedMatches = 0;

  for (const range of mergeRanges(text.length, matches)) {
    const prefix = range.start > 0 ? '…' : '';
    const suffix = range.end < text.length ? '…' : '';
    const snippet = text.slice(range.start, range.end).replace(/\s+/g, ' ').trim();

    const counts: string[] = [];
    for (const query of new Set(range.matches.map((match) => match.query))) {
      const count = range.matches.filter((match) => match.query === query).length;
      counts.push(`"${query}" ×${count}`);
    }

    const section = `${sections.length}. ${counts.join(', ')}\n${prefix}${snippet}${suffix}`;
    if (outputLength + 2 + section.length > maximumOutputCharacters) {
      break;
    }
    sections.push(section);
    outputLength += 2 + section.length;
    returnedMatches += range.matches.length;
  }

  const footer: string[] = [];
  const missing = uniqueQueries.filter((query) => !matches.some((match) => match.query === query));
  if (missing.length > 0) {
    footer.push(`No matches: ${missing.map((query) => `"${query}"`).join(', ')}`);
  }
  if (returnedMatches < matches.length) {
    footer.push(`Showing ${returnedMatches} of ${matches.length} matches.`);
  }
  for (const section of footer) {
    if (outputLength + 2 + section.length > maximumOutputCharacters) {
      break;
    }
    sections.push(section);
    outputLength += 2 + section.length;
  }

  return { text: sections.join('\n\n'), matchCount: matches.length, returnedMatches };
}
