/**
 * The screenshot viewer over the page, as the desktop's ScreenshotViewer.qml:
 * the conversation's title and a close button at the top, the image scaled
 * to fit below. Escape, the close button and a click outside the image
 * close it; focus then returns to where it was (the View screenshot button).
 *
 * The dialog is the phone panel's Modal (integrations/mobile/src/components/
 * Modal.tsx): it makes the rest of the page inert while open, keeps Tab
 * inside the dialog, closes on Escape and on browser Back (a history entry
 * that holds only a number, never the image or its address) and gives focus
 * back. Its state is ./screenshot-viewer.ts.
 */

import { useEffect, useState } from 'preact/hooks';

import { Modal } from '../../../mobile/src/components/Modal.tsx';
import type { ScreenshotViewerState, ViewerState } from './screenshot-viewer.ts';

export function ScreenshotViewer(props: { viewer: ScreenshotViewerState }) {
  const viewer = props.viewer;
  const [state, setState] = useState<ViewerState>(viewer.state);

  useEffect(() => {
    const unsubscribe = viewer.subscribe(() => setState(viewer.state));
    // It can change between the first render and this subscription.
    setState(viewer.state);
    return unsubscribe;
  }, [viewer]);

  if (state.kind === 'closed') {
    return null;
  }

  return (
    <Modal className="screenshot-viewer" title="Screenshot" onClose={() => viewer.close()}>
      {(dismiss) => (
        <>
          <div class="viewer-bar">
            <h2 class="viewer-title" title={state.title}>
              {state.title || 'Screenshot'}
            </h2>
            <button class="bar-button viewer-close" aria-label="Close screenshot" onClick={dismiss}>
              ×
            </button>
          </div>
          <div
            class="viewer-image"
            onClick={(event) => {
              // A click beside the image (not on it) closes, as the
              // desktop's backdrop does.
              if (event.target === event.currentTarget) {
                dismiss();
              }
            }}
          >
            <ViewerBody state={state} viewer={viewer} />
          </div>
        </>
      )}
    </Modal>
  );
}

function ViewerBody(props: { state: ViewerState; viewer: ScreenshotViewerState }) {
  const { state, viewer } = props;
  if (state.kind === 'shown') {
    return <img src={state.imageUrl} alt="Screenshot attached to this message" />;
  }
  if (state.kind === 'failed') {
    return (
      <div class="viewer-note" role="alert">
        <p>{state.message}</p>
        {state.canRetry && (
          <button class="bar-button" onClick={() => viewer.retry()}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <p class="viewer-note" role="status">
      Loading screenshot…
    </p>
  );
}
