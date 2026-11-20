import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentSession } from '../../src/agents/types.ts';
import type { Store } from '../../integrations/mobile/src/store.ts';
import type { ChatRow, HostMessage } from '../../integrations/session-apps/chat/protocol.ts';
import { GatewayChatBridge } from '../../integrations/shell/src/bridge.ts';
import type { LayoutStorage } from '../../integrations/shell/src/layout/stored-layout.ts';
import {
  defaultDisplaySettings,
  DisplaySettings,
  displaySettingKey,
  type DisplaySettingsValues,
} from '../../integrations/shell/src/settings/display-settings.ts';
import { ListenerClock } from '../../integrations/shell/src/times/listener-clock.ts';
import {
  messageTimeText,
  zoneCalendar,
  type LocalCalendar,
} from '../../integrations/shell/src/times/message-time.ts';
import { TurnTicker, type TickerTimers } from '../../integrations/shell/src/times/turn-ticker.ts';
import {
  barState,
  elapsedText,
  runningTurnStart,
} from '../../integrations/shell/src/times/turn-times.ts';

/**
 * Turn timers, the last turn duration, message timestamps and the Display
 * switches, checked in Node with the cases of the README's tables
 * (integrations/shell/README.md, "Settings, turn timers and message
 * times"), each derived from its rule. Clocks are controlled: nothing here
 * waits for real seconds. The browser suite (settings.test.ts) checks the
 * same through the real page, gateway and listener.
 */

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;

/** This browser's clock in the timer cases: 20 Nov 2026 15:00 UTC. */
const browserNow = Date.UTC(2026, 10, 20, 15, 0, 0);

const allOn: DisplaySettingsValues = { ...defaultDisplaySettings };

// ---- Turn timers ------------------------------------------------------------------

/** Timeouts the test runs by hand: the latest pending one and its wait. */
class ManualTimers implements TickerTimers {
  pending: { callback: () => void; wait: number } | null = null;

  setTimeout(callback: () => void, milliseconds: number): unknown {
    this.pending = { callback, wait: milliseconds };
    return this.pending;
  }

  clearTimeout(handle: unknown): void {
    if (this.pending === handle) {
      this.pending = null;
    }
  }

  /** Let the pending timeout fire (the test has moved the clock on). */
  fire(): void {
    const pending = this.pending;
    assert.ok(pending, 'a timeout is pending');
    this.pending = null;
    pending.callback();
  }
}

/**
 * The page's time parts with controlled clocks: this browser's clock, the
 * listener's (ahead by `listenerAhead`), and the ticker. `observeState`
 * plays a state message as the Store applies it.
 */
function timeParts(listenerAhead = 0) {
  let now = browserNow;
  const clock = new ListenerClock(() => now);
  const timers = new ManualTimers();
  const ticker = new TurnTicker(clock, timers);
  return {
    clock,
    ticker,
    timers,
    /** Move both clocks on. */
    advance(milliseconds: number) {
      now += milliseconds;
    },
    listenerNow() {
      return now + listenerAhead;
    },
    /** A state message with (or, for an older listener, without) `listenerTime`. */
    observeState(withListenerTime = true) {
      const engine: Record<string, unknown> = { paused: false };
      if (withListenerTime) {
        engine.listenerTime = now + listenerAhead;
      }
      clock.observe(engine as never);
    },
  };
}

type Parts = ReturnType<typeof timeParts>;

/** What the bar and the list show for one conversation, as the page draws them. */
function shown(
  parts: Parts,
  session: Pick<AgentSession, 'status' | 'turnStartedAt' | 'lastTurnDurationMs'>,
  admitted: boolean,
  settings: DisplaySettingsValues = allOn,
): { bar: string; list: string; remove: () => void } {
  const state = barState(session, admitted, settings);
  const barTimer = { data: '' };
  const listTimer = { data: '' };
  const removals: (() => void)[] = [];
  let bar = '';
  if (state.kind === 'timer') {
    removals.push(parts.ticker.add(barTimer, state.startedAt));
    bar = 'working · ' + barTimer.data;
  } else {
    bar = state.text;
  }
  const start = runningTurnStart(session, admitted, settings);
  let list = '';
  if (start !== undefined) {
    removals.push(parts.ticker.add(listTimer, start));
    list = listTimer.data;
  }
  return {
    bar,
    list,
    remove() {
      for (const remove of removals) {
        remove();
      }
    },
  };
}

