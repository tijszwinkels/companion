// A deliberately small HTML language shared by the tool, saved transcripts and
// QML. Rebuild every tag/attribute from an allowlist; never pass model markup to
// Qt unchanged. No accepted construct can load resources or invoke an action.
export const maxHtmlLength = 12288;
export const maxTextLength = 4000;

const tags = new Set(
  'p div span b strong i em u s small sub sup code br hr ul ol li h3 table tr td th'.split(' '),
);
const voidTags = new Set(['br', 'hr']);
const colors = /^(#[0-9a-f]{6}|var\(--(foreground|muted|accent|selection)\))$/;
const entities = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  rarr: '→',
  larr: '←',
  darr: '↓',
  uarr: '↑',
  bull: '•',
  ndash: '–',
  mdash: '—',
};

export function escapeText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textContent(value) {
  // Decode once, then escape again. Entities can represent text, never syntax.
  return escapeText(
    value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name) => {
      if (name[0] !== '#') {
        if (!Object.prototype.hasOwnProperty.call(entities, name)) {
          throw Error('Use literal Unicode instead of unsupported HTML entities.');
        }
        return entities[name];
      }
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (
        !Number.isInteger(code) ||
        code < 32 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        throw Error('Invalid HTML character reference.');
      }
      return String.fromCodePoint(code);
    }),
  );
}

function styleDeclarations(source) {
  const output = [];
  const seen = new Set();
  for (const entry of source.split(';')) {
    if (!entry.trim()) {
      continue;
    }
    const match = /^\s*([a-z-]+)\s*:\s*([^:]+?)\s*$/.exec(entry);
    if (!match || seen.has(match[1])) {
      throw Error('Use distinct supported inline CSS properties.');
    }
    const [, name, value] = match;
    seen.add(name);
    const valid =
      (['color', 'background-color'].includes(name) && colors.test(value)) ||
      (name === 'font-weight' && /^(normal|bold|[4-7]00)$/.test(value)) ||
      (name === 'font-style' && /^(normal|italic)$/.test(value)) ||
      (name === 'text-align' && /^(left|center|right)$/.test(value)) ||
      (name === 'font-size' && /^(1[2-9]|2[0-4])px$/.test(value));
    if (!valid) {
      throw Error(
        `Unsupported HTML style: ${name}. Use colors, font-size (12–24px), font-weight, font-style or text-align.`,
      );
    }
    output.push(`${name}: ${value}`);
  }
  return output.join('; ');
}

