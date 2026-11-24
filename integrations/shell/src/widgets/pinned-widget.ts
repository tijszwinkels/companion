/**
 * Which widget a conversation has pinned (the README's "Pinned widgets",
 * pinned state rule), from what the listener reports. Pure, without DOM
 * access; test/shell/pinned-layout.test.ts plays the rule's table.
 *
 * The listener keeps at most one pinned widget per conversation and reports
 * it as the conversation's `pinnedMessage` with every version of the
 * conversation (snapshots and each `agent-session` update), also when its
 * message is outside the loaded history; `null` means none
 * (src/desktop/README.md, "pinnedMessage"). A listener that predates the
 * field sends none at all: the conversation's loaded messages are searched
 * instead, as the desktop panel does.
 *
 * A pinned widget is shown only with a valid frame address on the
 * gateway's frame origin (frame-address.ts). Without one (no frame origin
 * configured) nothing is pinned in the browser and its message keeps its
 * "not set up" card in the chat.
 *
 * A conversation with a session application has no pinned widget in the
 * browser: its pinned widget's message shows its inline frame in the chat
 * (README "Session applications"). The desktop's HTML surface has no rule
 * for the two together (it shows pinned widgets only in its Classic view),
 * so the browser takes the simplest one: the application fills the place,
 * the widget stays in its message.
 */

import type { AgentMessage, AgentSession } from '../../../../src/agents/types.ts';
import { frameAddress } from './frame-address.ts';

/** A conversation's pinned widget as the browser shows it. */
export interface PinnedWidget {
  /** The message the widget is attached to. */
  messageId: string;
  /** The widget's name, shown in its header. */
  name: string;
  /** Its page on the frame origin, exactly as the gateway sent it. */
  address: string;
  /** The height the widget asks for at the top, in percent (the listener's `heightPercent`). */
  heightPercent: number | undefined;
}

/** The pinned message of a conversation, or null (see the module comment). */
function pinnedMessage(session: AgentSession): AgentMessage | null {
  if (session.pinnedMessage !== undefined) {
    return session.pinnedMessage;
  }
  for (const message of session.messages) {
    if (message.widget?.presentation?.placement === 'pinned') {
      return message;
    }
  }
  return null;
}

/** The conversation's pinned widget as the browser shows it, or null. */
export function pinnedWidget(session: AgentSession | undefined): PinnedWidget | null {
  if (!session) {
    return null;
  }
  if (session.application) {
    return null;
  }
  const message = pinnedMessage(session);
  const widget = message?.widget;
  if (!message || !widget || widget.presentation?.placement !== 'pinned') {
    return null;
  }

  // `frameUrl` is not part of the listener's declared attachment type: the
  // gateway adds it for remote clients (src/remote/README.md).
  const address = frameAddress((widget as { frameUrl?: unknown }).frameUrl);
  if (!address) {
    return null;
  }

  return {
    messageId: message.id,
    name: widget.name,
    address,
    heightPercent: widget.presentation.heightPercent,
  };
}

/**
 * Whether the chat page's row `rowKey` (HistoryRows' `<message id>@<offset>`)
 * belongs to the message `messageId` ('' for none).
 */
export function rowOfMessage(messageId: string, rowKey: string): boolean {
  if (messageId === '') {
    return false;
  }
  // The offset follows the last '@'; a message ID may contain one itself.
  return rowKey.slice(0, rowKey.lastIndexOf('@')) === messageId;
}