test('turn timers: each row of the README table', () => {
  interface Case {
    name: string;
    session: Pick<AgentSession, 'status' | 'turnStartedAt' | 'lastTurnDurationMs'>;
    admitted: boolean;
    listenerAhead?: number;
    /** The state message carries no `listenerTime` (older listener). */
    noListenerTime?: boolean;
    settings?: Partial<DisplaySettingsValues>;
    bar: string;
    list: string;
  }

  // A start `elapsed` ago on a listener clock `ahead` of the browser's.
  const startedAgo = (elapsed: number, ahead = 0) => browserNow + ahead - elapsed;
  const ran2m16 = 2 * minute + 16 * second;

  const cases: Case[] = [
    {
      name: 'no turn, no duration',
      session: { status: 'completed' },
      admitted: true,
      bar: 'ready',
      list: '',
    },
    {
      name: 'turn starting',
      session: { status: 'starting', turnStartedAt: startedAgo(0) },
      admitted: true,
      bar: 'working · 0:00',
      list: '0:00',
    },
    {
      name: 'running for 2 min 16 s',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: true,
      bar: 'working · 2:16',
      list: '2:16',
    },
    {
      name: 'ended, with a duration of 42 s',
      session: { status: 'completed', lastTurnDurationMs: 42 * second },
      admitted: true,
      bar: 'ready · last turn 0:42',
      list: '',
    },
    {
      name: 'ended without a duration',
      session: { status: 'completed' },
      admitted: true,
      bar: 'ready',
      list: '',
    },
    {
      name: 'status still running a moment after the end',
      session: { status: 'running', lastTurnDurationMs: 42 * second },
      admitted: true,
      bar: 'working…',
      list: '',
    },
    {
      name: 'reopened after a listener restart',
      session: { status: 'cancelled' },
      admitted: true,
      bar: 'ready',
      list: '',
    },
    {
      name: 'offline, last known running',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: false,
      bar: 'working…',
      list: '',
    },
    {
      name: 'reconnected, before the new snapshot',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: false,
      bar: 'working…',
      list: '',
    },
    {
      name: 'after the new snapshot, still running',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: true,
      bar: 'working · 2:16',
      list: '2:16',
    },
    {
      name: 'after the new snapshot, ended while offline',
      session: { status: 'completed', lastTurnDurationMs: 3 * minute + 5 * second },
      admitted: true,
      bar: 'ready · last turn 3:05',
      list: '',
    },
    {
      name: "listener's clock 5 min ahead",
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16, 5 * minute) },
      admitted: true,
      listenerAhead: 5 * minute,
      bar: 'working · 2:16',
      list: '2:16',
    },
    {
      name: "listener's clock 5 min behind",
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16, -5 * minute) },
      admitted: true,
      listenerAhead: -5 * minute,
      bar: 'working · 2:16',
      list: '2:16',
    },
    {
      name: 'no listenerTime (older listener), same clocks',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: true,
      noListenerTime: true,
      bar: 'working · 2:16',
      list: '2:16',
    },
    {
      name: "start later than the listener's now",
      session: { status: 'running', turnStartedAt: startedAgo(-30 * second) },
      admitted: true,
      bar: 'working · 0:00',
      list: '0:00',
    },
    {
      name: 'running 10 h 5 min 3 s',
      session: {
        status: 'running',
        turnStartedAt: startedAgo(10 * hour + 5 * minute + 3 * second),
      },
      admitted: true,
      bar: 'working · 10:05:03',
      list: '10:05:03',
    },
    {
      name: 'turn timers off, running',
      session: { status: 'running', turnStartedAt: startedAgo(ran2m16) },
      admitted: true,
      settings: { turnTimers: false },
      bar: 'working…',
      list: '',
    },
    {
      name: 'last turn duration off, ended with a duration',
      session: { status: 'completed', lastTurnDurationMs: 42 * second },
      admitted: true,
      settings: { lastTurnDuration: false },
      bar: 'ready',
      list: '',
    },
    {
      name: 'turn timers off does not hide the last duration',
      session: { status: 'completed', lastTurnDurationMs: 42 * second },
      admitted: true,
      settings: { turnTimers: false },
      bar: 'ready · last turn 0:42',
      list: '',
    },
    {
      name: 'a start that is not a usable time',
      session: { status: 'running', turnStartedAt: Number.NaN },
      admitted: true,
      bar: 'working…',
      list: '',
    },
  ];

  for (const testCase of cases) {
    const parts = timeParts(testCase.listenerAhead ?? 0);
    parts.observeState(!testCase.noListenerTime);
    const settings = { ...allOn, ...testCase.settings };
    const result = shown(parts, testCase.session, testCase.admitted, settings);
    assert.deepEqual(
      { bar: result.bar, list: result.list },
      { bar: testCase.bar, list: testCase.list },
      testCase.name,
    );
    result.remove();
  }
});

