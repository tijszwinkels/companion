import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSession } from '../../src/agents/types.ts';
import {
  applicationLayout,
  areaWidth,
  chatPaneWidthFromKey,
  chatPaneWidthFromPointer,
  shownChatPaneWidth,
  splitPossible,
  type ApplicationLayoutChoice,
} from '../../integrations/shell/src/application/application-layout.ts';
import {
  ApplicationModes,
  switchBlocker,
} from '../../integrations/shell/src/application/application-view.ts';
import {
  ChatPermissions,
  noConfirmationText,
  permissionIdentity,
  permissionSummary,
  readStatus,
  sendStatus,
  waitingText,
  type PermissionRequest,
} from '../../integrations/shell/src/application/chat-permissions.ts';
import {
  applicationKey,
  shownApplication,
  type ApplicationChatAccess,
  type ShownApplication,
} from '../../integrations/shell/src/application/shown-application.ts';
import {
  activityReservedWidth,
  sideColumnWidth,
} from '../../integrations/shell/src/layout/activity-width.ts';
import { shownListWidth, stripWidth } from '../../integrations/shell/src/layout/list-width.ts';
import {
  applicationChatWidthKey,
  applicationLayoutKey,
  readApplicationLayout,
  writeApplicationChatWidth,
  writeApplicationLayout,
  type LayoutStorage,
} from '../../integrations/shell/src/layout/stored-layout.ts';
import { pinnedWidget } from '../../integrations/shell/src/widgets/pinned-widget.ts';

/**
 * The session application's rules (integrations/shell/README.md, "Session
 * applications"), each with one table of cases derived from it: layout,
 * application changes and permissions. The browser suite
 * (session-apps.test.ts) checks the same rules through the real page,
 * gateway and listener.
 */

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}): LayoutStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function entry(value: unknown, version = 1): string {
  return JSON.stringify({ version, value });
}

// ---- Layout --------------------------------------------------------------------

interface LayoutCase {
  case: string;
  window: number;
  /** 'strip', a full list's preferred width, or 'hidden'. */
  list: 'strip' | 'hidden' | number;
  /** The Activity column's preferred width while shown, or 0 (hidden). */
  activity: number;
  choice: ApplicationLayoutChoice;
  layout: 'split' | 'switch';
  /** The chat's width in the split layout (default preference 420). */
  chat?: number;
  /** ◫ Chat at the right is offered in the switch layout. */
  offered?: boolean;
}

/** The area beside the list and the Activity column, by those columns' own rules. */
function areaOf(windowWidth: number, list: LayoutCase['list'], activity: number): number {
  const listShown = list !== 'hidden';
  let listPreference = stripWidth;
  if (typeof list === 'number') {
    listPreference = list;
  }
  const reserved = activityReservedWidth(activity, activity > 0, windowWidth, listShown);
  const listWidth = shownListWidth(listPreference, windowWidth - reserved);
  return areaWidth({
    windowWidth,
    listShown,
    listWidth,
    rightColumnBeside: activity > 0,
    rightColumnWidth: sideColumnWidth(activity, windowWidth, listShown),
  });
}

const layoutCases: LayoutCase[] = [
  {
    case: 'nothing remembered, 1280 px, strip',
    window: 1280,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'split',
    chat: 420,
  },
  {
    case: '1600 px',
    window: 1600,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'split',
    chat: 420,
  },
  {
    case: '1100 px, strip',
    window: 1100,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'split',
    chat: 420,
  },
  {
    case: '1099 px, strip',
    window: 1099,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'switch',
    offered: false,
  },
  {
    case: '900 px',
    window: 900,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'switch',
    offered: false,
  },
  {
    case: '420 px',
    window: 420,
    list: 'strip',
    activity: 0,
    choice: 'split',
    layout: 'switch',
    offered: false,
  },
  {
    case: '1100 px, Activity 320 beside (area 700)',
    window: 1100,
    list: 'strip',
    activity: 320,
    choice: 'split',
    layout: 'split',
    chat: 379,
  },
  {
    case: '1100 px, full list 420, Activity 520 (area 320)',
    window: 1100,
    list: 420,
    activity: 520,
    choice: 'split',
    layout: 'switch',
    offered: false,
  },
  {
    case: '1280 px, full list 300 (area 979)',
    window: 1280,
    list: 300,
    activity: 0,
    choice: 'split',
    layout: 'split',
    chat: 420,
  },
  {
    case: 'App only, 1280 px',
    window: 1280,
    list: 'strip',
    activity: 0,
    choice: 'app-only',
    layout: 'switch',
    offered: true,
  },
  {
    case: 'App only, 900 px',
    window: 900,
    list: 'strip',
    activity: 0,
    choice: 'app-only',
    layout: 'switch',
    offered: false,
  },
  {
    case: 'list hidden, 1100 px',
    window: 1100,
    list: 'hidden',
    activity: 0,
    choice: 'split',
    layout: 'split',
    chat: 420,
  },
];

