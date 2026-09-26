/** The desktop panel's vendored markdown-it bundle (see integrations/panel/vendor). */
declare module '*/panel/vendor/markdown-it.mjs' {
  interface Token {
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
    content: string;
  }
  interface Renderer {
    rules: Record<
      string,
      (tokens: Token[], index: number, options: unknown, env: unknown, self: Renderer) => string
    >;
    renderToken(tokens: Token[], index: number, options: unknown): string;
  }
  interface Parser {
    render(source: string): string;
    renderer: Renderer;
    utils: { escapeHtml(text: string): string };
    validateLink: (url: string) => boolean;
  }
  export function createParser(options: {
    html: boolean;
    linkify: boolean;
    breaks: boolean;
  }): Parser;
}

/** esbuild bundles imported CSS into app.css. */
declare module '*.css';
