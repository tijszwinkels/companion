import { Type } from '@earendil-works/pi-ai';

import { maxHtmlLength, maxTextLength, parseHtmlBubble } from '../../integrations/panel/Html.mjs';

export const htmlToolName = 'companion_html';

/** A display-only Pi extension. The successful RPC result is the publication. */
export const htmlTool = {
  name: htmlToolName,
  label: 'Show a small graphic',
  promptSnippet:
    'Publish a small HTML diagram, comparison or card directly in the Companion conversation.',
  promptGuidelines: [
    'Use companion_html when a small diagram, comparison, card or explanatory graphic would make an answer clearer. Keep visuals compact and informative, use ordinary Markdown for concise answers, and do not decorate every reply. Include a useful standalone text fallback. The tool publishes immediately; continue your answer naturally without waiting for UI interaction.',
  ],
  description:
    'Insert one compact, selectable HTML bubble in this conversation, without a browser or another model call. ' +
    'Provide html and text: text is a complete plain-text alternative used for copying, older clients and unsupported layouts. ' +
    'This is Qt rich text, not browser HTML. Allowed tags: p div span b strong i em u s small sub sup code br hr ul ol li h3 table tr td th. ' +
    'Balance tags; quote lowercase attributes. Use tables (up to 4 columns and 12 rows, no nesting) and Unicode arrows for diagrams. ' +
    'Allowed attributes: align="left|center|right"; table/td/th width="1%" through "100%"; table cellpadding="0" through "12" and cellspacing="0" through "8"; style. ' +
    'Inline CSS supports color/background-color (#rrggbb or var(--foreground), var(--muted), var(--accent), var(--selection)), ' +
    'font-size (12–24px), font-weight (normal/bold/400–700), font-style (normal/italic), text-align (left/center/right). Prefer theme colors and short cell labels. ' +
    'No SVG, images, links, scripts, forms, external resources, style blocks, flex/grid, positioning or arbitrary CSS. ' +
    'Keep under 160 elements and 8 levels deep. Oversized layouts show text instead. Each successful call adds a new bubble; it never edits earlier messages or offers actions. ' +
    'Example html: <table width="100%" cellpadding="8"><tr><td style="background-color: var(--selection)">Input</td><td>→</td><td style="color: var(--accent)">Result</td></tr></table>.',
  parameters: Type.Object({
    html: Type.String({ minLength: 1, maxLength: maxHtmlLength }),
    text: Type.String({ minLength: 1, maxLength: maxTextLength }),
  }),
  async execute(_id: string, parameters: { html: unknown; text: unknown }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const bubble = parseHtmlBubble({ version: 1, html: parameters.html, text: parameters.text });

    return {
      content: [{ type: 'text' as const, text: 'Graphic published in the conversation.' }],
      details: { companionHtml: bubble },
    };
  },
};

export default function registerHtml(pi: { registerTool(tool: typeof htmlTool): void }): void {
  pi.registerTool(htmlTool);
}
