import { createParser } from './vendor/markdown-it.mjs';

// Use a full CommonMark parser for streamed Markdown, then Qt's rich-text
// renderer for selectable text. Only this module supplies HTML and CSS: agent
// HTML stays literal, links are explicit HTTP(S) clicks, and images do not fetch
// remote resources. The original screenshot has its separate trusted viewer.
const parser = createParser({ html: false, linkify: false, breaks: false });
parser.validateLink = (url) => /^https?:\/\//i.test(url);
parser.renderer.rules.image = (tokens, index) => {
  return parser.utils.escapeHtml(tokens[index].content || 'Image');
};

function codeBlock(tokens, index, options, theme) {
  const token = tokens[index];
  const code = parser.utils.escapeHtml(token.content.replace(/\n$/, ''));
  // QTextDocument supports padded table cells, not padded <pre> elements.
  // A one-cell frame gives code a continuous background without splitting its
  // lines into separate UI items or changing copied whitespace.
  return `<table class="code-frame" style="-qt-table-type: frame; background-color: ${theme.codeBackground}; padding: ${Math.round(12 * theme.scale)}px;" width="100%" cellspacing="0" cellpadding="${Math.round(12 * theme.scale)}"><tr><td><pre>${code}</pre></td></tr></table>\n`;
}
parser.renderer.rules.fence = codeBlock;
parser.renderer.rules.code_block = codeBlock;

/** Scale typography and spacing together; code remains smaller and monospace. */
export function render(source, scale, codeBackground, accent) {
  const size = (pixels) => `${Math.round(pixels * scale)}px`;
  const style = `<style>
    p { margin-top: ${size(6)}; margin-bottom: ${size(12)}; line-height: 145%; }
    h1, h2, h3, h4, h5, h6 { margin-top: ${size(18)}; margin-bottom: ${size(10)}; line-height: 125%; font-weight: 600; }
    h1 { font-size: ${size(25)}; }
    h2 { font-size: ${size(22)}; }
    h3 { font-size: ${size(19)}; }
    h4, h5, h6 { font-size: ${size(17)}; }
    ul, ol { margin-top: ${size(8)}; margin-bottom: ${size(12)}; }
    li { margin-top: ${size(4)}; margin-bottom: ${size(5)}; line-height: 140%; }
    blockquote { margin-top: ${size(10)}; margin-bottom: ${size(12)}; margin-left: ${size(16)}; }
    code { font-family: monospace; font-size: ${size(14)}; background-color: ${codeBackground}; }
    pre { font-family: monospace; font-size: ${size(14)}; white-space: pre-wrap; margin-top: 0; margin-bottom: 0; margin-left: ${size(12)}; margin-right: ${size(12)}; line-height: 135%; }
    table { border-collapse: collapse; margin-top: ${size(10)}; margin-bottom: ${size(14)}; }
    th, td { padding: ${size(6)}; }
    th { font-weight: 600; background-color: ${codeBackground}; }
    a { color: ${accent}; text-decoration: underline; }
  </style>`;
  const body = parser.render(source, { scale, codeBackground });
  return `<html><head>${style}</head><body>${body}</body></html>`;
}