test('layout rule: split or switch by the choice, the window and the area beside the columns', () => {
  for (const row of layoutCases) {
    const area = areaOf(row.window, row.list, row.activity);
    assert.equal(applicationLayout(row.choice, row.window, area), row.layout, row.case);
    if (row.chat !== undefined) {
      assert.equal(shownChatPaneWidth(420, area), row.chat, row.case);
    }
    if (row.offered !== undefined) {
      assert.equal(splitPossible(row.window, area), row.offered, row.case);
    }
  }
});

test('layout rule: the area of the table rows that name it', () => {
  assert.equal(areaOf(1100, 'strip', 320), 700);
  assert.equal(areaOf(1100, 420, 520), 320);
  assert.equal(areaOf(1280, 300, 0), 979);
});

test('layout rule: the divider by pointer and keys, within its bounds', () => {
  const rows: { case: string; value: number | null; expected: number | null }[] = [
    { case: 'dragged to 500 px', value: chatPaneWidthFromPointer(500), expected: 500 },
    { case: 'dragged to 100 px', value: chatPaneWidthFromPointer(100), expected: 320 },
    { case: 'dragged to 900 px', value: chatPaneWidthFromPointer(900), expected: 640 },
    { case: 'Left from 420', value: chatPaneWidthFromKey('ArrowLeft', 420), expected: 440 },
    { case: 'Right from 420', value: chatPaneWidthFromKey('ArrowRight', 420), expected: 400 },
    { case: 'Right from 330', value: chatPaneWidthFromKey('ArrowRight', 330), expected: 320 },
    { case: 'Left from 630', value: chatPaneWidthFromKey('ArrowLeft', 630), expected: 640 },
    { case: 'Home', value: chatPaneWidthFromKey('Home', 500), expected: 320 },
    { case: 'End', value: chatPaneWidthFromKey('End', 500), expected: 640 },
    { case: 'another key', value: chatPaneWidthFromKey('a', 500), expected: null },
  ];
  for (const row of rows) {
    assert.equal(row.value, row.expected, row.case);
  }
  // At most the area less the application's 320 px and the divider.
  assert.equal(shownChatPaneWidth(640, 900), 579);
  assert.equal(shownChatPaneWidth(640, 1500), 640);
});