test('turn timers advance at each whole second, across one hour, without waiting', () => {
  const parts = timeParts(3 * minute);
  parts.observeState();
  const startedAt = parts.listenerNow() - (59 * minute + 58 * second + 400);
  const bar = { data: '' };
  const remove = parts.ticker.add(bar, startedAt);
  assert.equal(bar.data, '59:58');

  // The ticker waits for the next whole second of the time (600 ms here,
  // 1 ms late), never longer than a second.
  assert.equal(parts.timers.pending?.wait, 601);
  parts.advance(601);
  parts.timers.fire();
  assert.equal(bar.data, '59:59');
  assert.equal(parts.timers.pending?.wait, 1000);

  parts.advance(1000);
  parts.timers.fire();
  assert.equal(bar.data, '1:00:00');

  // One second later, as the README's "one second later" row.
  parts.advance(1000);
  parts.timers.fire();
  assert.equal(bar.data, '1:00:01');

  // Removed: no timeout stays pending.
  remove();
  assert.equal(parts.timers.pending, null);
  assert.equal(parts.ticker.count, 0);
});

test('turn timers: two conversations count independently; a new offset rewrites them', () => {
  const parts = timeParts();
  parts.observeState();
  const first = { data: '' };
  const second_ = { data: '' };
  parts.ticker.add(first, parts.listenerNow() - 5 * second);
  parts.ticker.add(second_, parts.listenerNow() - 2 * minute);
  assert.deepEqual([first.data, second_.data], ['0:05', '2:00']);

  parts.advance(1001);
  parts.timers.fire();
  assert.deepEqual([first.data, second_.data], ['0:06', '2:01']);

  // A state message reports the listener's clock 10 s further ahead than
  // thought (a clock that was set): both times move at once.
  parts.clock.observe({ listenerTime: parts.listenerNow() + 10 * second } as never);
  assert.deepEqual([first.data, second_.data], ['0:16', '2:11']);
});

test('the listener clock takes the offset from each new state message only', () => {
  let now = browserNow;
  const clock = new ListenerClock(() => now);
  let changes = 0;
  clock.subscribe(() => {
    changes++;
  });

  const engine = { listenerTime: browserNow + 90 * second } as never;
  clock.observe(engine);
  assert.equal(clock.offset, 90 * second);
  assert.equal(changes, 1);

  // The same engine object (a Store change that was not a state message)
  // does not take the offset again, even though the browser's clock moved.
  now += 5 * second;
  clock.observe(engine);
  assert.equal(clock.offset, 90 * second);

  // Signed out: kept until the next pairing's first state message.
  clock.observe(undefined);
  assert.equal(clock.offset, 90 * second);

  // A state message without listenerTime (an older listener): offset 0.
  clock.observe({ paused: false } as never);
  assert.equal(clock.offset, 0);
  assert.equal(changes, 2);
  assert.equal(clock.listenerNow(), now);
});

