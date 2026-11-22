/**
 * Scrolling through a widget frame (integrations/shell/README.md, "Inline
 * widgets", scrolling over a widget).
 *
 * A wheel or touch over an inline widget goes to the frame's own document
 * (another origin, in another process). When the frame cannot scroll any
 * further, the browser scrolls the transcript instead, and the chat page
 * (Chat.tsx) sees a scroll without any input of the reader's: it takes it
 * for a layout change and, while it follows the live end, pulls the view
 * straight back there. The shell cannot see that input either (no event and
 * no hover state reach the page from such a frame).
 *
 * What it can see is the scroll itself. A scroll toward the start of the
 * transcript while the transcript's size and its content's height are what
 * they were at the previous scroll event is no layout change (a layout
 * change that moves the view changes one of them, and the browser pulling
 * the view back after the content shrank changes the content's height), and
 * the chat page's own scrolls toward the start happen only when one of them
 * changed (keeping the reader's row in place). So it is the reader's, and
 * the shell tells the chat page so before the page's own scroll handler
 * runs: a synthetic `wheel` event on the transcript reaches its reader-input
 * mark (`onWheel`), exactly as a wheel over a message would.
 *
 * Only while at least one inline widget frame is in the transcript
 * (`watchTranscript` is reference-counted by the panels), so a chat without
 * widgets behaves exactly as before.
 */

/** The transcript's scroll state at one scroll event. */
export interface ScrollGeometry {
  top: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the scroll from `previous` to `current` must be the reader's:
 * toward the start, with the same scroll height and viewport height.
 */
export function readerScrollThroughFrame(
  previous: ScrollGeometry | null,
  current: ScrollGeometry,
): boolean {
  if (previous === null) {
    return false;
  }
  if (current.scrollHeight !== previous.scrollHeight) {
    return false;
  }
  if (current.clientHeight !== previous.clientHeight) {
    return false;
  }
  return current.top < previous.top;
}

/** Panels watching each transcript, and how to stop watching it. */
const watched = new Map<Element, { panels: number; stop: () => void }>();

/**
 * Watch `transcript` while at least one panel needs it; returns the
 * function that releases this panel's interest.
 */
export function watchTranscript(transcript: Element): () => void {
  let entry = watched.get(transcript);
  if (!entry) {
    let previous: ScrollGeometry | null = geometryOf(transcript);
    const scrolled = () => {
      const current = geometryOf(transcript);
      if (readerScrollThroughFrame(previous, current)) {
        transcript.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      }
      previous = current;
    };
    // Captured, so this runs before the chat page's own scroll handler on
    // the transcript for the same event.
    transcript.addEventListener('scroll', scrolled, { capture: true });
    // A size change without a scroll event (content that grew while the
    // reader is away from the end) becomes the new comparison, so the
    // reader's next scroll is compared with the sizes they scroll in.
    const resized = new ResizeObserver(() => {
      previous = geometryOf(transcript);
    });
    resized.observe(transcript);
    if (transcript.firstElementChild) {
      resized.observe(transcript.firstElementChild);
    }
    entry = {
      panels: 0,
      stop: () => {
        transcript.removeEventListener('scroll', scrolled, { capture: true });
        resized.disconnect();
      },
    };
    watched.set(transcript, entry);
  }

  entry.panels++;
  const own = entry;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    own.panels--;
    if (own.panels === 0) {
      own.stop();
      watched.delete(transcript);
    }
  };
}

function geometryOf(element: Element): ScrollGeometry {
  return {
    top: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}