test('layout rule: the remembered choice and width, entry by entry', () => {
  const rows: { case: string; items: Record<string, string>; choice: string; width: number }[] = [
    { case: 'nothing remembered', items: {}, choice: 'split', width: 420 },
    {
      case: 'App only and 500 px',
      items: { [applicationLayoutKey]: entry('app-only'), [applicationChatWidthKey]: entry(500) },
      choice: 'app-only',
      width: 500,
    },
    {
      case: 'choice "wide"',
      items: { [applicationLayoutKey]: entry('wide') },
      choice: 'split',
      width: 420,
    },
    { case: 'choice 3', items: { [applicationLayoutKey]: entry(3) }, choice: 'split', width: 420 },
    {
      case: 'choice of version 2',
      items: { [applicationLayoutKey]: entry('app-only', 2) },
      choice: 'split',
      width: 420,
    },
    { case: 'not JSON', items: { [applicationLayoutKey]: '{' }, choice: 'split', width: 420 },
    {
      case: 'width "500"',
      items: { [applicationChatWidthKey]: entry('500') },
      choice: 'split',
      width: 420,
    },
    {
      case: 'width NaN (null)',
      items: { [applicationChatWidthKey]: entry(NaN) },
      choice: 'split',
      width: 420,
    },
    {
      case: 'width 2000',
      items: { [applicationChatWidthKey]: entry(2000) },
      choice: 'split',
      width: 640,
    },
  ];
  for (const row of rows) {
    const layout = readApplicationLayout(memoryStorage(row.items));
    assert.equal(layout.applicationLayout, row.choice, row.case);
    assert.equal(layout.applicationChatWidth, row.width, row.case);
  }

  // A change writes only its own entry.
  const storage = memoryStorage();
  writeApplicationLayout(storage, 'app-only');
  assert.deepEqual([...storage.items.keys()], [applicationLayoutKey]);
  writeApplicationChatWidth(storage, 9999);
  assert.equal(storage.items.get(applicationChatWidthKey), entry(640));

  // A storage that refuses writes keeps nothing and throws nothing.
  const refusing: LayoutStorage = {
    getItem: () => null,
    setItem: () => {
      throw Error('QuotaExceededError');
    },
  };
  writeApplicationLayout(refusing, 'app-only');
});

test('layout rule 8: a conversation with an application has no pinned widget', () => {
  const pinnedMessage = {
    id: 'm1',
    kind: 'assistant',
    text: '',
    createdAt: 0,
    widget: {
      id: 'w1',
      name: 'counter',
      presentation: { placement: 'pinned' },
      frameUrl: 'http://127.0.0.1:9/f/' + 'a'.repeat(43) + '/',
    },
  };
  const session = { id: 's1', messages: [], pinnedMessage } as unknown as AgentSession;
  assert.equal(pinnedWidget(session)?.messageId, 'm1');
  const withApplication = {
    ...session,
    application: { id: 'a', name: 'notes', version: 1, text: '' },
  } as unknown as AgentSession;
  assert.equal(pinnedWidget(withApplication), null);
});

// ---- What is shown for an application -------------------------------------------

const address = 'http://127.0.0.1:9/f/' + 'b'.repeat(43) + '/';
const uuid = '11111111-2222-4333-8444-555555555555';
const revision = 'aaaaaaaa-2222-4333-8444-555555555555';

function sessionWith(application: unknown): AgentSession {
  return { id: 's1', messages: [], application } as unknown as AgentSession;
}

test('what is shown: a frame, unavailable, not set up, or nothing', () => {
  assert.equal(shownApplication(sessionWith(undefined)), null);
  const base = {
    id: uuid,
    name: 'notes',
    version: 2,
    revision: 3,
    text: 'Notes: 1',
    eventMode: 'next-input',
  };
  assert.equal(shownApplication(sessionWith({ ...base, frameUrl: address }))?.kind, 'frame');
  assert.equal(shownApplication(sessionWith(base))?.kind, 'not-set-up');
  assert.equal(
    shownApplication(sessionWith({ ...base, frameUrl: address + '?x' }))?.kind,
    'not-set-up',
  );
  assert.equal(
    shownApplication(sessionWith({ ...base, frameUrl: address, error: 'Bundle missing' }))?.kind,
    'unavailable',
  );
  assert.equal(
    applicationKey(shownApplication(sessionWith({ ...base, frameUrl: address }))),
    uuid + ':2',
  );
  assert.equal(applicationKey(null), '');
});

// ---- Application changes --------------------------------------------------------

/** One step of the application-change table, on one `ApplicationModes`. */
interface ChangeStep {
  case: string;
  /** What the page shows of the conversation now: its application key, or '' for none. */
  key?: string;
  /** Why switching would interrupt input now. */
  blocker?: string;
  /** The reader chooses. */
  choose?: 'chat' | 'app';
  /** Another conversation is shown (observed) in between. */
  other?: boolean;
  mode: 'chat' | 'app';
  notice: string;
}

