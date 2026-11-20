import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installBrowser,
  pairDevice,
  settle,
  StandInListener,
  storage,
  type Link,
} from './drafts-listener-stand-in.ts';

/**
 * The listener-draft rules of integrations/shell/README.md ("Listener
 * drafts"), one table per rule group, each row played against the real
 * phone Store and Connection (with the Store's `listenerDrafts` option, as
 * the shell's main.tsx sets it). A stand-in socket and listener answer as
 * the gateway and listener do (drafts-listener-stand-in.ts), so every
 * ordering a row needs (an answer held back, refused or lost, a reconnect,
 * a gateway without drafts) is played exactly. drafts.test.ts plays the rows
 * a browser can time against the real gateway and listener.
 */

installBrowser();
const { Store } = await import('../../integrations/mobile/src/store.ts');
const { listEntries } = await import('../../integrations/shell/src/list/entries.ts');
const { keptLocallyReason, notConnectedReason, reconnectedReason } =
  await import('../../integrations/mobile/src/listener-drafts.ts');

type PageStore = InstanceType<typeof Store>;

/** One page (a tab) of the shell: its Store and its current connection. */
class Tab {
  link!: Link;

  constructor(
    readonly store: PageStore,
    private readonly listener: StandInListener,
  ) {}

  /** The person types: the text box's whole text becomes `text`. */
  type(id: string, text: string): void {
    this.store.setDraft(id, text);
  }

  shown(id: string): string {
    return this.store.draft(id);
  }

  unsaved(id: string): string {
    return this.store.draftUnsaved(id);
  }

  /** The texts of every `draft-set` this page sent, over all its connections. */
  edits(): string[] {
    const texts: string[] = [];
    for (const link of this.listener.links) {
      if (this.links.includes(link)) {
        for (const frame of link.draftSets()) {
          texts.push(frame.text);
        }
      }
    }
    return texts;
  }

  readonly links: Link[] = [];

  /** The connection is lost (the stand-in listener drops its held requests). */
  drop(): void {
    this.listener.dropHeld();
    this.listener.holding = false;
    this.link.socket.drop();
  }

  /** Connect again at once (as the phone Connection does when the network returns). */
  async reconnect(listener: StandInListener = this.listener): Promise<void> {
    listener.use();
    this.store.connection.connectNow();
    await settle();
    this.link = listener.latest();
    this.links.push(this.link);
  }

  close(): void {
    this.store.connection.forget();
  }
}

/** A freshly loaded, paired page against `listener`, connected and settled. */
async function openTab(
  listener: StandInListener,
  context: { after(callback: () => void): void },
): Promise<Tab> {
  listener.use();
  const store = new Store({ activity: false, listenerDrafts: true });
  const tab = new Tab(store, listener);
  store.start();
  await settle();
  tab.link = listener.latest();
  tab.links.push(tab.link);
  context.after(() => tab.close());
  return tab;
}

/** A listener with conversations `a` and `b`, and a paired browser. */
function freshListener(): StandInListener {
  pairDevice();
  return new StandInListener(['a', 'b']);
}

/** Every value the box of `id` showed, in order, from now on. */
function watchShown(tab: Tab, id: string): string[] {
  const seen: string[] = [];
  tab.store.subscribe(() => {
    const text = tab.shown(id);
    if (seen[seen.length - 1] !== text) {
      seen.push(text);
    }
  });
  return seen;
}

/** The conversation list's draft markers, read as ConversationList.tsx reads them. */
function listDrafts(tab: Tab): Record<string, string> {
  const store = tab.store;
  const result: Record<string, string> = {};
  for (const entry of listEntries(store.state, (id) =>
    store.draftsShared ? store.draft(id) : '',
  )) {
    result[entry.id] = entry.draft;
  }
  return result;
}

const localDraftsKey = 'companion.remote.drafts';

function localDrafts(): Record<string, string> {
  return JSON.parse(storage.get(localDraftsKey) ?? '{}');
}

// ---- Draft text shown --------------------------------------------------------------