function attributes(source, tag) {
  let remaining = source;
  const output = [];
  const seen = new Set();
  while (remaining.trim()) {
    const match = /^\s+([a-z]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(remaining);
    if (!match || seen.has(match[1])) {
      throw Error('HTML attributes must be unique, lowercase and quoted.');
    }
    const name = match[1];
    let value = match[2] ?? match[3];
    seen.add(name);
    remaining = remaining.slice(match[0].length);
    if (name === 'style') {
      value = styleDeclarations(value);
    } else if (name === 'align' && /^(left|center|right)$/.test(value)) {
      // Native QTextDocument alignment; no positioning outside the bubble.
    } else if (
      name === 'width' &&
      ['table', 'td', 'th'].includes(tag) &&
      /^(100|[1-9][0-9]?)%$/.test(value)
    ) {
      // Percentages only. Fixed widths could overflow narrow sidebars.
    } else if (name === 'cellpadding' && tag === 'table' && /^(0|[1-9]|1[0-2])$/.test(value)) {
      // Scaled by the renderer with the reader's zoom level.
    } else if (name === 'cellspacing' && tag === 'table' && /^[0-8]$/.test(value)) {
      // A small gap helps separate diagram nodes.
    } else {
      throw Error(`Unsupported HTML attribute: ${name}.`);
    }
    output.push(` ${name}="${value}"`);
  }
  return output.join('');
}

export function normalizeHtml(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > maxHtmlLength) {
    throw Error(`HTML must contain 1–${maxHtmlLength} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) {
    throw Error('HTML contains a control character.');
  }
  const stack = [];
  const output = [];
  let offset = 0;
  let count = 0;
  let cellsInRow = 0;
  let rowsInTable = 0;
  while (offset < source.length) {
    if (source[offset] !== '<') {
      const next = source.indexOf('<', offset);
      const end = next === -1 ? source.length : next;
      const text = source.slice(offset, end);
      if (['table', 'tr'].includes(stack[stack.length - 1]) && text.trim()) {
        throw Error('Table text belongs inside a td or th cell.');
      }
      output.push(textContent(text));
      offset = end;
      continue;
    }
    const match = /^<(\/?)([a-z][a-z0-9]*)([^<>]*?)>/.exec(source.slice(offset));
    if (!match || !tags.has(match[2])) {
      throw Error(
        'Unsupported HTML tag. Use small text, list or table fragments; no SVG, images, links, scripts or document headers.',
      );
    }
    const [, closing, tag, tail] = match;
    offset += match[0].length;
    if (closing) {
      if (tail.trim() || stack.pop() !== tag || voidTags.has(tag)) {
        throw Error('HTML tags must be balanced.');
      }
      output.push(`</${tag}>`);
      continue;
    }
    count++;
    if (count > 160 || stack.length >= 8) {
      throw Error('Keep HTML under 160 elements and 8 levels deep.');
    }
    const parent = stack[stack.length - 1];
    if (
      (tag === 'tr' && parent !== 'table') ||
      (['td', 'th'].includes(tag) && parent !== 'tr') ||
      (parent === 'table' && tag !== 'tr') ||
      (parent === 'tr' && !['td', 'th'].includes(tag))
    ) {
      throw Error('Use table > tr > td/th for tables.');
    }
    if (tag === 'table') {
      if (stack.includes('table')) {
        throw Error('Nested tables are unsupported.');
      }
      rowsInTable = 0;
    }
    if (tag === 'tr') {
      rowsInTable++;
      cellsInRow = 0;
    }
    if (tag === 'td' || tag === 'th') {
      cellsInRow++;
    }
    if (cellsInRow > 4 || rowsInTable > 12) {
      throw Error('Keep each table within 4 columns and 12 rows.');
    }
    const selfClosing = /\/\s*$/.test(tail);
    if (selfClosing && !voidTags.has(tag)) {
      throw Error('Only br and hr may be self-closing.');
    }
    output.push(`<${tag}${attributes(selfClosing ? tail.replace(/\/\s*$/, '') : tail, tag)}>`);
    if (!voidTags.has(tag)) {
      stack.push(tag);
    }
  }
  if (stack.length) {
    throw Error('HTML tags must be balanced.');
  }
  const html = output.join('');
  if (html.length > maxHtmlLength) {
    throw Error('Normalized HTML exceeds the size limit.');
  }
  return html;
}

export function parseHtmlBubble(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > maxTextLength
  ) {
    throw Error(
      `A version 1 HTML bubble needs a useful text fallback of 1–${maxTextLength} characters.`,
    );
  }
  return { version: 1, html: normalizeHtml(value.html), text: value.text };
}

export function renderHtml(source, scale, foreground, muted, accent, selection) {
  const palette = { foreground, muted, accent, selection };
  // Theme values come from QML colors, not model CSS. Substitute only inside
  // validated attributes so literal explanation text remains untouched.
  const html = normalizeHtml(source).replace(/<[^>]+>/g, (tag) =>
    tag
      .replace(/var\(--(foreground|muted|accent|selection)\)/g, (_, name) => palette[name])
      .replace(
        /font-size: (\d+)px/g,
        (_, size) => `font-size: ${Math.round(Number(size) * scale)}px`,
      )
      .replace(
        /(cellpadding|cellspacing)="(\d+)"/g,
        (_, name, size) => `${name}="${Math.round(Number(size) * scale)}"`,
      ),
  );
  return `<html><head><style>p, div, h3 { margin-top: 4px; margin-bottom: 6px; } table { margin-top: 4px; margin-bottom: 4px; } code { font-family: monospace; }</style></head><body>${html}</body></html>`;
}