const typing = switchBlocker({ pendingSend: false, pendingChoice: false, composerFocused: true });
const sending = switchBlocker({ pendingSend: true, pendingChoice: false, composerFocused: true });
const choosing = switchBlocker({ pendingSend: false, pendingChoice: true, composerFocused: false });
const ready = (reason: string) => `“notes” is ready. It opens when you choose it; ${reason}.`;

const changeTables: { case: string; steps: ChangeStep[] }[] = [
  {
    case: 'first sight shows the application; the reader chose chat before: chat',
    steps: [
      { case: 'opened with an application', key: 'a:1', mode: 'app', notice: '' },
      { case: 'the reader chooses Chat', key: 'a:1', choose: 'chat', mode: 'chat', notice: '' },
      { case: 'another conversation, and back', key: 'a:1', other: true, mode: 'chat', notice: '' },
    ],
  },
  {
    case: 'none, then an application arrives; nothing blocks',
    steps: [
      { case: 'no application', key: '', mode: 'chat', notice: '' },
      { case: 'an application arrives', key: 'a:1', mode: 'app', notice: '' },
    ],
  },
  {
    case: 'an application arrives while typing, then the reader opens it',
    steps: [
      { case: 'no application', key: '', mode: 'chat', notice: '' },
      {
        case: 'arrives while typing',
        key: 'a:1',
        blocker: typing,
        mode: 'chat',
        notice: ready('you are typing'),
      },
      { case: 'the same version again', key: 'a:1', mode: 'chat', notice: ready('you are typing') },
      { case: 'the reader opens it', key: 'a:1', choose: 'app', mode: 'app', notice: '' },
    ],
  },
  {
    case: 'a send waiting, a choice waiting',
    steps: [
      { case: 'no application', key: '', mode: 'chat', notice: '' },
      {
        case: 'arrives while a send waits',
        key: 'a:1',
        blocker: sending,
        mode: 'chat',
        notice: ready('a message is still being sent'),
      },
      {
        case: 'a new version while a choice waits',
        key: 'a:2',
        blocker: choosing,
        mode: 'chat',
        notice: ready('a choice is still being confirmed'),
      },
    ],
  },
  {
    case: 'a new version while the application is shown',
    steps: [
      { case: 'opened with an application', key: 'a:1', mode: 'app', notice: '' },
      { case: 'a new version, nothing blocks', key: 'a:2', mode: 'app', notice: '' },
      {
        case: 'a newer one while typing in a hidden composer',
        key: 'a:3',
        blocker: typing,
        mode: 'app',
        notice: ready('you are typing'),
      },
    ],
  },
  {
    case: 'a new version while the chat is shown and the reader types',
    steps: [
      {
        case: 'opened, the reader chooses Chat',
        key: 'a:1',
        choose: 'chat',
        mode: 'chat',
        notice: '',
      },
      {
        case: 'a new version while typing',
        key: 'a:2',
        blocker: typing,
        mode: 'chat',
        notice: ready('you are typing'),
      },
      { case: 'the reader chooses Chat', key: 'a:2', choose: 'chat', mode: 'chat', notice: '' },
    ],
  },
  {
    case: 'removed: chat, the notice goes',
    steps: [
      { case: 'no application', key: '', mode: 'chat', notice: '' },
      {
        case: 'arrives while typing',
        key: 'a:1',
        blocker: typing,
        mode: 'chat',
        notice: ready('you are typing'),
      },
      { case: 'removed', key: '', mode: 'chat', notice: '' },
    ],
  },
  {
    case: 'a new version while another conversation is shown',
    steps: [
      { case: 'opened, chat chosen', key: 'a:1', choose: 'chat', mode: 'chat', notice: '' },
      {
        case: 'back after a new version, nothing blocks',
        key: 'a:2',
        other: true,
        mode: 'app',
        notice: '',
      },
    ],
  },
];

