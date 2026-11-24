/**
 * Which of a conversation's two surfaces the switch layout shows, the chat
 * or its session application, and when a new or replaced application comes
 * forward (integrations/shell/README.md, "Session applications", the
 * application-change rule). Pure, without DOM access; one object per
 * pairing (the workspace's), told about every version of the shown
 * conversation.
 *
 * A port of the desktop's rule (`../../../session-apps/SessionSurface.qml`,
 * `observeApplication`, and `../../../session-apps/README.md`, "Application
 * changes"), with the same three maps, per conversation:
 * - `modes`: "chat" or "app", set only by the reader's choice or by
 *   `observe`, never implied by a new descriptor;
 * - `seen`: the application ID and code version last seen shown here
 *   (`<id>:<version>`, '' for none), so a new application or replaced code
 *   comes forward once;
 * - `notices`: the "is ready" notice of an application that arrived while
 *   bringing it forward would have interrupted input.
 *
 * The rule, as on the desktop:
 * 1. No application (any more): the chat; a ready notice no longer applies.
 * 2. First sight of the conversation in this page (it is shown for the
 *    first time, with an application): the application, unless the reader
 *    chose the chat for it here before.
 * 3. A first application, or new code, while the conversation was seen
 *    here before: it comes forward, unless something blocks (a send or a
 *    choice awaiting its answer, or the reader typing in the composer).
 *    Then what is shown stays (the chat, for a first application) and the
 *    bar says the application is ready until the reader opens it.
 * 4. The reader's choice (Chat or the application) is kept and clears the
 *    notice.
 *
 * The caller passes no blocker while the chat is at the right of the
 * application (the wide layout): there the composer never moves, so the
 * application always comes forward there.
 */

export type SurfaceMode = 'chat' | 'app';

export class ApplicationModes {
  private readonly modes = new Map<string, SurfaceMode>();
  private readonly seen = new Map<string, string>();
  private readonly notices = new Map<string, string>();

  /**
   * The shown conversation `sessionId` has the application `key`
   * (shown-application.ts `applicationKey`, '' for none) named `name`.
   * `blocker` is why switching would interrupt input now, or ''. Applies
   * the rule above; idempotent for the same key.
   */
  observe(sessionId: string, key: string, name: string, blocker: string): void {
    if (sessionId === '') {
      return;
    }
    const previous = this.seen.get(sessionId);
    if (previous === key) {
      return;
    }
    this.seen.set(sessionId, key);

    // 1. No application (any more).
    if (key === '') {
      if (this.notices.has(sessionId)) {
        this.choose(sessionId, 'chat');
      }
      return;
    }

    // 2. First sight in this page: nothing is replaced under the reader's
    // hands, this page did not show the conversation before.
    if (previous === undefined) {
      if (!this.modes.has(sessionId)) {
        this.modes.set(sessionId, 'app');
      }
      return;
    }

    // 3. A first application, or new code, while it was seen here before.
    if (blocker === '') {
      this.choose(sessionId, 'app');
      return;
    }
    let shown: SurfaceMode = 'chat';
    if (previous !== '' && this.modes.get(sessionId) === 'app') {
      shown = 'app';
    }
    this.modes.set(sessionId, shown);
    this.notices.set(sessionId, `“${name}” is ready. It opens when you choose it; ${blocker}.`);
  }

  /** The reader chose the chat or the application (rule 4). */
  choose(sessionId: string, mode: SurfaceMode): void {
    if (sessionId === '') {
      return;
    }
    this.modes.set(sessionId, mode);
    this.notices.delete(sessionId);
  }

  /** What the switch layout shows for the conversation (the chat without an application). */
  mode(sessionId: string, hasApplication: boolean): SurfaceMode {
    if (!hasApplication) {
      return 'chat';
    }
    if (this.modes.get(sessionId) === 'app') {
      return 'app';
    }
    return 'chat';
  }

  /** The "is ready" notice of the conversation, or ''. */
  notice(sessionId: string): string {
    return this.notices.get(sessionId) ?? '';
  }
}

/**
 * Why bringing an application forward would interrupt input now, in the
 * desktop's words (`SessionSurface.qml` `switchBlocker`), or ''. The
 * browser has no recording into the text box, so that blocker never
 * applies here.
 */
export function switchBlocker(input: {
  pendingSend: boolean;
  pendingChoice: boolean;
  composerFocused: boolean;
}): string {
  if (input.pendingSend) {
    return 'a message is still being sent';
  }
  if (input.pendingChoice) {
    return 'a choice is still being confirmed';
  }
  if (input.composerFocused) {
    return 'you are typing';
  }
  return '';
}
