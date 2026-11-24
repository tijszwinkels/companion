/**
 * The permission rows below the application's bar (integrations/shell/README.md,
 * "Session applications", permission rule): Read and Send, each with its
 * status, review → Allow (with the desktop's disclosure text) and Revoke,
 * and one line saying where the grant applies.
 *
 * Drawn by the shell in its own page, outside the application's frame:
 * the frame is on another origin and cannot draw, reach or press them.
 * What they say is allowed is always the listener's latest `chatAccess`;
 * the state of reviews and of a change waiting for its answer is
 * chat-permissions.ts's.
 *
 * Buttons stay focusable while unavailable (../activity/ActionButton.tsx).
 * A pressed button that goes away hands the keyboard focus on, so it is not
 * lost to the page: to the row's disclosure text when a review opened (so a
 * held or repeated Enter on Review can never press Allow: allowing takes a
 * deliberate move to it), else to the row's first button (Allow becomes
 * Revoke once the listener confirms).
 */

import { useLayoutEffect, useRef } from 'preact/hooks';

import { ActionButton } from '../activity/ActionButton.tsx';
import {
  readDisclosure,
  readRequested,
  readStatus,
  scopeText,
  sendDisclosure,
  sendRequested,
  sendStatus,
  type PermissionKind,
  type PermissionRowsState,
} from './chat-permissions.ts';
import type { ApplicationChatAccess } from './shown-application.ts';

/** The rows' element (the bar's Permissions button shows and hides it). */
export const permissionRowsId = 'application-permissions';

export function PermissionRows(props: {
  name: string;
  access: ApplicationChatAccess;
  online: boolean;
  rows: PermissionRowsState;
  /** A change may start now (admitted, nothing waiting). */
  canChange: boolean;
  onReview: (kind: PermissionKind) => void;
  onDecline: (kind: PermissionKind) => void;
  onChange: (kind: PermissionKind, allowed: boolean) => void;
}) {
  const { access, rows } = props;
  const section = useRef<HTMLElement>(null);
  // The button just pressed and its row, until it has gone away (or the
  // focus moved elsewhere).
  const pressed = useRef<{ kind: PermissionKind; button: Element | null } | null>(null);

  // After each drawing: when the pressed button went away and the focus
  // fell to the page with it, the focus moves to that row's open disclosure,
  // else its first button. Focus the reader moved elsewhere is left alone.
  useLayoutEffect(() => {
    const last = pressed.current;
    if (!last) {
      return;
    }
    const focused = document.activeElement;
    if (last.button && last.button.isConnected) {
      if (focused !== last.button) {
        pressed.current = null;
      }
      return;
    }
    pressed.current = null;
    if (focused && focused !== document.body) {
      return;
    }
    const row = section.current?.querySelector<HTMLElement>(`[data-permission="${last.kind}"]`);
    const disclosure = row?.querySelector<HTMLElement>('.permission-disclosure');
    if (disclosure) {
      disclosure.focus();
      return;
    }
    row?.querySelector<HTMLElement>('button')?.focus();
  });

  function press(kind: PermissionKind, action: () => void) {
    pressed.current = { kind, button: document.activeElement };
    action();
  }

  const read = access.read;
  const send = access.send;

  let readRow = null;
  if (readRequested(access)) {
    readRow = (
      <div class="permission-row" data-permission="read">
        <div class="permission-text">
          <strong>Read this conversation</strong>
          <span class="permission-status">{readStatus(access, props.online)}</span>
          {rows.reviewingRead && <Disclosure text={readDisclosure} />}
        </div>
        <div class="permission-actions">
          {!rows.reviewingRead && !read && (
            <ActionButton
              available={props.canChange}
              onPress={() => press('read', () => props.onReview('read'))}
              class="panel-action small"
            >
              Review chat access
            </ActionButton>
          )}
          {rows.reviewingRead && !read && (
            <ActionButton
              available={props.canChange}
              onPress={() => press('read', () => props.onChange('read', true))}
              class="panel-action small"
            >
              Allow reading
            </ActionButton>
          )}
          {rows.reviewingRead && (
            <ActionButton
              available={!rows.waiting}
              onPress={() => press('read', () => props.onDecline('read'))}
              class="panel-action small"
            >
              Not now
            </ActionButton>
          )}
          {read && (
            <ActionButton
              available={props.canChange}
              onPress={() => press('read', () => props.onChange('read', false))}
              class="panel-action small"
            >
              Revoke reading
            </ActionButton>
          )}
        </div>
      </div>
    );
  }

  let sendRow = null;
  if (sendRequested(access)) {
    let reviewText = 'Review app sending';
    if (send?.allowed) {
      reviewText = 'Review new sending grant';
    }
    sendRow = (
      <div class="permission-row" data-permission="send">
        <div class="permission-text">
          <strong>Send messages as the app</strong>
          <span class="permission-status">{sendStatus(access)}</span>
          {rows.reviewingSend && <Disclosure text={sendDisclosure} />}
        </div>
        <div class="permission-actions">
          {!rows.reviewingSend && (
            <ActionButton
              available={props.canChange && send !== null}
              onPress={() => press('send', () => props.onReview('send'))}
              class="panel-action small"
            >
              {reviewText}
            </ActionButton>
          )}
          {rows.reviewingSend && (
            <ActionButton
              available={props.canChange && send !== null}
              onPress={() => press('send', () => props.onChange('send', true))}
              class="panel-action small"
            >
              Allow 5 app messages
            </ActionButton>
          )}
          {rows.reviewingSend && (
            <ActionButton
              available={!rows.waiting}
              onPress={() => press('send', () => props.onDecline('send'))}
              class="panel-action small"
            >
              Not now
            </ActionButton>
          )}
          {send?.allowed && (
            <ActionButton
              available={props.canChange}
              onPress={() => press('send', () => props.onChange('send', false))}
              class="panel-action small"
            >
              Revoke sending
            </ActionButton>
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      ref={section}
      id={permissionRowsId}
      class="permission-rows"
      aria-label={`Chat permissions of ${props.name}`}
    >
      {readRow}
      {sendRow}
      <p class="permission-scope">{scopeText}</p>
      {rows.feedback && (
        <p class="permission-feedback" role="status">
          {rows.feedback}
        </p>
      )}
    </section>
  );
}

/**
 * A disclosure text, one paragraph per blank-line-separated part. Focusable
 * by script only (`tabIndex` -1): the keyboard focus lands here when the
 * review opens.
 */
function Disclosure(props: { text: string }) {
  const paragraphs = props.text.split('\n\n');
  return (
    <div class="permission-disclosure" tabIndex={-1}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}