test('application-change rule: the desktop’s cases, step by step', () => {
  for (const table of changeTables) {
    const modes = new ApplicationModes();
    for (const step of table.steps) {
      const label = `${table.case} / ${step.case}`;
      if (step.other) {
        modes.observe('s2', 'b:1', 'other', '');
      }
      if (step.key !== undefined) {
        modes.observe('s1', step.key, 'notes', step.blocker ?? '');
      }
      if (step.choose) {
        modes.choose('s1', step.choose);
      }
      assert.equal(modes.mode('s1', step.key !== ''), step.mode, label);
      assert.equal(modes.notice('s1'), step.notice, label);
    }
  }
});

test('application-change rule: narrowing while typing keeps the chat and the notice (not the reader’s choice)', () => {
  const modes = new ApplicationModes();
  modes.observe('s1', '', 'notes', '');
  modes.observe('s1', 'a:1', 'notes', typing);
  // Wide: the application beside the chat; the reader had not chosen.
  modes.keep('s1', 'chat');
  assert.equal(modes.mode('s1', true), 'chat');
  assert.equal(modes.notice('s1'), ready('you are typing'));
  // The reader's own choice clears it.
  modes.choose('s1', 'app');
  assert.equal(modes.notice('s1'), '');
});

test('application-change rule: the blockers, in the desktop’s words and order', () => {
  const rows: [boolean, boolean, boolean, string][] = [
    [false, false, false, ''],
    [true, false, false, 'a message is still being sent'],
    [false, true, false, 'a choice is still being confirmed'],
    [false, false, true, 'you are typing'],
    [true, true, true, 'a message is still being sent'],
  ];
  for (const [pendingSend, pendingChoice, composerFocused, expected] of rows) {
    assert.equal(switchBlocker({ pendingSend, pendingChoice, composerFocused }), expected);
  }
});

// ---- Permissions ----------------------------------------------------------------

function access(change: Partial<ApplicationChatAccess> = {}): ApplicationChatAccess {
  return {
    requested: ['chat.read', 'chat.send'],
    read: false,
    send: { allowed: false, remaining: 0, busy: false },
    revision,
    ...change,
  };
}

function frameApplication(chatAccess: ApplicationChatAccess | null, version = 1): ShownApplication {
  return { kind: 'frame', id: uuid, name: 'notes', version, text: '', address, chatAccess };
}

test('permission rule 1-2: the status texts, in the desktop’s words', () => {
  const rows: {
    case: string;
    access: ApplicationChatAccess | null;
    online: boolean;
    summary: string;
    read: string;
    send: string;
  }[] = [
    {
      case: 'nothing allowed',
      access: access(),
      online: true,
      summary: 'Chat reading off · sending off',
      read: 'Chat reading off',
      send: 'App sending off',
    },
    {
      case: 'reading allowed, 3 of 5 left',
      access: access({ read: true, send: { allowed: true, remaining: 3, busy: false } }),
      online: true,
      summary: 'Chat reading on · sending on, 3/5 left',
      read: 'Chat reading allowed',
      send: 'App sending allowed · 3 of 5 attempts remaining',
    },
    {
      case: 'all sent, one active',
      access: access({ send: { allowed: true, remaining: 0, busy: true } }),
      online: true,
      summary: 'Chat reading off · sending used up · app message active',
      read: 'Chat reading off',
      send: 'App sending exhausted · 0 of 5 attempts remaining · app message active',
    },
    {
      case: 'an older listener without send',
      access: access({ send: null }),
      online: true,
      summary: 'Chat reading off · sending unavailable',
      read: 'Chat reading off',
      send: 'App sending unavailable on this host',
    },
    {
      case: 'disconnected',
      access: access(),
      online: false,
      summary: 'Chat reading off · sending off · Disconnected',
      read: 'Chat reading off · Disconnected',
      send: 'App sending off',
    },
    {
      case: 'asks for neither',
      access: access({ requested: [] }),
      online: true,
      summary: '',
      read: 'Chat reading off',
      send: 'App sending off',
    },
    {
      case: 'reading only',
      access: access({ requested: ['chat.read'] }),
      online: true,
      summary: 'Chat reading off',
      read: 'Chat reading off',
      send: 'App sending off',
    },
  ];
  for (const row of rows) {
    assert.equal(permissionSummary(row.access, row.online), row.summary, row.case);
    assert.equal(readStatus(row.access, row.online), row.read, row.case);
    assert.equal(sendStatus(row.access), row.send, row.case);
  }
});

