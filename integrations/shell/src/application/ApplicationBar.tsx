/**
 * The Companion bar above a conversation's session application and its chat
 * (integrations/shell/README.md, "Session applications"). It belongs to the
 * shell's own page, above the application's frame, so the application can
 * neither draw over it nor remove the way back to the chat.
 *
 * From the left:
 * - the application's name and version (`notes · v2`); in the switch layout
 *   a `Chat | notes · v2` switch instead, as on the desktop;
 * - the short permission status (`Chat reading off · sending off`), while
 *   the application asks to read or send chat;
 * - ▣ App only (split layout), or ◫ Chat at the right (switch layout, while
 *   the window has room for the split layout);
 * - Permissions… (Hide permissions while the rows are shown), while the
 *   application asks to read or send chat.
 * Below them, on its own line: the "is ready" notice of an application
 * that arrived while bringing it forward would have interrupted input.
 *
 * A conversation whose application has no frame address (no frame origin
 * on the gateway) gets `NotSetUpBar` instead: the name and one line.
 */

import { ActionButton } from '../activity/ActionButton.tsx';
import type { ApplicationLayout } from './application-layout.ts';
import type { SurfaceMode } from './application-view.ts';
import { applicationPaneId } from './ApplicationPane.tsx';
import { applicationLabel, type ShownApplication } from './shown-application.ts';

/** The element the chat is drawn in (the switch's `aria-controls`). */
export const applicationChatId = 'application-chat';

export function ApplicationBar(props: {
  application: ShownApplication;
  layout: ApplicationLayout;
  /** What the switch layout shows. */
  mode: SurfaceMode;
  onMode: (mode: SurfaceMode) => void;
  /** The window has room for the chat at the right (◫ is offered in the switch layout). */
  splitPossible: boolean;
  onSplit: (split: boolean) => void;
  /** The short permission status, or '' when the application asks for neither. */
  summary: string;
  /** Whether the permission rows can be shown (the application asks for one). */
  permissions: boolean;
  /** The rows are shown. */
  permissionsOpen: boolean;
  /** Hide permissions is available (nothing keeps the rows open). */
  canHide: boolean;
  onPermissions: (open: boolean) => void;
  /** The "is ready" notice, or ''. */
  notice: string;
}) {
  const label = applicationLabel(props.application);

  let identity = <span class="application-name">{label}</span>;
  if (props.layout === 'switch') {
    identity = (
      <span class="surface-switch" role="group" aria-label="Show the chat or the application">
        <button
          class="surface-choice"
          aria-pressed={props.mode === 'chat'}
          aria-controls={applicationChatId}
          title="Show this conversation's chat and history"
          onClick={() => props.onMode('chat')}
        >
          Chat
        </button>
        <button
          class="surface-choice"
          aria-pressed={props.mode === 'app'}
          aria-controls={applicationPaneId}
          title="Show this conversation's application"
          onClick={() => props.onMode('app')}
        >
          {label}
        </button>
      </span>
    );
  }

  let layoutButton = null;
  if (props.layout === 'split') {
    layoutButton = (
      <button
        class="panel-action small application-bar-action"
        title="Show the app alone, with a Chat | App switch"
        onClick={() => props.onSplit(false)}
      >
        ▣ App only
      </button>
    );
  } else if (props.splitPossible) {
    layoutButton = (
      <button
        class="panel-action small application-bar-action"
        title="Show the chat to the right of the app"
        onClick={() => props.onSplit(true)}
      >
        ◫ Chat at the right
      </button>
    );
  }

  let permissionsButton = null;
  if (props.permissions) {
    let text = 'Permissions…';
    let title = "Review or revoke this application's chat permissions";
    let available = true;
    if (props.permissionsOpen) {
      text = 'Hide permissions';
      title = "Hide this application's chat permission controls";
      available = props.canHide;
    }
    permissionsButton = (
      <ActionButton
        available={available}
        onPress={() => props.onPermissions(!props.permissionsOpen)}
        class="panel-action small application-bar-action"
        title={title}
        expanded={props.permissionsOpen}
      >
        {text}
      </ActionButton>
    );
  }

  return (
    <div class="application-bar" role="group" aria-label={`Application ${label}`}>
      <div class="application-bar-row">
        {identity}
        {props.summary && <span class="application-status">{props.summary}</span>}
        <span class="application-bar-actions">
          {layoutButton}
          {permissionsButton}
        </span>
      </div>
      {props.notice && (
        <p class="application-notice" role="status">
          {props.notice}
        </p>
      )}
    </div>
  );
}

/** No frame address: the application is named, the chat is shown alone. */
export function NotSetUpBar(props: { application: ShownApplication }) {
  return (
    <div class="application-bar" role="group">
      <div class="application-bar-row">
        <span class="application-name">{applicationLabel(props.application)}</span>
        <span class="application-status">
          Applications are not set up for this browser, so only the application's name is shown.
        </span>
      </div>
    </div>
  );
}