test('draft text shown: each row of the README table', async (context) => {
  const rows: { row: string; play: () => Promise<void> }[] = [
    {
      row: "The listener's draft at the snapshot",
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Half a question');
        const tab = await openTab(listener, context);
        assert.equal(tab.shown('a'), 'Half a question');
        assert.equal(tab.unsaved('a'), '');
        assert.deepEqual(tab.edits(), [], 'reading writes nothing');
      },
    },
    {
      row: 'An edit from elsewhere while this page is idle',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.desktopEdit('a', 'From the desktop');
        await settle();
        assert.equal(tab.shown('a'), 'From the desktop');
        assert.deepEqual(tab.edits(), []);
      },
    },
    {
      row: 'An edit from elsewhere while this page types',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.holding = true;
        tab.type('a', 'mine');
        await settle();
        // The desktop's change reaches the listener before this page's edit.
        listener.desktopEdit('a', 'theirs');
        await settle();
        assert.equal(tab.shown('a'), 'mine', 'own edit on its way: the change waits');
        listener.release();
        await settle();
        assert.equal(listener.text('a'), 'mine', 'sent after it, this edit won');
        assert.equal(tab.shown('a'), 'mine', "afterwards the listener's latest");
        listener.desktopEdit('a', 'theirs again');
        await settle();
        assert.equal(tab.shown('a'), 'theirs again', 'idle again: shown at once');
      },
    },
    {
      row: "This page's own echo, newer text typed since",
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        const seen = watchShown(tab, 'a');
        listener.holding = true;
        tab.type('a', 'a1');
        tab.type('a', 'a12');
        await settle();
        // Only a1 reaches the listener: its echo and answer come back while
        // a12 is still on its way.
        listener.releaseNext();
        await settle();
        assert.equal(listener.text('a'), 'a1');
        assert.equal(tab.shown('a'), 'a12', 'the echo of a1 is not applied');
        listener.release();
        await settle();
        assert.deepEqual(seen, ['a1', 'a12'], 'the echo of a1 was never shown again');
        assert.deepEqual(tab.edits(), ['a1', 'a12']);
        assert.equal(listener.text('a'), 'a12');
      },
    },
    {
      row: 'A send from here',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        tab.type('a', 'A question');
        await settle();
        await tab.store.sendDraft('a');
        await settle();
        assert.equal(tab.shown('a'), '');
        assert.equal(listener.text('a'), '', 'the listener cleared it');
        assert.deepEqual(tab.edits(), ['A question'], 'no empty draft written for the send');
        // pendingSend was reported before send-agent left and withdrawn after.
        const order = tab.link.requests
          .filter((frame) => frame.action === 'panel-state' || frame.action === 'send-agent')
          .map((frame) =>
            frame.action === 'send-agent' ? 'send' : `report:${frame.pendingSend ?? '-'}`,
          );
        assert.deepEqual(order.slice(-3), ['report:a', 'send', 'report:']);
      },
    },
    {
      row: 'A send from here while its text is still being written',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        // Typed faster than the answers: "hell" on its way, "hello" waiting.
        listener.holdActions.add('draft-set');
        tab.type('a', 'hell');
        tab.type('a', 'hello');
        const sending = tab.store.sendDraft('a');
        await settle();
        assert.equal(
          tab.link.requests.some((frame) => frame.action === 'send-agent'),
          false,
          'the send waits for the edit carrying its text',
        );
        listener.release();
        await sending;
        await settle();
        const order = tab.link.requests
          .filter((frame) => frame.action === 'draft-set' || frame.action === 'send-agent')
          .map((frame) => `${frame.action}:${frame.text}`);
        assert.deepEqual(order, ['draft-set:hell', 'draft-set:hello', 'send-agent:hello']);
        assert.equal(listener.text('a'), '', 'the listener cleared the equal draft');
        assert.equal(tab.shown('a'), '');

        // Text typed after pressing Send does not hold the send back, and stays.
        listener.holdActions.add('draft-set');
        tab.type('a', 'next');
        const second = tab.store.sendDraft('a');
        tab.type('a', 'next one');
        await settle();
        listener.releaseNext();
        await settle();
        listener.release();
        await second;
        await settle();
        const sends = tab.link.requests.filter((frame) => frame.action === 'send-agent');
        assert.equal(sends[sends.length - 1].text, 'next');
        assert.equal(listener.text('a'), 'next one', 'newer text is not cleared');
        assert.equal(tab.shown('a'), 'next one');
      },
    },
    {
      row: 'A send, then new text typed before the sent text is written',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.holdActions.add('draft-set');
        tab.type('a', 'h');
        tab.type('a', 'hello');
        const sending = tab.store.sendDraft('a');
        // The person starts the next message before "h" is answered.
        tab.type('a', 'next');
        await settle();
        listener.release();
        await sending;
        await settle();
        const order = tab.link.requests
          .filter((frame) => frame.action === 'draft-set' || frame.action === 'send-agent')
          .map((frame) => `${frame.action}:${frame.text}`);
        assert.deepEqual(order, [
          'draft-set:h',
          'draft-set:hello',
          'draft-set:next',
          'send-agent:hello',
        ]);
        assert.equal(listener.text('a'), 'next', 'the newer text stays');
        assert.equal(tab.shown('a'), 'next');
      },
    },
    {
      row: 'A send from elsewhere of the same text',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Same text');
        const tab = await openTab(listener, context);
        assert.equal(tab.shown('a'), 'Same text');
        // The desktop sent it: the listener cleared the equal draft.
        listener.apply('a', '', '');
        await settle();
        assert.equal(tab.shown('a'), '');
      },
    },
    {
      row: 'The conversation closed and reopened',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Kept while closed');
        const tab = await openTab(listener, context);
        const removed = listener.sessions.find((entry) => entry.id === 'a')!;
        tab.link.socket.deliver({ type: 'engine', message: { type: 'agent-removed', id: 'a' } });
        await settle();
        assert.equal(tab.store.state.sessions.has('a'), false);
        tab.link.socket.deliver({
          type: 'engine',
          message: { type: 'agent-restored', session: removed },
        });
        await settle();
        assert.equal(tab.shown('a'), 'Kept while closed');
        assert.deepEqual(tab.edits(), []);
      },
    },
    {
      row: 'Switching to another conversation and back, an edit just before it',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('b', 'B draft');
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.holding = true;
        tab.type('a', 'typed in a');
        tab.store.open('b');
        assert.equal(tab.shown('b'), 'B draft');
        listener.release();
        await settle();
        tab.store.open('a');
        assert.equal(tab.shown('a'), 'typed in a');
        assert.equal(listener.text('a'), 'typed in a');
        assert.equal(listener.text('b'), 'B draft');
      },
    },
  ];

  for (const { row, play } of rows) {
    await context.test(row, play);
  }
});

