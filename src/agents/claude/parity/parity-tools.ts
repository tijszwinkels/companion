/**
 * The Pi-parity tools a Claude Code turn gets, selected by the opt-in
 * `claude-tools.json` (see `settings.ts`). Each configured group adds the
 * Companion-owned equivalents of the Pi extension tools of the same names.
 *
 * Unlike the widget and session tools, these need no Companion lease: as in
 * Pi, they act on the desktop or on external services, not on Companion's own
 * conversations. They live in the bridge process, which Claude Code ends with
 * the turn, so nothing outlives the turn except what the tools document.
 */
import type { BridgeTool } from '../bridge-tools.ts';
import { desktopTools } from './desktop/desktop-tools.ts';
import { openRigTools } from './openrig/openrig-tools.ts';
import type { ClaudeToolSettings } from './settings.ts';
import { ContentStore } from './web/content-store.ts';
import { webTools } from './web/web-tools.ts';

export function parityTools(settings: ClaudeToolSettings): BridgeTool[] {
  const tools: BridgeTool[] = [];

  if (settings.desktop) {
    tools.push(...desktopTools({ pointerHelper: settings.desktop.pointerHelper }));
  }

  if (settings.openRig) {
    tools.push(...openRigTools({ directory: settings.openRig.directory }));
  }

  if (settings.web) {
    tools.push(...webTools({ store: ContentStore.forEnvironment(process.env) }));
  }

  return tools;
}