test('elapsed text: m:ss under an hour, h:mm:ss from an hour, never negative', () => {
  const cases: [number, string][] = [
    [-5 * second, '0:00'],
    [0, '0:00'],
    [999, '0:00'],
    [1000, '0:01'],
    [59 * second + 999, '0:59'],
    [minute, '1:00'],
    [59 * minute + 59 * second, '59:59'],
    [hour, '1:00:00'],
    [10 * hour + 5 * minute + 3 * second, '10:05:03'],
    [Number.NaN, '0:00'],
  ];
  for (const [milliseconds, text] of cases) {
    assert.equal(elapsedText(milliseconds), text, String(milliseconds));
  }
});

// ---- Message timestamps -----------------------------------------------------------

test('message timestamps: each row of the README table', () => {
  const utc = zoneCalendar('UTC');
  const amsterdam = zoneCalendar('Europe/Amsterdam');
  const tokyo = zoneCalendar('Asia/Tokyo');
  const at = (year: number, month: number, day: number, hours: number, minutes = 0, seconds = 0) =>
    Date.UTC(year, month - 1, day, hours, minutes, seconds);

  interface Case {
    name: string;
    createdAt: unknown;
    offset?: number;
    now: number;
    calendar?: LocalCalendar;
    shown: string;
  }
  const cases: Case[] = [
    {
      name: 'today',
      createdAt: at(2026, 11, 20, 14, 2),
      now: at(2026, 11, 20, 16),
      shown: '14:02',
    },
    {
      name: 'yesterday',
      createdAt: at(2026, 11, 19, 16, 48),
      now: at(2026, 11, 20, 16),
      shown: 'Yesterday 16:48',
    },
    {
      name: 'older, this year',
      createdAt: at(2026, 11, 18, 14, 2),
      now: at(2026, 11, 20, 16),
      shown: '18 Nov 14:02',
    },
    {
      name: 'another year',
      createdAt: at(2025, 12, 3, 9, 15),
      now: at(2026, 11, 20, 16),
      shown: '3 Dec 2025 09:15',
    },
    {
      name: 'just before midnight, read just after',
      createdAt: at(2026, 11, 19, 23, 59),
      now: at(2026, 11, 20, 0, 0, 30),
      shown: 'Yesterday 23:59',
    },
    {
      name: 'at midnight, read just after',
      createdAt: at(2026, 11, 20, 0, 0),
      now: at(2026, 11, 20, 0, 0, 30),
      shown: '00:00',
    },
    {
      name: 'yesterday across a new year',
      createdAt: at(2025, 12, 31, 22),
      now: at(2026, 1, 1, 8),
      shown: 'Yesterday 22:00',
    },
    {
      name: "listener's clock 2 min ahead",
      createdAt: at(2026, 11, 20, 14, 4),
      offset: 2 * minute,
      now: at(2026, 11, 20, 16),
      shown: '14:02',
    },
    {
      name: "listener's clock 2 min ahead, across midnight",
      createdAt: at(2026, 11, 20, 0, 1),
      offset: 2 * minute,
      now: at(2026, 11, 20, 8),
      shown: 'Yesterday 23:59',
    },
    {
      name: 'reader in Tokyo',
      createdAt: at(2026, 11, 20, 5, 2),
      now: at(2026, 11, 20, 7),
      calendar: tokyo,
      shown: '14:02',
    },
    {
      name: 'the same moment, reader in Amsterdam',
      createdAt: at(2026, 11, 20, 5, 2),
      now: at(2026, 11, 20, 7),
      calendar: amsterdam,
      shown: '06:02',
    },
    {
      // 28 Mar 2026 12:00 CET is 11:00 UTC; 29 Mar 12:00 CEST is 10:00 UTC:
      // 23 hours apart, still yesterday by the calendar.
      name: 'the day before summer time, Amsterdam',
      createdAt: at(2026, 3, 28, 11),
      now: at(2026, 3, 29, 10),
      calendar: amsterdam,
      shown: 'Yesterday 12:00',
    },
    { name: 'no createdAt', createdAt: undefined, now: at(2026, 11, 20, 16), shown: '' },
    { name: 'not a number', createdAt: '1763647320000', now: at(2026, 11, 20, 16), shown: '' },
    {
      name: 'not finite',
      createdAt: Number.POSITIVE_INFINITY,
      now: at(2026, 11, 20, 16),
      shown: '',
    },
  ];

  for (const testCase of cases) {
    const shown = messageTimeText(
      testCase.createdAt,
      testCase.offset ?? 0,
      testCase.now,
      testCase.calendar ?? utc,
    );
    assert.equal(shown, testCase.shown, testCase.name);
  }
});