// ---- Writing -----------------------------------------------------------------------

test('writing: each row of the README table', async (context) => {
  const rows: { row: string; play: () => Promise<void> }[] = [
    {
      row: 'One edit',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.type('a', 'Hello');
        await settle();
        assert.deepEqual(tab.edits(), ['Hello']);
        assert.equal(listener.text('a'), 'Hello');
        assert.equal(tab.unsaved('a'), '');
      },
    },
    {
      row: 'Fast typing (edits while one is in flight)',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        const final = 'The quick brown fox';
        // Every keystroke in one turn: only the first leaves at once.
        for (let length = 1; length <= final.length; length++) {
          tab.type('a', final.slice(0, length));
        }
        await settle();
        assert.deepEqual(tab.edits(), ['T', final], 'the newest waiting text replaced the rest');
        assert.equal(listener.text('a'), final);

        // Held answers: one in flight, the newest waiting text next.
        listener.holding = true;
        tab.type('a', `${final} j`);
        tab.type('a', `${final} ju`);
        await settle();
        tab.type('a', `${final} jum`);
        tab.type('a', `${final} jump`);
        await settle();
        assert.equal(tab.edits().length, 3, 'one edit in flight');
        listener.release();
        await settle();
        assert.deepEqual(tab.edits().slice(2), [`${final} j`, `${final} jump`]);
        assert.equal(listener.text('a'), `${final} jump`);
        assert.equal(tab.shown('a'), `${final} jump`);
      },
    },
    {
      row: 'Refused ("not saved")',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.refuseEdits = 'Too many draft edits; this edit was not saved';
        tab.type('a', 'Refused text');
        await settle();
        assert.equal(tab.shown('a'), 'Refused text');
        assert.equal(
          tab.unsaved('a'),
          'Your text is not saved: Too many draft edits; this edit was not saved',
        );
        await settle();
        assert.deepEqual(tab.edits(), ['Refused text'], 'never written again by itself');
        assert.equal(listener.text('a'), '');
      },
    },
    {
      row: 'No answer and a reconnect',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.holding = true;
        tab.type('a', 'Unanswered');
        tab.type('a', 'Unanswered, more');
        await settle();
        tab.drop();
        await settle();
        assert.equal(tab.shown('a'), 'Unanswered, more');
        assert.equal(tab.unsaved('a'), reconnectedReason);
        await tab.reconnect();
        assert.equal(tab.shown('a'), 'Unanswered, more', 'kept: the listener does not have it');
        assert.equal(tab.unsaved('a'), reconnectedReason);
        assert.deepEqual(tab.edits(), ['Unanswered'], 'nothing sent again by itself');

        // The listener had applied it before the connection dropped.
        listener.holding = true;
        tab.type('b', 'Applied');
        await settle();
        listener.apply('b', 'Applied', '');
        tab.drop();
        await settle();
        assert.equal(tab.unsaved('b'), reconnectedReason);
        await tab.reconnect();
        assert.equal(tab.unsaved('b'), '', 'the snapshot holds exactly that text');
        assert.equal(tab.shown('b'), 'Applied');
      },
    },
    {
      row: 'Offline typing, then reconnect',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.drop();
        await settle();
        tab.type('a', 'Typed offline');
        tab.type('b', 'Also offline');
        assert.equal(tab.unsaved('a'), notConnectedReason);
        listener.apply('b', 'Also offline', '');
        await tab.reconnect();
        assert.equal(tab.shown('a'), 'Typed offline');
        assert.equal(tab.unsaved('a'), notConnectedReason, 'still not saved');
        assert.equal(tab.unsaved('b'), '', 'the listener has exactly that text');
        assert.deepEqual(tab.edits(), [], 'nothing written by itself');
      },
    },
    {
      row: 'An edit lost in a reconnect, then a send',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.holding = true;
        tab.type('a', 'lost');
        await settle();
        tab.drop();
        await tab.reconnect();
        tab.type('a', 'send me');
        listener.holdActions.add('draft-set');
        await settle();
        const sending = tab.store.sendDraft('a');
        tab.type('a', 'send me, and the next message');
        await settle();
        // Only "send me" is answered: the send leaves, it does not wait for
        // the text typed after it.
        listener.releaseNext();
        await settle();
        const sends = tab.link.requests.filter((frame) => frame.action === 'send-agent');
        assert.deepEqual(
          sends.map((frame) => frame.text),
          ['send me'],
        );
        listener.release();
        await sending;
        await settle();
        assert.equal(tab.shown('a'), 'send me, and the next message');
      },
    },
    {
      row: 'Offline Clear, then reconnect',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Old text');
        const tab = await openTab(listener, context);
        tab.drop();
        await settle();
        tab.type('a', '');
        assert.equal(tab.unsaved('a'), notConnectedReason);
        await tab.reconnect();
        assert.equal(tab.shown('a'), '', 'the Clear is kept');
        assert.equal(tab.unsaved('a'), notConnectedReason);
        assert.deepEqual(tab.edits(), []);
        assert.equal(tab.store.discardUnsavedDraft('a'), true);
        assert.equal(tab.shown('a'), 'Old text');
      },
    },
    {
      row: 'Typing after a refusal',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.refuseEdits = 'refused';
        tab.type('a', 'First');
        await settle();
        assert.notEqual(tab.unsaved('a'), '');
        listener.refuseEdits = '';
        listener.holdActions.add('draft-set');
        tab.type('a', 'First, then more');
        // While the new edit is written, Save and Discard of the old state are gone.
        assert.equal(tab.unsaved('a'), '');
        assert.equal(tab.store.discardUnsavedDraft('a'), false);
        assert.equal(tab.store.saveUnsavedDraft('a'), false);
        listener.release();
        await settle();
        assert.equal(listener.text('a'), 'First, then more');
        assert.equal(tab.shown('a'), 'First, then more');
        assert.deepEqual(tab.edits(), ['First', 'First, then more']);
        // Refused again: marked again by its own reason.
        listener.refuseEdits = 'refused again';
        tab.type('a', 'Third');
        await settle();
        assert.equal(tab.unsaved('a'), 'Your text is not saved: refused again');
      },
    },
    {
      row: 'Save',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.refuseEdits = 'refused';
        tab.type('a', 'Save me');
        await settle();
        listener.refuseEdits = '';
        assert.equal(tab.store.saveUnsavedDraft('a'), true);
        await settle();
        assert.deepEqual(tab.edits(), ['Save me', 'Save me']);
        assert.equal(listener.text('a'), 'Save me');
        assert.equal(tab.unsaved('a'), '');
        assert.equal(tab.store.saveUnsavedDraft('a'), false, 'nothing unsaved any more');
      },
    },
    {
      row: 'Discard',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        listener.refuseEdits = 'refused';
        tab.type('a', 'Discard me');
        await settle();
        listener.desktopEdit('a', "The listener's text");
        await settle();
        assert.equal(tab.shown('a'), 'Discard me', 'unsaved text stays shown');
        assert.equal(tab.store.discardUnsavedDraft('a'), true);
        assert.equal(tab.shown('a'), "The listener's text");
        assert.equal(tab.unsaved('a'), '');
        await settle();
        assert.deepEqual(tab.edits(), ['Discard me'], 'nothing written');
      },
    },
    {
      row: 'Two tabs typing in the same conversation',
      async play() {
        const listener = freshListener();
        const first = await openTab(listener, context);
        const second = await openTab(listener, context);
        first.type('a', 'from the first tab');
        second.type('a', 'from the second tab');
        await settle();
        assert.equal(listener.text('a'), 'from the second tab', 'the last edit received wins');
        assert.equal(first.shown('a'), 'from the second tab');
        assert.equal(second.shown('a'), 'from the second tab');
        assert.equal(first.unsaved('a'), '');
        assert.equal(second.unsaved('a'), '');
      },
    },
  ];

  for (const { row, play } of rows) {
    await context.test(row, play);
  }
});

