/**
 * A bridge tool's successful result: text, optionally followed by images.
 *
 * Pi tools can return inline images (for example a window screenshot). The
 * MCP bridge sends the text as a text block and each image as an MCP image
 * block, which Claude Code passes to the model. Companion's own tool
 * transcript keeps text blocks only, so images never enter its tool storage.
 */
export interface ToolImage {
  mimeType: 'image/png' | 'image/jpeg';
  /** Base64-encoded image bytes. */
  data: string;
}

export interface ToolOutput {
  text: string;
  images?: ToolImage[];
}

/**
 * Largest total base64 image data in one tool result: 5 MiB, the Claude
 * API's per-image limit. It also keeps the result below Companion's 8 MiB
 * limit per stream-json record, in which Claude Code echoes tool results.
 * A larger result is refused with an error, never truncated.
 */
export const maximumToolImageBase64Length = 5 * 1024 * 1024;
