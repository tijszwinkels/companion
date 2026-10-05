/**
 * Markdown for assistant messages, with the desktop panel's safety rules
 * (integrations/panel/Markdown.mjs): raw HTML in agent text stays literal,
 * only explicit http(s) links are links, and images never fetch anything —
 * they render as their alt text. Links open outside the app without a
 * referrer or opener.
 *
 * The output is assigned with innerHTML. That is safe only because
 * `html: false` escapes every tag in the source and link targets are
 * validated; keep both settings if this module changes.
 */

import { createParser } from '../../panel/vendor/markdown-it.mjs';

const parser = createParser({ html: false, linkify: false, breaks: false });

parser.validateLink = (url) => /^https?:\/\//i.test(url);

parser.renderer.rules.image = (tokens, index) => {
  return parser.utils.escapeHtml(tokens[index].content || 'Image');
};

parser.renderer.rules.link_open = (tokens, index, options) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer nofollow');
  return parser.renderer.renderToken(tokens, index, options);
};

/** Cache rendered HTML by source text; streaming re-renders the last bubble only. */
const cache = new Map<string, string>();
const cacheLimit = 400;

export function renderMarkdown(source: string): string {
  const cached = cache.get(source);
  if (cached !== undefined) {
    return cached;
  }

  const html = parser.render(source);
  if (cache.size >= cacheLimit) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(source, html);
  return html;
}