// ---- Agent drafts ------------------------------------------------------------------

test('agent drafts: each row of the README table', async (context) => {
  const rows: { row: string; play: () => Promise<void> }[] = [
    {
      row: 'A proposal for the shown conversation',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        assert.equal(listener.propose('a', 'Agent text', 'Planner'), 'inserted');
        await settle();
        assert.equal(tab.shown('a'), 'Agent text');
        assert.equal(tab.store.draftSource('a'), 'Planner');
      },
    },
    {
      row: 'A proposal for another conversation',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        assert.equal(listener.propose('b', 'For b', 'Planner'), 'inserted');
        await settle();
        assert.equal(tab.store.state.selected, 'a', 'not switched to');
        assert.deepEqual(listDrafts(tab), { a: '', b: 'For b' });
        tab.store.open('b');
        assert.equal(tab.store.draftSource('b'), 'Planner', 'the note when shown');
        assert.deepEqual(listDrafts(tab), { a: '', b: '' }, 'not listed while shown');
      },
    },
    {
      row: 'A proposal while a send waits (pendingSend)',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        tab.type('a', 'Sending');
        await settle();
        listener.holdActions.add('send-agent');
        const sending = tab.store.sendDraft('a');
        await settle();
        assert.equal(tab.link.pendingSend, 'a');
        assert.equal(listener.propose('a', 'Agent idea', 'Planner'), 'conflict');
        listener.release();
        await sending;
        await settle();
        assert.equal(tab.link.pendingSend, '', 'withdrawn with the answer');
        assert.equal(tab.shown('a'), '');
        assert.equal(listener.propose('a', 'Agent idea', 'Planner'), 'inserted');
      },
    },
    {
      row: "A proposal while another conversation's send ended first",
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        tab.type('a', 'Sending a');
        tab.store.open('b');
        tab.type('b', 'Sending b');
        await settle();
        listener.holdActions.add('send-agent');
        const sendingA = tab.store.sendDraft('a');
        await settle();
        const sendingB = tab.store.sendDraft('b');
        await settle();
        assert.equal(tab.link.pendingSend, 'b', 'the latest send is reported');
        // B's answer arrives first: A still waits and is reported instead.
        listener.releaseMatching((frame) => frame.action === 'send-agent' && frame.id === 'b');
        await sendingB;
        await settle();
        assert.equal(tab.link.pendingSend, 'a');
        assert.equal(listener.propose('a', 'Agent idea', 'Planner'), 'conflict');
        listener.release();
        await sendingA;
        await settle();
        assert.equal(tab.link.pendingSend, '');
      },
    },
    {
      row: 'A proposal while a send started before the draft snapshot waits',
      async play() {
        const listener = freshListener();
        // The connection's first report (and so its draft snapshot) waits.
        listener.holdActions.add('panel-state');
        listener.holdActions.add('send-agent');
        const tab = await openTab(listener, context);
        tab.type('a', 'Early');
        const sending = tab.store.sendDraft('a');
        await settle();
        assert.equal(tab.store.draftsShared, false, 'the mode is not known yet');
        // The report is answered: the snapshot makes this connection a draft
        // host, and the waiting send is reported at once.
        listener.holdActions.delete('panel-state');
        listener.releaseNext();
        await settle();
        assert.equal(tab.link.pendingSend, 'a');
        assert.equal(listener.propose('a', 'Agent idea', 'Planner'), 'conflict');
        listener.release();
        await sending;
        await settle();
        assert.equal(tab.link.pendingSend, '');
      },
    },
    {
      row: 'Clear',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.propose('a', 'Clear me', 'Planner');
        await settle();
        // The page's Clear link is an edit to empty text.
        tab.type('a', '');
        assert.equal(tab.store.draftSource('a'), '');
        await settle();
        assert.deepEqual(tab.edits(), ['']);
        assert.equal(listener.text('a'), '');
        assert.equal(tab.shown('a'), '');
      },
    },
    {
      row: 'Editing it',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.propose('a', 'Agent text', 'Planner');
        await settle();
        tab.type('a', 'Agent text, edited');
        assert.equal(tab.store.draftSource('a'), '', 'the note goes at once');
        await settle();
        assert.equal(listener.text('a'), 'Agent text, edited');
        assert.equal(listener.drafts.get('a')?.source, '');
        assert.equal(tab.store.draftSource('a'), '');
      },
    },
    {
      row: 'Sending it',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.store.open('a');
        listener.propose('a', 'Send this', 'Planner');
        await settle();
        await tab.store.sendDraft('a');
        await settle();
        const sends = tab.link.requests.filter((frame) => frame.action === 'send-agent');
        assert.deepEqual(
          sends.map((frame) => frame.text),
          ['Send this'],
        );
        assert.equal(listener.text('a'), '');
        assert.equal(tab.shown('a'), '');
        assert.equal(tab.store.draftSource('a'), '');
      },
    },
  ];

  for (const { row, play } of rows) {
    await context.test(row, play);
  }
});

