/**
 * The screenshot viewer's state: which screenshot is open, and its image
 * once fetched. Drawn by ScreenshotViewer.tsx over the page.
 *
 * Inputs: `open` (the chat page's View screenshot, through the bridge),
 * `retry` and `close` (the reader). Output: `state`, with `subscribe` for
 * changes.
 *
 * The image is fetched from the gateway's authenticated route with the
 * device token in a header (fetchScreenshot, shared with the phone panel)
 * and shown from a `blob:` URL that this object owns: it is revoked as soon
 * as the image element has loaded it (`imageLoaded`), so the address cannot
 * be opened in another tab or kept beyond the viewer; until then, closing
 * the viewer or showing another screenshot revokes it, and an answer to a
 * request that was replaced makes none. Nothing is written to storage or
 * history; the token never appears in an address.
 *
 * One screenshot at a time: opening another (or the same one again) aborts
 * the request on its way and forgets the image shown.
 */

import { ScreenshotRefused } from '../../../mobile/src/screenshots.ts';

/** What one View screenshot asks to show. */
export interface ScreenshotRequest {
  /** The gateway route, `api/screenshots/<conversation>`. */
  path: string;
  /** The conversation's title, for the viewer's heading. */
  title: string;
  /**
   * Called as each fetch of this screenshot starts. It returns the function
   * the viewer calls if that fetch is answered with HTTP 404, which returns
   * whether the 404 is final (the screenshot is gone). It is not when the
   * answer may only mean that the gateway has not granted this connection
   * the screenshot yet (asked before the connection's snapshot arrived, or
   * for a row the current connection did not relay, for example after a
   * gateway restart); the viewer then offers Try again.
   */
  attempt(): () => boolean;
}

export type ViewerState =
  | { kind: 'closed' }
  | { kind: 'loading'; title: string }
  | { kind: 'shown'; title: string; imageUrl: string }
  | { kind: 'failed'; title: string; message: string; canRetry: boolean };

/** Fetches one screenshot (fetchScreenshot with this page's connection). */
export type ScreenshotFetch = (path: string, signal: AbortSignal) => Promise<Blob>;

/** What the viewer says when the screenshot cannot be shown. */
export const viewerTexts = {
  gone: 'Companion no longer has this screenshot.',
  refused: 'Companion did not allow this browser to load the screenshot.',
  unreachable: 'Could not load the screenshot. Check the connection and try again.',
  undecodable: 'The screenshot could not be shown.',
};

/** Blob URLs, made and revoked through this (tests count them). */
export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

const browserObjectUrls: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

export class ScreenshotViewerState {
  state: ViewerState = { kind: 'closed' };

  private readonly listeners = new Set<() => void>();
  private request: ScreenshotRequest | null = null;
  private controller: AbortController | null = null;
  private imageUrl = '';

  constructor(
    private readonly fetchImage: ScreenshotFetch,
    private readonly objectUrls: ObjectUrls = browserObjectUrls,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Show `request`'s screenshot, replacing whatever is open. */
  open(request: ScreenshotRequest): void {
    this.forget();
    this.request = request;
    this.load();
  }

  /**
   * The image element has decoded the image: its `blob:` address is revoked
   * now. The element keeps showing what it decoded; the address no longer
   * leads anywhere (another tab, a copied link).
   */
  imageLoaded(imageUrl: string): void {
    if (imageUrl === '' || imageUrl !== this.imageUrl) {
      return;
    }
    this.objectUrls.revoke(this.imageUrl);
    this.imageUrl = '';
  }

  /**
   * The image element could not decode what was fetched: its `blob:` address
   * is revoked at once, and the viewer offers Try again.
   */
  imageFailed(imageUrl: string): void {
    if (imageUrl === '' || imageUrl !== this.imageUrl || !this.request) {
      return;
    }
    this.objectUrls.revoke(this.imageUrl);
    this.imageUrl = '';
    this.set({
      kind: 'failed',
      title: this.request.title,
      message: viewerTexts.undecodable,
      canRetry: true,
    });
  }

  /** Fetch the open screenshot again after a failure. */
  retry(): void {
    if (this.state.kind !== 'failed' || !this.state.canRetry || !this.request) {
      return;
    }
    this.load();
  }

  /** Close the viewer: abort the request, revoke the image. */
  close(): void {
    if (this.state.kind === 'closed') {
      return;
    }
    this.forget();
    this.request = null;
    this.set({ kind: 'closed' });
  }

  private load(): void {
    const request = this.request!;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ kind: 'loading', title: request.title });
    // Whether a 404 is final depends on this fetch's own moment.
    const notFoundIsFinal = request.attempt();

    this.fetchImage(request.path, controller.signal).then(
      (blob) => {
        if (this.controller !== controller) {
          // Closed or replaced meanwhile: nothing is made from this answer.
          return;
        }
        this.controller = null;
        this.imageUrl = this.objectUrls.create(blob);
        this.set({ kind: 'shown', title: request.title, imageUrl: this.imageUrl });
      },
      (failure: unknown) => {
        if (this.controller !== controller) {
          return;
        }
        this.controller = null;
        const notFound = failure instanceof ScreenshotRefused && failure.status === 404;
        if (notFound && notFoundIsFinal()) {
          this.set({
            kind: 'failed',
            title: request.title,
            message: viewerTexts.gone,
            canRetry: false,
          });
          return;
        }
        // A 404 that is not final falls through to Try again below.
        if (!notFound && failure instanceof ScreenshotRefused && failure.status < 500) {
          this.set({
            kind: 'failed',
            title: request.title,
            message: viewerTexts.refused,
            canRetry: false,
          });
          return;
        }
        this.set({
          kind: 'failed',
          title: request.title,
          message: viewerTexts.unreachable,
          canRetry: true,
        });
      },
    );
  }

  /** Abort the request on its way and revoke the image shown, if any. */
  private forget(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.imageUrl) {
      this.objectUrls.revoke(this.imageUrl);
      this.imageUrl = '';
    }
  }

  private set(state: ViewerState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