/** A sender that records requests and lets the test settle each one. */
function recordingSender() {
  const sent: {
    request: PermissionRequest;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const send = (request: PermissionRequest) =>
    new Promise<unknown>((resolve, reject) => {
      sent.push({ request, resolve, reject });
    });
  return { sent, send };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One permission case: the rows after the steps, and what was sent. */
interface PermissionCase {
  case: string;
  run: (context: {
    permissions: ChatPermissions;
    show: (application: ShownApplication | null, sessionId?: string) => void;
    change: (kind: 'read' | 'send', allowed: boolean, admitted?: boolean) => boolean;
    sender: ReturnType<typeof recordingSender>;
  }) => Promise<void>;
}

const permissionCases: PermissionCase[] = [
  {
    case: 'reading off: review → allow → waiting, then the listener’s state',
    async run({ permissions, show, change, sender }) {
      assert.equal(permissions.review('read', true, access()), true);
      assert.equal(permissions.state().reviewingRead, true);
      assert.equal(change('read', true), true);
      assert.equal(permissions.state().feedback, waitingText);
      assert.equal(permissions.state().waiting, true);
      assert.deepEqual(sender.sent[0].request, {
        action: 'set-application-chat-read',
        parameters: { id: 's1', applicationId: uuid, version: 1, revision, allowed: true },
      });
      // The listener's new state arrives before its answer: a new revision.
      show(frameApplication(access({ read: true, revision: uuid })));
      assert.equal(permissions.state().waiting, false);
      sender.sent[0].resolve(access({ read: true }));
      await settled();
      assert.equal(permissions.state().feedback, '');
    },
  },
  {
    case: 'allowing needs a review; revoking does not',
    async run({ permissions, change, sender, show }) {
      assert.equal(change('read', true), false);
      assert.equal(change('send', true), false);
      assert.equal(sender.sent.length, 0);
      show(frameApplication(access({ read: true })));
      assert.equal(change('read', false), true);
      assert.equal(sender.sent[0].request.parameters.allowed, false);
      void permissions;
    },
  },
  {
    case: 'sending: review → Allow 5 app messages; one change at a time',
    async run({ permissions, change, sender }) {
      assert.equal(permissions.review('send', true, access()), true);
      assert.equal(permissions.state().reviewingRead, false);
      assert.equal(change('send', true), true);
      assert.equal(sender.sent[0].request.action, 'set-application-chat-send');
      assert.equal(permissions.canChange(true, access()), false);
      assert.equal(change('send', false), false);
      sender.sent[0].resolve(null);
      await settled();
      assert.equal(permissions.state().reviewingSend, false);
      assert.equal(permissions.canChange(true, access()), true);
    },
  },
  {
    case: 'Not now closes the review; nothing is sent',
    async run({ permissions, sender }) {
      permissions.review('read', true, access());
      permissions.decline('read');
      assert.equal(permissions.state().reviewingRead, false);
      assert.equal(sender.sent.length, 0);
    },
  },
  {
    case: 'refused by the listener: the refusal under the rows, the state unchanged',
    async run({ permissions, change, sender }) {
      for (const refusal of [
        'Open this conversation on this device first',
        'Show this conversation on this device first',
        'Application or permissions changed; review the current permission controls.',
        'Too many requests',
      ]) {
        permissions.review('read', true, access());
        change('read', true);
        sender.sent[sender.sent.length - 1].reject(Error(refusal));
        await settled();
        assert.equal(permissions.state().feedback, refusal);
        assert.equal(permissions.state().waiting, false);
        assert.equal(permissions.state().open, true);
      }
    },
  },
  {
    case: 'changed elsewhere while the rows are open: an open review closes',
    async run({ permissions, show }) {
      permissions.expand();
      permissions.review('send', true, access());
      show(frameApplication(access({ read: true, revision: uuid })));
      assert.equal(permissions.state().reviewingSend, false);
      assert.equal(permissions.state().open, true);
    },
  },
  {
    case: 'changed elsewhere while a change waits: forgotten, its answer ignored',
    async run({ permissions, show, change, sender }) {
      permissions.review('read', true, access());
      change('read', true);
      show(
        frameApplication(
          access({ send: { allowed: true, remaining: 5, busy: false }, revision: uuid }),
        ),
      );
      assert.equal(permissions.state().waiting, false);
      sender.sent[0].reject(
        Error('Application or permissions changed; review the current permission controls.'),
      );
      await settled();
      assert.equal(permissions.state().feedback, '');
    },
  },
  {
    case: 'a new version while a change waits: forgotten',
    async run({ permissions, show, change }) {
      permissions.review('read', true, access());
      change('read', true);
      show(frameApplication(access({ revision: uuid }), 2));
      assert.equal(permissions.state().waiting, false);
      assert.equal(permissions.state().reviewingRead, false);
    },
  },
  {
    case: 'the answer is lost: the desktop’s text, nothing sent again',
    async run({ permissions, change, sender }) {
      permissions.review('read', true, access());
      change('read', true);
      sender.sent[0].reject(
        Object.assign(Error('Companion has not answered yet.'), { uncertain: true }),
      );
      await settled();
      assert.equal(permissions.state().feedback, noConfirmationText);
      assert.equal(sender.sent.length, 1);
    },
  },
  {
    case: 'not admitted (disconnected): nothing can change',
    async run({ permissions, change, sender }) {
      assert.equal(permissions.review('read', false, access()), false);
      permissions.review('read', true, access());
      assert.equal(change('read', true, false), false);
      assert.equal(sender.sent.length, 0);
    },
  },
  {
    case: 'another conversation shown: the rows hide, reviews close',
    async run({ permissions, show }) {
      permissions.expand();
      permissions.review('read', true, access());
      show(frameApplication(access()), 's2');
      assert.equal(permissions.state().open, false);
      assert.equal(permissions.state().reviewingRead, false);
    },
  },
  {
    case: 'Hide permissions: not while a review is open or a change waits; clears an error',
    async run({ permissions, change, sender }) {
      permissions.expand();
      assert.equal(permissions.state().canHide, true);
      permissions.review('read', true, access());
      assert.equal(permissions.state().canHide, false);
      change('read', true);
      assert.equal(permissions.state().canHide, false);
      sender.sent[0].reject(Error('Show this conversation on this device first'));
      await settled();
      assert.equal(permissions.state().canHide, true);
      permissions.collapse();
      assert.equal(permissions.state().open, false);
      assert.equal(permissions.state().feedback, '');
    },
  },
  {
    case: 'an older listener without send: sending cannot be reviewed',
    async run({ permissions, show }) {
      show(frameApplication(access({ send: null })));
      assert.equal(permissions.review('send', true, access({ send: null })), false);
    },
  },
  {
    case: 'the application asks for neither: nothing can change',
    async run({ permissions, show }) {
      show(frameApplication(access({ requested: [] })));
      assert.equal(permissions.canChange(true, access({ requested: [] })), false);
    },
  },
];

test('permission rule: one table of cases', async () => {
  for (const row of permissionCases) {
    const permissions = new ChatPermissions();
    const sender = recordingSender();
    let shown: { sessionId: string; application: ShownApplication | null } = {
      sessionId: 's1',
      application: frameApplication(access()),
    };
    const show = (application: ShownApplication | null, sessionId = 's1') => {
      shown = { sessionId, application };
      permissions.observe(sessionId, permissionIdentity(sessionId, application));
    };
    show(shown.application);
    const change = (kind: 'read' | 'send', allowed: boolean, admitted = true) =>
      permissions.change(kind, allowed, {
        sessionId: shown.sessionId,
        application: shown.application,
        admitted,
        send: sender.send,
      });
    try {
      await row.run({ permissions, show, change, sender });
    } catch (error) {
      (error as Error).message = `${row.case}: ${(error as Error).message}`;
      throw error;
    }
  }
});
