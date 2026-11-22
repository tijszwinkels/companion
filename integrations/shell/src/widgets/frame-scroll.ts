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
 * transcript is the reader's when
 * - the transcript's size and its content's height are what they were at
 *   the previous scroll event: no layout change (a layout change that moves
 *   the view changes one of them, and the browser pulling the view back
 *   after the content shrank changes the content's height), and the chat
 *   page's own scrolls toward the start happen only when one of them
 *   changed (keeping the reader's row in place); or
 * - the previous scroll event left the view at the end and it is no longer
 *   there: the content changed at the same moment (an answer streaming, a
 *   widget's frame growing), but growth never moves the view toward the
 *   start, and the browser pulling it back after the content shrank leaves
 *   it at the new end. (The chat page snaps back only from the live end, so
 *   this is exactly the case that matters; without it a reader's scroll
 *   that coincided with such a change was pulled back.)
 * The shell then tells the chat page so before the page's own scroll
 * handler runs: a synthetic `wheel` event on the transcript reaches its
 * reader-input mark (`onWheel`), exactly as a wheel over a message would.
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

/** Within this many pixels of the end the view counts as at the end (as in Chat.tsx). */
const endTolerance = 4;

/** Whether the view of `geometry` is at the end of the transcript. */
export function atEnd(geometry: ScrollGeometry): boolean {
  return geometry.top + geometry.clientHeight >= geometry.scrollHeight - endTolerance;
}

/**
 * Whether the scroll from `previous` to `current` must be the reader's:
 * toward the start, and either with the same scroll height and viewport
 * height, or away from the end where the previous scroll event left the
 * view (`wasAtEnd`). The second case holds when the content changed at the
 * same moment (an answer streaming, a widget's frame growing): content that
 * grows never moves the view toward the start, and the browser pulling the
 * view back after content shrank leaves it at the new end.
 */
export function readerScrollThroughFrame(
  previous: ScrollGeometry | null,
  current: ScrollGeometry,
  wasAtEnd = false,
): boolean {
  if (previous === null || current.top >= previous.top) {
    return false;
  }
  const sameSizes =
    current.scrollHeight === previous.scrollHeight &&
    current.clientHeight === previous.clientHeight;
  if (sameSizes) {
    return true;
  }
  return wasAtEnd && !atEnd(current);
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
    // Whether the previous scroll event left the view at the end (only
    // scroll events set it: a size change alone does not move the view).
    let wasAtEnd = atEnd(previous);
    const scrolled = () => {
      const current = geometryOf(transcript);
      if (readerScrollThroughFrame(previous, current, wasAtEnd)) {
        transcript.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      }
      previous = current;
      wasAtEnd = atEnd(current);
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
