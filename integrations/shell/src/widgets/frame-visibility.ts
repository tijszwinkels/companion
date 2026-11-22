/**
 * The visibility rule (integrations/shell/README.md, "Inline widgets"):
 * whether an inline widget frame counts as visible, which the shell tells
 * the frame (`visible`). host.js polls its widget's state only while it is
 * visible, so a frame the reader cannot see makes no requests.
 *
 * Inputs, each kept up to date by the panel (InlineWidget.tsx):
 * - `inView`: the panel intersects the window, after the transcript's own
 *   scrolling clipped it (an IntersectionObserver);
 * - `pageHidden`: the browser tab is hidden (`document.hidden`);
 * - `covered`: the chat is covered by this page's own screens, the settings
 *   screen or the Activity column lying over it in a narrow window
 *   (chat-cover.ts);
 * - `connected`: requests are admitted (the bridge's `admitted`). While the
 *   shell reconnects the frame is greyed and paused too.
 *
 * A panel of a conversation that is not shown is not in the page at all:
 * its frame is removed with the chat.
 */

export interface VisibilityInputs {
  inView: boolean;
  pageHidden: boolean;
  covered: boolean;
  connected: boolean;
}

export function frameVisible(inputs: VisibilityInputs): boolean {
  return inputs.inView && !inputs.pageHidden && !inputs.covered && inputs.connected;
}
