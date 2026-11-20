/**
 * The view operations a widget or application page may use when it is shown
 * outside the desktop, as a frame of the phone gateway's frame origin.
 *
 * This is the single list shared by both ends of that path:
 * - the widget service's private Unix socket route (./socket.ts) serves only
 *   these operations, whoever connects;
 * - the gateway's frame origin (src/remote/frames/) forwards only these, with
 *   the same methods and body limits, for the matching kind of view.
 *
 * Everything else the loopback view route offers stays desktop-only:
 * `frame` and `layout` (offscreen renderer captures), `input` (forwarded
 * pointer and key events), `popout` (opens a desktop window), and `/agent`
 * (agent turn leases).
 *
 * Body limits are the widget service's own (`WidgetService.body` and the
 * session application send limits), so the gateway refuses an oversized body
 * before it reaches the listener.
 */

import { applicationSendLimits } from '../session-apps/sending.ts';

/** Default JSON body limit of a widget or application view request. */
export const viewRequestBytes = 160 * 1024;

/** A widget view or a session application view. */
export type FrameViewKind = 'widget' | 'application';

export interface FrameOperation {
  method: 'GET' | 'POST';
  /** Largest accepted request body in bytes; 0 for GET. */
  requestBytes: number;
  /** View kinds that implement this operation. */
  kinds: readonly FrameViewKind[];
}

/**
 * Keyed by the path segment after `/view/<capability>`; the empty name is the
 * view document itself (`GET /view/<capability>`).
 */
export const frameOperations: Readonly<Record<string, FrameOperation>> = {
  '': { method: 'GET', requestBytes: 0, kinds: ['widget', 'application'] },
  state: { method: 'GET', requestBytes: 0, kinds: ['widget', 'application'] },
  action: { method: 'POST', requestBytes: viewRequestBytes, kinds: ['widget', 'application'] },
  present: { method: 'POST', requestBytes: viewRequestBytes, kinds: ['widget'] },
  viewport: { method: 'POST', requestBytes: viewRequestBytes, kinds: ['widget'] },
  query: { method: 'POST', requestBytes: viewRequestBytes, kinds: ['application'] },
  'chat-read': { method: 'POST', requestBytes: viewRequestBytes, kinds: ['application'] },
  'chat-send': {
    method: 'POST',
    requestBytes: applicationSendLimits.requestBytes,
    kinds: ['application'],
  },
  'chat-receipt': {
    method: 'POST',
    requestBytes: applicationSendLimits.receiptRequestBytes,
    kinds: ['application'],
  },
};

/** The operation for a path segment, or undefined when it is not on the list. */
export function frameOperation(name: string): FrameOperation | undefined {
  if (!Object.hasOwn(frameOperations, name)) {
    return undefined;
  }
  return frameOperations[name];
}
