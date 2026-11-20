import assert from 'node:assert/strict';
import test from 'node:test';

import { ActivityHistory } from '../../src/desktop/activity-history.ts';
import type { HistoryEntry } from '../../src/desktop/history.ts';
import type { ActivityEntry } from '../../src/remote/protocol.ts';

/**
 * The new-activity marker, checked with the rows of the README's "The
 * new-activity marker" table (integrations/shell/README.md), derived from
 * its rules 1–7, against the real phone Store, unchanged, fed the events and
 * history pages the remote role sends, and read through the shell's own
 * tracker (`NewActivity`), observed after every Store change as the
 * workspace does on every render. The browser suite (activity.test.ts)
 * checks the rows a browser can time through the real gateway; this one
 * also covers reconnects, a new listener run, a failed first reading and
 * sign-out.
 *
 * The Store runs in Node with stand-ins for the few browser objects it
 * touches (history, storage, visibility) and for the Connection's request
 * (a synthetic listener's Activity history, read in pages of two). No
 * network is used.
 */

// ---- Browser stand-ins, before the Store is loaded ---------------------------------

const memory = new Map<string, string>();

Object.assign(globalThis, {
  window: {
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:1' },
    history: {
      state: null as unknown,
      replaceState(state: unknown) {
        this.state = state;
      },
      pushState(state: unknown) {
        this.state = state;
      },
    },
  },
  document: {
    addEventListener() {},
    visibilityState: 'visible',
  },
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

const { Store } = await import('../../integrations/mobile/src/store.ts');
const { NewActivity } = await import('../../integrations/shell/src/activity/new-activity.ts');

// ---- A synthetic listener ------------------------------------------------------------

/**
 * The listener's Activity history of one run: the listener's own index
 * (src/desktop/activity-history.ts, with its removal markers and revisions),
 * read in its pages of 50, plus the listening state it reports.
 */
class Listener {
  history = new ActivityHistory();
  paused = false;
  speaking = false;
  processing = 0;
  /** Fail the next `activity-history` request. */
  failNext = false;
  /** Fail requests for pages from this position on (a rate limit), or -1. */
  failFrom = -1;
  private nextId = 1;

  get runId(): string {
    return this.history.sessionId;
  }

  hear(utterance: string): ActivityEntry {
    const entry = {
      id: `utterance-${this.nextId}`,
      observedAt: 0,
      utterance,
      application: null,
      intent: 'IGNORE',
      outcome: 'ignored',
    } as unknown as HistoryEntry;
    this.nextId++;
    return this.history.update(entry, { correct: null, actualIntent: null });
  }

  label(entry: ActivityEntry): ActivityEntry {
    return this.history.update(entry, { correct: true, actualIntent: null });
  }

  remove(entry: ActivityEntry): void {
    this.history.remove(entry.id);
  }

  newRun(): void {
    this.history = new ActivityHistory();
  }

  page(after: number, through: number) {
    return this.history.page(after, through);
  }

  engine() {
    return {
      protocol: 1,
      ready: true,
      paused: this.paused,
      pauseReason: this.paused ? 'manual' : '',
      speaking: this.speaking,
      soundsEnabled: false,
      processing: this.processing,
      preview: false,
      history: [],
      activitySessionId: this.runId,
      activityHistoryCount: this.history.count,
      historyDeletionAvailable: true,
      sessionControlsAvailable: true,
      intents: [],
    };
  }
}

/** The Store's private entry points, as the Connection calls them. */
interface StoreInternals {
  apply(event: unknown): void;
  online(): void;
  connectionChanged(state: unknown): void;
}

/** A page with the Store, the listener and the marker, observed after every change. */
function harness(options: { phone?: boolean } = {}) {
  const listener = new Listener();
  // The shell's Store reads the run again after each reconnect; the phone's
  // is created with its defaults.
  let store = new Store({ rereadActivityAfterReconnect: true });
  if (options.phone) {
    store = new Store();
  }
  const reads: { after: number; through: number }[] = [];
  const internals = store as unknown as StoreInternals;
  const marker = new NewActivity();
  let columnShown = false;

  const connection = store.connection as unknown as {
    request(action: string, parameters: Record<string, number>): Promise<unknown>;
  };
  connection.request = async (action, parameters) => {
    assert.equal(action, 'activity-history');
    reads.push({ after: parameters.after, through: parameters.through });
    if (listener.failNext) {
      listener.failNext = false;
      throw Error('Synthetic reading failure');
    }
    if (listener.failFrom >= 0 && parameters.after >= listener.failFrom) {
      throw Error('Too many requests');
    }
    return listener.page(parameters.after, parameters.through);
  };

  store.subscribe(() => marker.observe(store.state, columnShown));

  /** Let the Store's history reading (awaited requests) finish. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 20; round++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function connection_(status: string): void {
    internals.connectionChanged({ status, message: '', retryAt: 0, deviceName: '' });
  }

  return {
    listener,
    store,
    marker,
    reads,
    settle,
    /** Connected, then the connection's snapshot. */
    async connect(): Promise<void> {
      internals.online();
      connection_('online');
      internals.apply({ type: 'state', ...listener.engine(), sessions: [], previousSessions: [] });
      await settle();
    },
    disconnect(): void {
      connection_('reconnecting');
    },
    signOut(): void {
      connection_('unpaired');
    },
    /** The listener heard something: its event and the new count. */
    async heard(utterance: string): Promise<ActivityEntry> {
      const entry = listener.hear(utterance);
      internals.apply({ type: 'activity-entry', sessionId: listener.runId, entry });
      internals.apply({ type: 'state', ...listener.engine() });
      await settle();
      return entry;
    },
    /** An entry changed (labelled here or elsewhere). */
    async labelled(entry: ActivityEntry): Promise<void> {
      const labelled = listener.label(entry);
      internals.apply({ type: 'activity-entry', sessionId: listener.runId, entry: labelled });
      await settle();
    },
    async deleted(entry: ActivityEntry): Promise<void> {
      listener.remove(entry);
      internals.apply({ type: 'history-deleted', id: entry.id, sessionId: listener.runId });
      await settle();
    },
    /** Listening state changes (pause, speech, processing): partial state only. */
    async engineChanged(): Promise<void> {
      internals.apply({ type: 'state', ...listener.engine() });
      await settle();
    },
    setShown(shown: boolean): void {
      columnShown = shown;
      marker.observe(store.state, columnShown);
    },
  };
}

// ---- The table ----------------------------------------------------------------------

test('new-activity marker: each row of the README table, against the real Store', async () => {
  const page = harness();

  // First reading after loading the page, with entries: not set.
  page.listener.hear('Synthetic utterance 1');
  page.listener.hear('Synthetic utterance 2');
  page.listener.hear('Synthetic utterance 3');
  await page.connect();
  assert.equal(page.store.state.activity.entries.size, 3, 'all pages were read');
  assert.equal(page.marker.count, 0, 'first reading');

  // A new entry arrives while hidden: set (1); two more: 3.
  const first = await page.heard('New while hidden');
  assert.equal(page.marker.count, 1, 'one new entry');
  await page.heard('Second new');
  await page.heard('Third new');
  assert.equal(page.marker.count, 3, 'three new entries');

  // An entry already seen is labelled or changes outcome: not set again.
  await page.labelled(first);
  assert.equal(page.marker.count, 3, 'a change of a seen entry');

  // The column is shown: cleared.
  page.setShown(true);
  assert.equal(page.marker.count, 0, 'shown');

  // A new entry arrives while shown: not set, also after hiding.
  await page.heard('Heard while shown');
  assert.equal(page.marker.count, 0, 'heard while shown');
  page.setShown(false);
  assert.equal(page.marker.count, 0, 'after hiding');

  // The only new entry is deleted: cleared.
  const only = await page.heard('Deleted elsewhere');
  assert.equal(page.marker.count, 1);
  await page.deleted(only);
  assert.equal(page.marker.count, 0, 'the only new entry deleted');

  // Pause, resume, speech and processing: not set.
  page.listener.paused = true;
  await page.engineChanged();
  page.listener.paused = false;
  page.listener.speaking = true;
  page.listener.processing = 1;
  await page.engineChanged();
  assert.equal(page.marker.count, 0, 'listening states');

  // A reconnect without new entries: not set.
  page.disconnect();
  await page.connect();
  assert.equal(page.marker.count, 0, 'reconnect without new entries');

  // Entries heard while offline, learned after reconnecting: set.
  page.disconnect();
  page.listener.hear('Heard while offline');
  page.listener.hear('Also while offline');
  await page.connect();
  assert.equal(page.marker.count, 2, 'heard while offline');

  // Deleted and labelled elsewhere while this page was offline: after
  // reconnecting the page reads the run again, so the deleted entry is gone
  // (and no longer counts as new) and the label is shown; neither is new.
  const offlineEntries = [...page.store.state.activity.entries.values()].filter((entry) =>
    entry.utterance.endsWith('while offline'),
  );
  const labelledElsewhere = [...page.store.state.activity.entries.values()].find(
    (entry) => entry.utterance === 'Synthetic utterance 1',
  )!;
  page.disconnect();
  page.listener.remove(offlineEntries[0]);
  page.listener.label(labelledElsewhere);
  await page.connect();
  assert.equal(
    page.store.state.activity.entries.has(offlineEntries[0].id),
    false,
    'deleted offline',
  );
  assert.equal(page.store.state.activity.entries.get(labelledElsewhere.id)?.correct, true);
  assert.equal(page.marker.count, 1, 'the deleted one no longer counts');

  // A new listener run after catching up, with entries: set (the old run's
  // new entries are gone with it).
  page.disconnect();
  page.listener.newRun();
  page.listener.hear('First of the new run');
  await page.connect();
  assert.equal(page.marker.count, 1, 'new listener run');

  // Sign-out clears it; pairing again starts with a first reading.
  page.signOut();
  assert.equal(page.marker.count, 0, 'sign-out');
  page.listener.hear('Heard before pairing again');
  await page.connect();
  assert.equal(page.marker.count, 0, 'first reading after pairing again');
  await page.heard('New after pairing again');
  assert.equal(page.marker.count, 1, 'new after pairing again');
});

test('new-activity marker: nothing is new until the first reading has caught up', async () => {
  const page = harness();
  page.listener.hear('Before loading');

  // The first reading fails: the entries it and events bring are not new.
  page.listener.failNext = true;
  await page.connect();
  assert.equal(page.store.state.activity.error, 'Synthetic reading failure');
  const entry = page.listener.hear('Arrives while not caught up');
  (page.store as unknown as StoreInternals).apply({
    type: 'activity-entry',
    sessionId: page.listener.runId,
    entry,
  });
  assert.equal(page.marker.count, 0, 'not caught up');

  // A retry catches up; only what comes after that is new.
  page.store.retryActivity();
  await page.settle();
  assert.equal(page.store.state.activity.error, '');
  assert.equal(page.marker.count, 0, 'caught up');
  await page.heard('After catching up');
  assert.equal(page.marker.count, 1, 'new after catching up');
});

test('the phone Store (default options) keeps reading only what is new after a reconnect', async () => {
  const page = harness({ phone: true });
  page.listener.hear('Synthetic utterance 1');
  await page.connect();
  const readsBefore = page.reads.length;
  page.disconnect();
  await page.connect();
  assert.equal(page.reads.length, readsBefore, 'nothing read again');

  // The shell's option reads the run from its start after a reconnect.
  const shell = harness();
  shell.listener.hear('Synthetic utterance 1');
  await shell.connect();
  shell.disconnect();
  await shell.connect();
  assert.deepEqual(shell.reads.at(-1), { after: 0, through: 1 });
});

test('a reading after a reconnect that fails part way continues there on Retry', async () => {
  const page = harness();
  // 120 entries: three pages of 50.
  for (let index = 1; index <= 120; index++) {
    page.listener.hear(`Synthetic utterance ${index}`);
  }
  await page.connect();
  assert.equal(page.store.state.activity.entries.size, 120);

  // Offline, one entry on the third page is deleted elsewhere. After
  // reconnecting, the reading from the start is refused from that page on
  // (as the gateway's rate limit refuses a long reading).
  const late = [...page.store.state.activity.entries.values()].find(
    (entry) => entry.utterance === 'Synthetic utterance 110',
  )!;
  page.disconnect();
  page.listener.remove(late);
  page.listener.failFrom = 100;
  await page.connect();
  assert.equal(page.store.state.activity.error, 'Too many requests');
  assert.equal(page.store.state.activity.entries.has(late.id), true, 'not reached yet');
  assert.equal(page.store.state.activity.read, 100, 'the position reached is kept');

  // The limit has passed: Retry continues at that page, not from the start,
  // and reaches the deletion.
  page.listener.failFrom = -1;
  const readsBefore = page.reads.length;
  page.store.retryActivity();
  await page.settle();
  assert.deepEqual(page.reads.slice(readsBefore), [{ after: 100, through: 120 }]);
  assert.equal(page.store.state.activity.entries.has(late.id), false, 'deleted after Retry');
  assert.equal(page.store.state.activity.error, '');
});
