/**
 * Plain-text extraction of an HTML page for `fetch_content`'s default
 * `readable` mode, without adding an HTML parser dependency.
 *
 * This is deliberately simple and predictable: scripts, styles and other
 * non-content elements are removed, block elements become line breaks, list
 * items get a `- ` prefix, links keep their text, character references are
 * decoded and whitespace is collapsed. It does not guess the main article or
 * produce Markdown like Pi's Readability/Defuddle pipeline, so a page's text
 * can differ from what Pi shows. For exact source text, `mode: "raw"` returns
 * the unmodified response body.
 */

/** Elements whose content is never page text. */
const removedElements = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'head',
];

/** Elements that start a new line. */
const blockElements = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const namedCharacters: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  times: '×',
  deg: '°',
};

/** Decode numeric and common named character references. */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (reference, name: string) => {
    if (name[0] === '#') {
      const hexadecimal = name[1] === 'x' || name[1] === 'X';
      const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      const valid = Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff;
      return valid ? String.fromCodePoint(codePoint) : reference;
    }

    return namedCharacters[name.toLowerCase()] ?? reference;
  });
}

/** The document title, if any, with references decoded and whitespace collapsed. */
export function htmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) {
    return '';
  }

  return decodeCharacterReferences(match[1]).replace(/\s+/g, ' ').trim();
}

/** The page text as described in the module comment. */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, '');

  for (const element of removedElements) {
    const pattern = new RegExp(`<${element}\\b[\\s\\S]*?<\\/${element}\\s*>`, 'gi');
    text = text.replace(pattern, ' ');
  }

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi, (_tag, slash: string, name: string) => {
    const element = name.toLowerCase();
    if (element === 'li' && slash === '') {
      return '\n- ';
    }
    return blockElements.has(element) ? '\n' : '';
  });

  // Anything that still looks like markup (e.g. a doctype) is dropped.
  text = text.replace(/<![^>]*>/g, '');
  text = decodeCharacterReferences(text);

  const lines: string[] = [];
  for (const line of text.split('\n')) {
    lines.push(line.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim());
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
