/**
 * The pane that shows a conversation's session application
 * (integrations/shell/README.md, "Session applications"): at the left of
 * the chat in the split layout, or in place of it in the switch layout.
 *
 * - An application with a frame address is drawn by the widgets' frame
 *   component (../widgets/InlineWidget.tsx, `WidgetFrame` in its
 *   `application` mode): the same sandbox and attributes, the same states
 *   (loading, shown at its first `geometry`, failed with Try again,
 *   disconnected, the address ended) and the same messages and visibility
 *   rules. A new code version is a new frame (it loads again), as the
 *   desktop reloads its view for each version.
 * - An application the listener could not restore (`unavailable`) shows
 *   the error and its text description.
 *
 * In the switch layout a failed or unavailable application offers the way
 * back to the chat; in the split layout the chat is already beside it.
 *
 * Inputs: the application (shown-application.ts), whether the pane is
 * concealed (the switch layout shows the chat: the frame stays loaded but
 * counts as not visible) and the frame environment.
 */

import type { InlineWidgetEnvironment } from '../widgets/InlineWidget.tsx';
import { WidgetFrame } from '../widgets/InlineWidget.tsx';
import type { ShownApplication } from './shown-application.ts';

/** The pane's element, named by the divider and the bar's switch (`aria-controls`). */
export const applicationPaneId = 'application-pane';

export function ApplicationPane(props: {
  application: Extract<ShownApplication, { kind: 'frame' | 'unavailable' }>;
  concealed: boolean;
  /** The switch layout: offers "Show the chat" in a failed state. */
  switchLayout: boolean;
  onShowChat: () => void;
  environment: InlineWidgetEnvironment;
}) {
  const { application } = props;

  let backToChat = null;
  if (props.switchLayout) {
    backToChat = (
      <div>
        <button class="panel-action small" onClick={props.onShowChat}>
          Show the chat
        </button>
      </div>
    );
  }

  // Shown where the application itself cannot be: its own description.
  const description = (
    <p class="application-description">
      <span class="inline-widget-note">Description: </span>
      {application.text}
    </p>
  );

  let content = null;
  if (application.kind === 'frame') {
    content = (
      <WidgetFrame
        key={application.address + ' ' + application.version}
        mode="application"
        name={application.name}
        time=""
        address={application.address}
        environment={props.environment}
        concealed={props.concealed}
        failedExtra={
          <>
            {description}
            {backToChat}
          </>
        }
      />
    );
  } else {
    content = (
      <div class="panel inline-widget application-frame" data-phase="unavailable">
        <div class="inline-widget-failed">
          <p>
            <strong>The {application.name || 'session'} application is unavailable.</strong>{' '}
            {application.error}
          </p>
          <p class="inline-widget-note">
            The conversation and the application's saved data are unchanged.
          </p>
          {description}
          {backToChat}
        </div>
      </div>
    );
  }

  return (
    <section
      id={applicationPaneId}
      class="application-pane"
      aria-label={`Application ${application.name}`}
      inert={props.concealed}
    >
      {content}
    </section>
  );
}
