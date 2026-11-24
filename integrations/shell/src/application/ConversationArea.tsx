/**
 * The selected conversation below the bar above the chat: its chat and,
 * when it has a session application, the application with the Companion
 * bar and permission rows above both (integrations/shell/README.md,
 * "Session applications").
 *
 *   split (wide window, chat at the right)      switch (App only, narrower)
 *   ┌───────────────────────────┬──────────┐    ┌──────────────────────────┐
 *   │ notes · v2  reading off  ▣ App only  │    │ Chat|notes · v2 … ◫ Perm…│
 *   │ (permission rows)                    │    │ (permission rows)        │
 *   │ application               ┊ chat     │    │ application, or the chat │
 *   └───────────────────────────┴──────────┘    └──────────────────────────┘
 *
 * The element tree is the same in every case: the bar, the rows, the
 * application's pane, the divider and the chat column are keyed children
 * of one area, absent where not drawn. So the chat (its editor, scroll
 * position and following of the live end) is never drawn anew when an
 * application arrives or goes, or when the layout changes; and the
 * application's frame is not loaded again when the reader switches between
 * Chat and the application or between the two layouts. In the switch
 * layout the part not shown stays drawn, hidden and inert (the frame then
 * counts as not visible and stops polling).
 *
 * Owned elsewhere, per pairing (Workspace.tsx): which of chat and
 * application the switch layout shows (application-view.ts) and the
 * permission rows' state (chat-permissions.ts). This component applies
 * the application-change rule with every drawing, before reading them.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { UncertainOutcome } from '../../../mobile/src/connection.ts';
import { useStore } from '../../../mobile/src/hooks.ts';
import { Chat } from '../../../session-apps/chat/Chat.tsx';
import type { ChatStore } from '../../../session-apps/chat/store.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import { Divider } from '../layout/Divider.tsx';
import type { InlineWidgetEnvironment } from '../widgets/InlineWidget.tsx';
import {
  applicationLayout,
  chatPaneMinimum,
  chatPaneWidthFromKey,
  chatPaneWidthFromPointer,
  shownChatPaneWidth,
  splitPossible,
  widestChatPane,
} from './application-layout.ts';
import type { ApplicationModes, SurfaceMode } from './application-view.ts';
import { ApplicationBar, applicationChatId, NotSetUpBar } from './ApplicationBar.tsx';
import { ApplicationPane } from './ApplicationPane.tsx';
import {
  permissionIdentity,
  permissionSummary,
  readRequested,
  sendRequested,
  type ChatPermissions,
  type PermissionKind,
  type PermissionRequest,
} from './chat-permissions.ts';
import { PermissionRows } from './PermissionRows.tsx';
import {
  applicationKey,
  shownApplication,
  type ApplicationChatAccess,
} from './shown-application.ts';
import type { ApplicationLayoutView } from './useApplicationLayout.ts';

export function ConversationArea(props: {
  session: AgentSession;
  chat: ChatStore;
  bridge: GatewayChatBridge;
  environment: InlineWidgetEnvironment;
  /** The settings screen lies over it: inert. */
  covered: boolean;
  windowWidth: number;
  /** The width beside the list and the Activity column (application-layout.ts `areaWidth`). */
  areaWidth: number;
  modes: ApplicationModes;
  permissions: ChatPermissions;
  layout: ApplicationLayoutView;
}) {
  const { session, bridge, modes, permissions } = props;
  const store = useStore();
  const id = session.id;
  const application = shownApplication(session);

  // Drawn again after a choice the reader makes (Chat or the application)
  // and after each change of the permission rows' state.
  const [, setVersion] = useState(0);
  function redraw() {
    setVersion((version) => version + 1);
  }
  useEffect(() => {
    return permissions.subscribe(redraw);
  }, [permissions]);

  // The application with a pane of its own (a frame, or the error of one
  // the listener could not restore); without a frame address it is only
  // named, above the chat.
  let paneApplication = null;
  if (application && application.kind !== 'not-set-up') {
    paneApplication = application;
  }
  const possible = splitPossible(props.windowWidth, props.areaWidth);
  let layout = applicationLayout(props.layout.choice, props.windowWidth, props.areaWidth);
  if (!paneApplication) {
    layout = 'switch';
  }

  // The application-change rule (application-view.ts), for every version of
  // the conversation drawn. With the chat at the right nothing is replaced
  // under the reader's hands, so nothing blocks there.
  const chatColumn = useRef<HTMLDivElement>(null);
  // The conversation the chat column showed in the last drawing: right
  // after a switch it still holds the previous conversation's text box,
  // whose focus is not typing in this one.
  const drawnConversation = useRef('');
  useLayoutEffect(() => {
    drawnConversation.current = id;
  });
  const typing = drawnConversation.current === id && composerFocused(chatColumn.current);
  let blocker = '';
  if (layout === 'switch') {
    blocker = bridge.applicationBlocker(id, typing);
  }
  let name = '';
  if (paneApplication) {
    name = paneApplication.name;
  }
  modes.observe(id, applicationKey(paneApplication), name, blocker);

  // The window narrowed from the split to the switch layout (a resize, a
  // tiling window manager making room) while the reader types in the chat:
  // the switch shows the chat, so the text box does not go away under the
  // reader's hands.
  const previousLayout = useRef(layout);
  // (Only when the room went: ▣ App only is the reader's own choice.)
  if (previousLayout.current === 'split' && layout === 'switch' && !possible && typing) {
    modes.keep(id, 'chat');
  }
  previousLayout.current = layout;
  const mode = modes.mode(id, paneApplication !== null);

  function choose(next: SurfaceMode) {
    modes.choose(id, next);
    redraw();
  }

  // The chat page's own application button, while the switch layout shows
  // the chat in place of the application (as on the desktop).
  const offered = paneApplication !== null && layout === 'switch' && mode === 'chat';
  useLayoutEffect(() => {
    if (!offered || !paneApplication) {
      bridge.offerApplication(null);
      return;
    }
    bridge.offerApplication({
      sessionId: id,
      name: paneApplication.name,
      version: paneApplication.version,
      open: (sessionId) => {
        modes.choose(sessionId, 'app');
        redraw();
      },
    });
  }, [bridge, offered, id, paneApplication?.name, paneApplication?.version]);
  useEffect(() => {
    return () => bridge.offerApplication(null);
  }, [bridge]);

  // The permission rows (chat-permissions.ts), for the application shown.
  let access: ApplicationChatAccess | null = null;
  if (application && application.kind === 'frame') {
    access = application.chatAccess;
  }
  permissions.observe(id, permissionIdentity(id, application));
  const rows = permissions.state();
  const admitted = bridge.admitted;
  const asks = readRequested(access) || sendRequested(access);

  function sendPermission(request: PermissionRequest): Promise<unknown> {
    return store
      .request(request.action, request.parameters, { quiet: true })
      .catch((failure: unknown) => {
        // The answer was lost (the phone Connection never resends it).
        if (failure instanceof UncertainOutcome) {
          throw Object.assign(new Error(failure.message), { uncertain: true });
        }
        throw failure;
      });
  }

  function review(kind: PermissionKind) {
    permissions.review(kind, bridge.admitted, access);
  }

  function change(kind: PermissionKind, allowed: boolean) {
    permissions.change(kind, allowed, {
      sessionId: id,
      application,
      admitted: bridge.admitted,
      send: sendPermission,
    });
  }

  // ---- What is drawn --------------------------------------------------------

  let bar = null;
  if (paneApplication) {
    bar = (
      <ApplicationBar
        key="bar"
        application={paneApplication}
        layout={layout}
        mode={mode}
        onMode={choose}
        splitPossible={possible}
        onSplit={(split) => {
          // ▣ App only shows the application alone, also when the switch
          // last showed the chat here.
          if (!split) {
            modes.choose(id, 'app');
          }
          props.layout.setChoice(split ? 'split' : 'app-only');
        }}
        summary={permissionSummary(access, admitted)}
        permissions={asks}
        permissionsOpen={rows.open}
        canHide={rows.canHide}
        onPermissions={(open) => {
          if (open) {
            permissions.expand();
          } else {
            permissions.collapse();
          }
        }}
        notice={layout === 'switch' ? modes.notice(id) : ''}
      />
    );
  } else if (application) {
    bar = <NotSetUpBar key="bar" application={application} />;
  }

  let rowsElement = null;
  if (paneApplication && access && asks && rows.open) {
    rowsElement = (
      <PermissionRows
        key="permissions"
        name={paneApplication.name}
        access={access}
        online={admitted}
        rows={rows}
        canChange={permissions.canChange(admitted, access)}
        onReview={review}
        onDecline={(kind) => permissions.decline(kind)}
        onChange={change}
      />
    );
  }

  const appShown = paneApplication !== null && (layout === 'split' || mode === 'app');
  const chatShown = paneApplication === null || layout === 'split' || mode === 'chat';

  // The chat's inline widgets are out of sight while the application is in
  // its place (../widgets/chat-cover.ts); the application's frame is not.
  const cover = props.environment.cover;
  useLayoutEffect(() => {
    cover.setChatConcealed(!chatShown);
  }, [cover, chatShown]);
  useEffect(() => {
    return () => cover.setChatConcealed(false);
  }, [cover]);

  let pane = null;
  if (paneApplication) {
    pane = (
      <ApplicationPane
        key="pane"
        application={paneApplication}
        concealed={!appShown}
        switchLayout={layout === 'switch'}
        onShowChat={() => choose('chat')}
        environment={props.environment}
      />
    );
  }

  let chatWidth = 0;
  let divider = null;
  if (layout === 'split') {
    chatWidth = shownChatPaneWidth(props.layout.chatWidth, props.areaWidth);
    divider = (
      <Divider
        key="divider"
        width={chatWidth}
        narrowest={chatPaneMinimum}
        widest={widestChatPane(props.areaWidth)}
        label="Chat width"
        title="Drag to change the width of the chat"
        valueText={`${chatWidth} pixels`}
        className="application-divider"
        controls={applicationChatId}
        fromPointer={(clientX, container) => chatPaneWidthFromPointer(container.right - clientX)}
        fromKey={chatPaneWidthFromKey}
        onWidth={props.layout.setChatWidth}
        onRemember={props.layout.remember}
      />
    );
  }

  let chatClass = 'chat-column';
  let chatStyle: Record<string, string> = {};
  if (layout === 'split') {
    chatClass += ' beside-application';
    chatStyle = { width: `${chatWidth}px` };
  }
  if (!chatShown) {
    chatClass += ' concealed';
  }

  let bodyClass = 'conversation-body';
  if (paneApplication) {
    bodyClass += ` application-${layout}`;
  }

  return (
    <div class="conversation-area" inert={props.covered}>
      {bar}
      {rowsElement}
      <div class={bodyClass}>
        {pane}
        {divider}
        <div
          key="chat"
          ref={chatColumn}
          id={applicationChatId}
          class={chatClass}
          style={chatStyle}
          inert={!chatShown}
        >
          {/* A new chat view for each conversation lifetime: the same ID
              reopened elsewhere (a new tool epoch) starts at its live end
              with a fresh editor, like a different conversation. */}
          <Chat key={session.id + ' ' + (session.toolEpoch ?? '')} store={props.chat} />
        </div>
      </div>
    </div>
  );
}

/** Whether the chat's text box (in `column`) has the keyboard focus: the reader is typing. */
function composerFocused(column: HTMLElement | null): boolean {
  const focused = document.activeElement;
  if (!column || !focused) {
    return false;
  }
  return focused.tagName === 'TEXTAREA' && column.contains(focused);
}
