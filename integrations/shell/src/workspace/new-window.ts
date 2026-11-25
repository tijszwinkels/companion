/**
 * A conversation in a new browser window (the shell README, "A conversation
 * in a new window").
 *
 * The bar's ⧉ button opens this page's own address in a new window with
 * `#conversation=<id>`. A page that starts with such a fragment shows that
 * conversation once this connection's first snapshot has arrived, and from
 * then on is an ordinary tab of the shell: its selection is its own (every
 * tab has its own), so it stays on that conversation while another window
 * switches. The fragment is read once, when the page loads: it is not a
 * route, and nothing writes it back. It stays in the address, so a reload
 * of that window shows the same conversation again.
 *
 * Outcomes when the snapshot arrives:
 * - the conversation is open: it is selected, in place of the empty view
 *   (no extra Back step);
 * - it was closed meanwhile (it is among Previous sessions): Previous
 *   sessions is shown, with a toast saying so;
 * - it is unknown (an old address, another listener run): the empty view,
 *   with a toast.
 *
 * The new window uses the same pairing (this browser's storage) and counts
 * as one more of this browser's connections (at most four per device; the
 * fifth shows the limit page, ../../README.md "The limit page"). Nothing
 * here needs a permission or a request of its own.
 */

import type { Store } from '../../../mobile/src/store.ts';
import { narrowWindowBelow } from '../layout/activity-width.ts';

/**
 * The new window's width in CSS pixels: wider than a narrow window
 * (../layout/activity-width.ts), so an Activity column this browser
 * remembers as shown sits beside the chat instead of over it, and the chat
 * keeps about 360 px beside it and the strip.
 */
const newWindowWidth = narrowWindowBelow + 120;
const newWindowHeight = 860;

/** The fragment's name: `#conversation=<id>`. */
const fragmentName = 'conversation';

/** The parts of `Location` the address is made of. */
export interface PageAddress {
  origin: string;
  pathname: string;
  search: string;
}

/** This page's address, showing conversation `id` when opened. */
export function conversationAddress(page: PageAddress, id: string): string {
  return `${page.origin}${page.pathname}${page.search}#${fragmentName}=${encodeURIComponent(id)}`;
}

/** The conversation a fragment (`location.hash`) names, or '' for none. */
export function conversationOfFragment(hash: string): string {
  const prefix = `#${fragmentName}=`;
  if (!hash.startsWith(prefix)) {
    return '';
  }
  try {
    return decodeURIComponent(hash.slice(prefix.length));
  } catch {
    // Not valid percent-encoding: names nothing.
    return '';
  }
}

export type AddressedOutcome = 'shown' | 'closed' | 'unknown';

/** What a page that starts on conversation `id` shows, for the first snapshot's state. */
export function addressedOutcome(
  id: string,
  state: { sessions: ReadonlyMap<string, unknown>; previous: readonly { id: string }[] },
): AddressedOutcome {
  if (state.sessions.has(id)) {
    return 'shown';
  }
  if (state.previous.some((session) => session.id === id)) {
    return 'closed';
  }
  return 'unknown';
}

/**
 * Show the conversation `hash` names once the first snapshot has arrived
 * (the Store knows the open conversations only then). Called once, when the
 * page starts; does nothing without such a fragment.
 */
export function showAddressedConversation(store: Store, hash: string): void {
  const id = conversationOfFragment(hash);
  if (id === '') {
    return;
  }

  const unsubscribe = store.subscribe(() => {
    // The listener's engine state arrives with the first snapshot.
    if (!store.state.engine) {
      return;
    }
    unsubscribe();
    // After the Store has told every listener of this change, not inside
    // its notification: selecting changes its state again.
    queueMicrotask(() => {
      const outcome = addressedOutcome(id, store.state);
      if (outcome === 'shown') {
        // Replaces the empty view's history entry: Back does not lead to it.
        store.navigation.navigate({ selected: id, showingPrevious: false }, true);
        return;
      }
      if (outcome === 'closed') {
        store.showPrevious();
        store.toast('That conversation was closed meanwhile. It is in Previous sessions.');
        return;
      }
      store.toast('That conversation is not open in Companion.');
    });
  });
}

/**
 * Open conversation `id` in a new browser window of this page's address.
 * `noopener`: the new window gets no handle on this one (and this one none
 * on it); it is a page of its own that pairs from this browser's storage.
 */
export function openConversationWindow(id: string): void {
  const address = conversationAddress(window.location, id);
  window.open(
    address,
    '_blank',
    `noopener,popup,width=${newWindowWidth},height=${newWindowHeight}`,
  );
}
