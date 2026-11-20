/**
 * Transcript rows as the trusted chat page receives them.
 *
 * `rowData` is a line-by-line TypeScript port of `SessionView.rowData()`
 * (integrations/panel/SessionView.qml); the result goes through the same
 * `ChatState.chatRow()` the Qt host uses, so both hosts send the page rows of
 * exactly the same shape. Keep the two in step when either changes.
 *
 * One deliberate difference: the screenshot URL is never passed on. The
 * gateway rewrites it to its authenticated `api/screenshots/<conversation>`
 * route, and this slice has no screenshot viewer, so a row with a screenshot
 * is labelled "screenshot unavailable" instead of offering a View button that
 * could not work. (The gateway also removes widget view URLs; the page shows
 * only the widget's name either way.)
 */

import type { AgentMessage } from '../../../src/agents/types.ts';
import { chatRow } from '../../session-apps/ChatState.mjs';
import type { HistoryRow } from '../../panel/HistoryRows.mjs';
import type { ChatRow } from '../../session-apps/chat/protocol.ts';

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const applicationNamePattern = /^[a-z][a-z0-9-]{0,47}$/;
const bundlePattern = /^[0-9a-f]{64}$/;

/**
 * Whether an application-message origin is complete and well-formed. Only
 * then does its label show the application's name, version and receipt;
 * anything else stays explicitly "unverified" (never a human, never a link).
 */
function verifiedApplication(origin: AgentMessage['origin']): boolean {
  if (!origin || origin.kind !== 'application-message') {
    return false;
  }
  return (
    typeof origin.name === 'string' &&
    applicationNamePattern.test(origin.name) &&
    Number.isSafeInteger(origin.version) &&
    origin.version > 0 &&
    origin.depth === 1 &&
    typeof origin.applicationId === 'string' &&
    uuidPattern.test(origin.applicationId) &&
    typeof origin.receiptId === 'string' &&
    uuidPattern.test(origin.receiptId) &&
    typeof origin.bundle === 'string' &&
    bundlePattern.test(origin.bundle)
  );
}

/** The origin's label: host-derived for applications, the agent's title otherwise. */
function originTitle(message: AgentMessage): string {
  const origin = message.origin;
  if (!origin) {
    return '';
  }
  if (origin.kind === 'application-message') {
    if (verifiedApplication(origin)) {
      return origin.name + ' · v' + origin.version;
    }
    return 'unverified application origin';
  }
  if ('title' in origin && typeof origin.title === 'string') {
    return origin.title;
  }
  return '';
}

/** The sender conversation of an internal agent origin, or ''. */
function originSessionId(message: AgentMessage): string {
  const origin = message.origin;
  if (origin && origin.kind === 'agent') {
    return origin.sessionId || '';
  }
  return '';
}

/** The sender's tool group of an internal agent origin, or ''. */
function originGroupId(message: AgentMessage): string {
  const origin = message.origin;
  if (origin && origin.kind === 'agent') {
    return origin.sourceGroupId || '';
  }
  return '';
}

/** " · text 1–200 of 900" for a fragment of an oversized message, or ''. */
function fragmentLabel(message: AgentMessage): string {
  const fragment = message.historyFragment;
  if (!fragment) {
    return '';
  }
  return ' · text ' + (fragment.start + 1) + '–' + fragment.end + ' of ' + fragment.total;
}

/** `SessionView.rowData()` for one resident row. */
export function rowData(row: HistoryRow): Record<string, unknown> {
  const message = row.message;
  const origin = message.origin;
  const applicationMessage = origin !== undefined && origin.kind === 'application-message';
  const toolGroup = message.toolGroup;
  let originReceiptId = '';
  if (origin && origin.kind === 'application-message' && verifiedApplication(origin)) {
    originReceiptId = origin.receiptId;
  }

  return {
    rowKey: row.key,
    messageId: message.id,
    kind: message.kind,
    body: message.text,
    toolName: message.toolName,
    input: message.input,
    state: message.state,
    toolCount: toolGroup ? toolGroup.count : 0,
    toolUnavailable: toolGroup ? toolGroup.unavailable === true : false,
    toolRevision: toolGroup ? toolGroup.revision : '',
    screenshot: message.screenshot,
    // Not shown in the browser yet (see above).
    screenshotUrl: '',
    // False only when capture storage deliberately did not save it.
    screenshotNotSaved: message.screenshotSaved === false,
    fromWake: origin ? origin.kind === 'scheduled-wake' : false,
    fromExternal: origin ? origin.kind === 'external' : false,
    // The person's own committed edits in this conversation's session
    // application, delivered by the host as a turn; not another agent.
    fromApplication: origin ? origin.kind === 'application-event' : false,
    fromAppMessage: applicationMessage,
    fromAgent: origin !== undefined && origin !== null,
    originTitle: originTitle(message),
    originReceiptId: originReceiptId,
    // External origins carry unverified labels, never a linkable conversation.
    originSessionId: originSessionId(message),
    originGroupId: originGroupId(message),
    fragmentLabel: fragmentLabel(message),
    widgetJson: message.widget ? JSON.stringify(message.widget) : '',
  };
}

/**
 * The page's row for one resident row: `ChatState.chatRow(rowData(row))`,
 * plus the time the message was written (`ChatRow.time`) when `time` is not
 * empty. Without a time the row is exactly the Qt host's.
 */
export function pageRow(row: HistoryRow, time = ''): ChatRow {
  const page: ChatRow = chatRow(rowData(row));
  if (time) {
    page.time = time;
  }
  return page;
}