// ---- The list under the settings screen --------------------------------------------

test('list: the selected conversation covered by the settings screen lists its draft', async (context) => {
  const listener = freshListener();
  listener.desktopEdit('a', 'Draft of a');
  const tab = await openTab(listener, context);
  tab.store.open('a');
  const store = tab.store;
  const draftOf = (id: string) => (store.draftsShared ? store.draft(id) : '');
  const shown = listEntries(store.state, draftOf, false).find((entry) => entry.id === 'a')!;
  assert.equal(shown.draft, '', 'not while it is shown');
  const covered = listEntries(store.state, draftOf, true).find((entry) => entry.id === 'a')!;
  assert.equal(covered.draft, 'Draft of a', 'listed while the settings screen covers it');
});

// ---- Migration and fallback --------------------------------------------------------

test('migration and fallback: each row of the README table', async (context) => {
  const rows: { row: string; play: () => Promise<void> }[] = [
    {
      row: 'Local drafts present, first connection with drafts',
      async play() {
        const listener = freshListener();
        storage.set(localDraftsKey, JSON.stringify({ a: 'Kept locally', new: 'A new question' }));
        const tab = await openTab(listener, context);
        assert.equal(tab.shown('a'), 'Kept locally');
        assert.equal(tab.unsaved('a'), keptLocallyReason);
        assert.deepEqual(tab.edits(), [], 'never written by itself');
        // Kept while it is unsaved (a reload offers it again), deleted once saved.
        assert.deepEqual(localDrafts(), { a: 'Kept locally', new: 'A new question' });
        assert.equal(tab.store.saveUnsavedDraft('a'), true);
        await settle();
        assert.equal(listener.text('a'), 'Kept locally');
        assert.deepEqual(localDrafts(), { new: 'A new question' }, 'local copy deleted');
      },
    },
    {
      row: "A local draft equal to the listener's",
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Same');
        storage.set(localDraftsKey, JSON.stringify({ a: 'Same' }));
        const tab = await openTab(listener, context);
        assert.equal(tab.shown('a'), 'Same');
        assert.equal(tab.unsaved('a'), '');
        assert.deepEqual(localDrafts(), {});
      },
    },
    {
      row: 'No local drafts',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('b', 'From the desktop');
        const tab = await openTab(listener, context);
        assert.equal(tab.shown('b'), 'From the desktop');
        assert.equal(tab.unsaved('a'), '');
        assert.equal(tab.unsaved('b'), '');
      },
    },
    {
      row: 'A later connection or page load',
      async play() {
        const listener = freshListener();
        storage.set(localDraftsKey, JSON.stringify({ a: 'Kept locally' }));
        const first = await openTab(listener, context);
        assert.equal(first.unsaved('a'), keptLocallyReason);
        first.store.discardUnsavedDraft('a');
        first.drop();
        await first.reconnect();
        assert.equal(first.shown('a'), '');
        assert.equal(first.unsaved('a'), '', 'not offered again after a reconnect');
        const reloaded = await openTab(listener, context);
        assert.equal(reloaded.shown('a'), '');
        assert.equal(reloaded.unsaved('a'), '', 'not offered again after a page load');
      },
    },
    {
      row: 'A page reloaded while its text is unsaved',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.drop();
        await settle();
        tab.type('a', 'Typed offline, then reloaded');
        listener.holding = true;
        await tab.reconnect();
        tab.type('b', 'Still on its way');
        await settle();
        assert.deepEqual(localDrafts(), {
          a: 'Typed offline, then reloaded',
          b: 'Still on its way',
        });
        // The page is reloaded (a new Store) while b's edit is unanswered.
        listener.dropHeld();
        listener.holding = false;
        tab.link.socket.drop();
        const reloaded = await openTab(listener, context);
        assert.equal(reloaded.shown('a'), 'Typed offline, then reloaded');
        assert.equal(reloaded.unsaved('a'), keptLocallyReason);
        assert.equal(reloaded.shown('b'), 'Still on its way');
        assert.equal(reloaded.unsaved('b'), keptLocallyReason);
        assert.deepEqual(reloaded.edits(), [], 'never written by itself');
        assert.equal(reloaded.store.discardUnsavedDraft('a'), true);
        assert.deepEqual(localDrafts(), { b: 'Still on its way' }, 'kept while unsaved');
      },
    },
    {
      row: 'A page reloaded after its conversation was closed elsewhere',
      async play() {
        const listener = freshListener();
        const tab = await openTab(listener, context);
        tab.drop();
        await settle();
        tab.type('a', 'Typed offline in a');
        // Closed on another device meanwhile.
        const closed = listener.sessions.find((entry) => entry.id === 'a')!;
        listener.sessions = listener.sessions.filter((entry) => entry.id !== 'a');
        await tab.reconnect();
        assert.equal(tab.store.state.sessions.has('a'), false);
        assert.deepEqual(localDrafts(), { a: 'Typed offline in a' });

        // Reloaded: kept, not pruned before the mode is known.
        tab.link.socket.drop();
        const reloaded = await openTab(listener, context);
        assert.deepEqual(localDrafts(), { a: 'Typed offline in a' });
        assert.equal(reloaded.unsaved('a'), keptLocallyReason);
        // Reopened: shown, unsaved.
        listener.sessions = [...listener.sessions, closed];
        reloaded.link.socket.deliver({
          type: 'engine',
          message: { type: 'agent-restored', session: closed },
        });
        await settle();
        reloaded.store.open('a');
        assert.equal(reloaded.shown('a'), 'Typed offline in a');
        assert.equal(reloaded.unsaved('a'), keptLocallyReason);
        assert.deepEqual(reloaded.edits(), []);
      },
    },
    {
      row: 'No drafts, offline text of a conversation closed elsewhere, then a reconnect with drafts',
      async play() {
        const older = freshListener();
        older.supportsDrafts = false;
        const tab = await openTab(older, context);
        tab.drop();
        await settle();
        tab.type('a', 'Typed offline in a');
        assert.deepEqual(localDrafts(), { a: 'Typed offline in a' });
        // Closed elsewhere; the gateway comes back with drafts.
        const listener = new StandInListener(['b']);
        await tab.reconnect(listener);
        assert.equal(tab.store.draftsShared, true);
        assert.equal(tab.unsaved('a'), keptLocallyReason, 'offered, not pruned');
        assert.deepEqual(localDrafts(), { a: 'Typed offline in a' });
      },
    },
    {
      row: 'A gateway without drafts',
      async play() {
        const listener = freshListener();
        listener.supportsDrafts = false;
        storage.set(localDraftsKey, JSON.stringify({ a: 'Local draft' }));
        const tab = await openTab(listener, context);
        tab.store.open('b');
        await settle();
        assert.equal(tab.store.draftsShared, false);
        assert.equal(tab.shown('a'), 'Local draft');
        assert.equal(tab.unsaved('a'), '');
        assert.deepEqual(listDrafts(tab), { a: '', b: '' }, 'no draft in the list');
        tab.type('b', 'Typed here');
        assert.deepEqual(localDrafts(), { a: 'Local draft', b: 'Typed here' }, 'saved locally');
        await tab.store.sendDraft('b');
        await settle();
        assert.equal(tab.shown('b'), '', 'a completed send clears it, as before');
        assert.deepEqual(localDrafts(), { a: 'Local draft' });
        assert.deepEqual(tab.edits(), [], 'no draft-set');
        for (const report of tab.link.reports()) {
          assert.equal('pendingSend' in report, false, 'no pendingSend');
        }
        assert.equal(tab.link.askedForDrafts, false);
        assert.equal(
          tab.link.requests.some((frame) => frame.action === 'draft-set'),
          false,
        );
      },
    },
    {
      row: 'Drafts, then a reconnect without them',
      async play() {
        const listener = freshListener();
        listener.desktopEdit('a', 'Shared draft');
        const tab = await openTab(listener, context);
        tab.drop();
        await settle();
        tab.type('b', 'Typed offline');
        assert.equal(tab.unsaved('b'), notConnectedReason);
        // The gateway came back as an older one.
        const older = new StandInListener(['a', 'b']);
        older.supportsDrafts = false;
        await tab.reconnect(older);
        assert.equal(tab.store.draftsShared, false);
        assert.equal(tab.shown('a'), 'Shared draft');
        assert.equal(tab.shown('b'), 'Typed offline');
        assert.equal(tab.unsaved('b'), '', 'local drafts are never "not saved"');
        assert.deepEqual(localDrafts(), { a: 'Shared draft', b: 'Typed offline' });
      },
    },
    {
      row: 'No drafts, then a reconnect with them',
      async play() {
        const older = freshListener();
        older.supportsDrafts = false;
        const tab = await openTab(older, context);
        tab.type('a', 'Typed without drafts');
        const listener = new StandInListener(['a', 'b']);
        listener.desktopEdit('a', 'Elsewhere');
        tab.drop();
        await tab.reconnect(listener);
        assert.equal(tab.store.draftsShared, true);
        assert.equal(tab.shown('a'), 'Typed without drafts');
        assert.equal(tab.unsaved('a'), keptLocallyReason);
        assert.deepEqual(localDrafts(), { a: 'Typed without drafts' }, 'kept while unsaved');
        assert.equal(tab.store.discardUnsavedDraft('a'), true);
        assert.equal(tab.shown('a'), 'Elsewhere');
        assert.deepEqual(localDrafts(), {}, 'local copy deleted');
      },
    },
  ];

  for (const { row, play } of rows) {
    await context.test(row, play);
  }
});