// ---- Display switches --------------------------------------------------------------

/** An in-memory stand-in for localStorage, shared by "tabs" like the real one. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage: LayoutStorage & { items: Map<string, string>; refuse: boolean } = {
    items,
    refuse: false,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (storage.refuse) {
        throw Error('QuotaExceededError');
      }
      items.set(key, value);
    },
  };
  return storage;
}

const timersKey = displaySettingKey('turnTimers');
const durationKey = displaySettingKey('lastTurnDuration');
const stampsKey = displaySettingKey('messageTimestamps');

function entry(value: unknown): string {
  return JSON.stringify({ version: 1, value });
}

test('display switches: each row of the README table', () => {
  // Nothing remembered: all three on.
  const fresh = memoryStorage();
  assert.deepEqual(new DisplaySettings(() => fresh).values, allOn);

  // Each switched off: only its own entry is written, the others not at all.
  for (const name of ['turnTimers', 'lastTurnDuration', 'messageTimestamps'] as const) {
    const storage = memoryStorage();
    const settings = new DisplaySettings(() => storage);
    settings.set(name, false);
    assert.deepEqual([...storage.items.keys()], [displaySettingKey(name)], name);
    assert.equal(storage.items.get(displaySettingKey(name)), entry(false));
    assert.deepEqual(settings.values, { ...allOn, [name]: false });

    // On again: its entry says so.
    settings.set(name, true);
    assert.equal(storage.items.get(displaySettingKey(name)), entry(true));

    // Reload: as remembered.
    settings.set(name, false);
    assert.deepEqual(new DisplaySettings(() => storage).values, { ...allOn, [name]: false });
  }

  // Another tab switches one: this tab follows that switch only.
  const shared = memoryStorage();
  const here = new DisplaySettings(() => shared);
  const there = new DisplaySettings(() => shared);
  let changes = 0;
  here.subscribe(() => {
    changes++;
  });
  there.set('messageTimestamps', false);
  here.followStorage(stampsKey);
  assert.deepEqual(here.values, { ...allOn, messageTimestamps: false });
  assert.equal(changes, 1);
  // A key of something else changes nothing.
  here.followStorage('companion.shell.layout.listWidth');
  assert.equal(changes, 1);

  // Two tabs switch different ones at the same moment (each writes before
  // seeing the other's event): both kept, in both tabs.
  here.set('turnTimers', false);
  there.set('lastTurnDuration', false);
  here.followStorage(durationKey);
  there.followStorage(timersKey);
  const expected = { turnTimers: false, lastTurnDuration: false, messageTimestamps: false };
  assert.deepEqual(here.values, expected);
  assert.deepEqual(there.values, expected);
  assert.deepEqual(new DisplaySettings(() => shared).values, expected);

  // Storage refuses writes: off for this page; a reload shows it on.
  const refusing = memoryStorage();
  refusing.refuse = true;
  const page = new DisplaySettings(() => refusing);
  page.set('turnTimers', false);
  assert.equal(page.values.turnTimers, false);
  assert.deepEqual(new DisplaySettings(() => refusing).values, allOn);

  // Storage cannot be used at all: all on; switches work for this page.
  const noStorage = new DisplaySettings(() => null);
  assert.deepEqual(noStorage.values, allOn);
  noStorage.set('messageTimestamps', false);
  assert.equal(noStorage.values.messageTimestamps, false);
  noStorage.followStorage(stampsKey);
  assert.equal(noStorage.values.messageTimestamps, false);

  // Storage that throws on reading: all on.
  const unreadable: LayoutStorage = {
    getItem: () => {
      throw Error('SecurityError');
    },
    setItem: () => {},
  };
  assert.deepEqual(new DisplaySettings(() => unreadable).values, allOn);

  // Invalid entries give that switch's default (on); the others as remembered.
  for (const invalid of [
    'not json',
    JSON.stringify({ version: 2, value: false }),
    entry('no'),
    entry(0),
    entry(null),
    JSON.stringify(false),
  ]) {
    const storage = memoryStorage({ [timersKey]: invalid, [durationKey]: entry(false) });
    assert.deepEqual(
      new DisplaySettings(() => storage).values,
      { ...allOn, lastTurnDuration: false },
      invalid,
    );
  }

  // Another tab cleared the whole storage (the page reloads; this is what a
  // tab that followed it would show): all on.
  const cleared = memoryStorage({ [timersKey]: entry(false) });
  const before = new DisplaySettings(() => cleared);
  cleared.items.clear();
  before.followStorage(null);
  assert.deepEqual(before.values, allOn);
});

// ---- Message times through the bridge ---------------------------------------------

const sessionId = '11111111-1111-4111-8111-111111111111';

/** The parts of the phone Store the bridge reads, enough to show one conversation. */
class FakeStore {
  state = {
    connection: { status: 'online', message: '', retryAt: 0, deviceName: 'Synthetic' },
    engine: undefined as object | undefined,
    sessions: new Map<string, AgentSession>(),
    selected: '',
    sends: new Map<string, { pending: boolean; error: string }>(),
    actions: undefined as unknown,
  };
  private readonly listeners = new Set<() => void>();
  readonly connection = { request: () => new Promise(() => {}) };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(change: Partial<FakeStore['state']>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }

  draft(): string {
    return '';
  }

  setDraft(): void {}
}

function conversation(messages: AgentSession['messages']): AgentSession {
  return {
    id: sessionId,
    title: 'Times',
    status: 'completed',
    model: 'synthetic/model',
    error: '',
    messages,
    updatedAt: 1,
    toolEpoch: 'epoch',
  };
}

/**
 * A bridge showing one conversation, with message times from a controlled
 * clock (UTC). The listener clock is subscribed before the bridge, as in
 * main.tsx.
 */
function bridgeHarness(context: { after(callback: () => void): void }, storage = memoryStorage()) {
  let now = Date.UTC(2026, 10, 20, 16, 0);
  const store = new FakeStore();
  const clock = new ListenerClock(() => now);
  store.subscribe(() => clock.observe(store.state.engine as never));
  const settings = new DisplaySettings(() => storage);
  const written = Date.UTC(2026, 10, 20, 14, 2);
  store.state.sessions.set(
    sessionId,
    conversation([
      { ...chatMessage('q1', 'user', 'Question'), createdAt: written },
      { ...chatMessage('a1', 'assistant', 'Answer'), createdAt: written + 30 * second },
      // Saved by an older version: no time.
      chatMessage('old', 'notice', 'An old notice'),
    ]),
  );
  store.state.selected = sessionId;
  const bridge = new GatewayChatBridge(
    store as unknown as Store,
    { visibleIndexes: () => [], topIndex: () => -1 },
    { settings, clock, calendar: zoneCalendar('UTC') },
  );
  const messages: HostMessage[] = [];
  bridge.message.connect((json) => messages.push(JSON.parse(json) as HostMessage));
  bridge.ready('synthetic-document');
  store.update({ engine: { paused: false, listenerTime: now } });
  // Switched off at the end, the bridge no longer waits for the next day,
  // so nothing keeps Node running.
  context.after(() => settings.set('messageTimestamps', false));

  return {
    store,
    settings,
    messages,
    setNow(value: number) {
      now = value;
    },
    /** The latest row of each message the page received, by message ID. */
    rows(): Map<string, ChatRow> {
      const latest = new Map<string, ChatRow>();
      for (const message of messages) {
        if (message.type === 'rows') {
          for (const row of message.changed) {
            latest.set(row.id, row);
          }
        }
      }
      return latest;
    },
    /** The message IDs of rows sent since `from` (an index into `messages`). */
    sentSince(from: number): string[] {
      const ids: string[] = [];
      for (const message of messages.slice(from)) {
        if (message.type === 'rows') {
          ids.push(...message.changed.map((row) => row.id));
        }
      }
      return ids;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function timesOf(rows: Map<string, ChatRow>): Record<string, string | undefined> {
  const times: Record<string, string | undefined> = {};
  for (const [key, row] of rows) {
    times[key] = row.time;
  }
  return times;
}

test('message times reach the page in the rows, only with a time and while switched on', async (context) => {
  const harness = bridgeHarness(context);
  await settle();
  const rows = harness.rows();
  assert.deepEqual(timesOf(rows), { q1: '14:02', a1: '14:02', old: undefined });
  // A message without a time has no `time` key at all (as the Qt host's rows).
  assert.equal('time' in rows.get('old')!, false);

  // Switched off: the rows are sent again without the field, exactly the
  // Qt host's rows.
  const before = harness.messages.length;
  harness.settings.set('messageTimestamps', false);
  await settle();
  assert.deepEqual(harness.sentSince(before), ['q1', 'a1']);
  for (const row of harness.rows().values()) {
    assert.equal('time' in row, false, row.key);
  }

  // On again: the times are back.
  harness.settings.set('messageTimestamps', true);
  await settle();
  assert.deepEqual(timesOf(harness.rows()), { q1: '14:02', a1: '14:02', old: undefined });
});

test('a streaming answer keeps its time; a new offset changes the text', async (context) => {
  const harness = bridgeHarness(context);
  await settle();

  // The answer streams: the listener keeps its createdAt on each update.
  const session = harness.store.state.sessions.get(sessionId)!;
  const answer = session.messages[1];
  for (let update = 1; update <= 10; update++) {
    const messages = session.messages.slice();
    messages[1] = { ...answer, text: 'Answer'.repeat(update), state: 'running' };
    harness.store.update({
      sessions: new Map([[sessionId, { ...session, messages }]]),
    });
    await settle();
    assert.equal(harness.rows().get('a1')!.time, '14:02', `update ${update}`);
  }

  // A state message says the listener's clock is 3 minutes ahead: the
  // reader's time of each message is 3 minutes earlier.
  harness.store.update({
    engine: { paused: false, listenerTime: Date.UTC(2026, 10, 20, 16, 3) },
  });
  await settle();
  assert.equal(harness.rows().get('q1')!.time, '13:59');
});

test('when a new day starts here, today’s times become “Yesterday”', async (context) => {
  // Every timeout of the bridge runs on the test's clock from the start, so
  // the wait for the next day is run without waiting.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = bridgeHarness(context);
  const flush = async () => {
    // Deliveries to the page are microtasks.
    for (let round = 0; round < 5; round++) {
      await Promise.resolve();
    }
  };
  context.mock.timers.tick(50);
  await flush();
  assert.equal(harness.rows().get('q1')!.time, '14:02');

  // Midnight passes: the bridge's wait for the next local day ends (at
  // most an hour at a time) and the rows go out again.
  // (The test's timeouts do not run timeouts they set themselves within
  // the same tick, hence two ticks: the day's wait, then the rows' 30 ms.)
  harness.setNow(Date.UTC(2026, 10, 21, 0, 0, 5));
  context.mock.timers.tick(60 * 60 * 1000);
  context.mock.timers.tick(50);
  await flush();
  assert.equal(harness.rows().get('q1')!.time, 'Yesterday 14:02');
  assert.equal(harness.rows().get('a1')!.time, 'Yesterday 14:02');
});
