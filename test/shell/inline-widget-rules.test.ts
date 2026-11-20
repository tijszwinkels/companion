/**
 * The inline widget rules of integrations/shell/README.md ("Inline
 * widgets") in Node, each with the cases of its README table that do not
 * need a browser: the frame states (frame-state.ts, frame-address.ts and the
 * page rows), the messages (frame-messages.ts, height-throttle.ts) and the
 * visibility rule (frame-visibility.ts). The browser cases of the same
 * tables are in inline-widgets.test.ts and widget-host.test.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentMessage } from '../../src/agents/types.ts';
import { pageRow } from '../../integrations/shell/src/rows.ts';
import {
  frameAddress,
  frameOriginOf,
  policyRefusedFrame,
} from '../../integrations/shell/src/widgets/frame-address.ts';
import {
  clampFrameHeight,
  mixColours,
  readFrameMessage,
  themeFromVariables,
  themeMessage,
  visibleMessage,
  type FrameMessage,
} from '../../integrations/shell/src/widgets/frame-messages.ts';
import {
  deadlineReason,
  initialFrameState,
  nextFrameState,
  type FrameEvent,
  type FrameState,
} from '../../integrations/shell/src/widgets/frame-state.ts';
import { readerScrollThroughFrame } from '../../integrations/shell/src/widgets/frame-scroll.ts';
import { frameVisible } from '../../integrations/shell/src/widgets/frame-visibility.ts';
import { HeightThrottle } from '../../integrations/shell/src/widgets/height-throttle.ts';

const handle = 'A'.repeat(21) + '_-' + 'z09'.repeat(6) + 'Q'.repeat(2);
const address = `https://frames.example.ts.net:8443/f/${handle}/`;

// ---- Frame states ---------------------------------------------------------------

/** The page row of a widget message whose attachment carries `frameUrl`. */
function widgetRow(frameUrl?: unknown, inlineWidgets = true) {
  const message: AgentMessage = {
    ...chatMessage('widget:1', 'assistant', 'Clicks: 0'),
    widget: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'counter',
      revision: 1,
      presentation: { placement: 'inline' },
      ...(frameUrl === undefined ? {} : { frameUrl }),
    } as AgentMessage['widget'],
  };
  return pageRow({ key: 'widget:1', message } as Parameters<typeof pageRow>[0], '', inlineWidgets);
}

function run(events: FrameEvent[], start = initialFrameState()): FrameState {
  let state = start;
  for (const event of events) {
    state = nextFrameState(state, event);
  }
  return state;
}

test('frame address: exactly <frame origin>/f/<43 base64url>/, else not set up', () => {
  assert.equal(handle.length, 43);
  const cases: [unknown, string][] = [
    [address, address],
    [`http://127.0.0.1:8789/f/${handle}/`, `http://127.0.0.1:8789/f/${handle}/`],
    [undefined, ''],
    [null, ''],
    [42, ''],
    ['', ''],
    [`https://frames.example.ts.net:8443/f/${handle}`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/state`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/?token=1`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/#x`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/?`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/#`, ''],
    [`https://frames.example.ts.net:8443/f/${handle}/?#`, ''],
    [`https://user:pass@frames.example.ts.net/f/${handle}/`, ''],
    [`javascript:alert(1)//f/${handle}/`, ''],
    [`data:text/html,/f/${handle}/`, ''],
    [`https://frames.example.ts.net/f/${handle.slice(1)}/`, ''],
    [`https://frames.example.ts.net/f/${handle.slice(1)}%41/`, ''],
    [`HTTPS://FRAMES.example.ts.net/f/${handle}/`, ''],
    [`https://frames.example.ts.net/x/../f/${handle}/`, ''],
  ];
  for (const [value, expected] of cases) {
    assert.equal(frameAddress(value), expected, String(value));
  }
  assert.equal(frameOriginOf(address), 'https://frames.example.ts.net:8443');
});

test('frame states rule, table rows in Node', () => {
  // No frameUrl, or one of another shape: '' (the not set up card).
  assert.deepEqual(widgetRow().widget, { name: 'counter', frameUrl: '' });
  assert.deepEqual(widgetRow(address + 'x').widget, { name: 'counter', frameUrl: '' });
  // A valid one is passed on unchanged.
  assert.deepEqual(widgetRow(address).widget, { name: 'counter', frameUrl: address });
  // A bridge without the inline widget component sends the Qt host's row.
  assert.deepEqual(widgetRow(address, false).widget, { name: 'counter' });

  const loading = initialFrameState();
  // frameUrl, nothing reported yet: loading at the lower bound.
  assert.deepEqual(loading, { phase: 'loading', reason: '', height: 100, attempt: 0 });

  // First geometry 180: shown, 180 px.
  assert.deepEqual(run([{ type: 'geometry', height: 180 }]), {
    phase: 'shown',
    reason: '',
    height: 180,
    attempt: 0,
  });

  // error before any geometry: failed with its text.
  const failed = run([{ type: 'error', text: 'boom' }]);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.reason, 'boom');
  assert.equal(run([{ type: 'error', text: '  ' }]).reason, 'Its page reported an error.');

  // No geometry within the deadline (also an upstream 404): failed.
  const late = run([{ type: 'deadline' }]);
  assert.equal(late.phase, 'failed');
  assert.equal(late.reason, deadlineReason);
  assert.equal(deadlineReason, 'Its page did not answer within 10 seconds.');

  // Try again: a new frame (attempt), loading; shown at its first geometry.
  const again = run([{ type: 'retry' }], failed);
  assert.equal(again.phase, 'loading');
  assert.equal(again.attempt, 1);
  assert.equal(again.reason, '');
  assert.equal(run([{ type: 'geometry', height: 250 }], again).phase, 'shown');
  // Try again only from failed.
  assert.deepEqual(run([{ type: 'retry' }]), loading);

  // error after shown: still shown.
  const shown = run([{ type: 'geometry', height: 180 }]);
  assert.equal(run([{ type: 'error', text: 'later' }], shown), shown);
  // A deadline after shown changes nothing.
  assert.equal(run([{ type: 'deadline' }], shown), shown);
  // Nothing a failed frame sent counts.
  assert.equal(run([{ type: 'geometry', height: 300 }], failed), failed);
  assert.equal(run([{ type: 'error', text: 'again' }], failed), failed);
  // An equal height changes nothing.
  assert.equal(run([{ type: 'geometry', height: 180 }], shown), shown);

  // Conversation switched and back: loading at its remembered height.
  assert.deepEqual(initialFrameState(260), {
    phase: 'loading',
    reason: '',
    height: 260,
    attempt: 0,
  });
});

// ---- Messages ---------------------------------------------------------------------

const frameWindow = { name: 'the panel frame' };
const otherWindow = { name: 'another window' };
const frameOrigin = 'http://127.0.0.1:8789';
const expected = { frameWindow, frameOrigin };

test('messages rule: accepted messages, source, origin and fields', () => {
  const long = 'x'.repeat(1000);
  const cases: [string, { source: unknown; origin: string; data: unknown }, FrameMessage | null][] =
    [
      [
        'geometry 180 from the frame',
        { source: frameWindow, origin: frameOrigin, data: { type: 'geometry', height: 180 } },
        { type: 'geometry', height: 180 },
      ],
      [
        'error from the frame',
        { source: frameWindow, origin: frameOrigin, data: { type: 'error', text: 'boom' } },
        { type: 'error', text: 'boom' },
      ],
      [
        'error of 1,000 characters',
        { source: frameWindow, origin: frameOrigin, data: { type: 'error', text: long } },
        { type: 'error', text: 'x'.repeat(200) },
      ],
      [
        'another window (the shell, the inner frame, another panel)',
        { source: otherWindow, origin: frameOrigin, data: { type: 'geometry', height: 180 } },
        null,
      ],
      [
        'no window',
        { source: null, origin: frameOrigin, data: { type: 'geometry', height: 180 } },
        null,
      ],
      [
        'the frame window with another origin',
        {
          source: frameWindow,
          origin: 'http://127.0.0.1:8788',
          data: { type: 'geometry', height: 180 },
        },
        null,
      ],
      [
        'the frame window with an opaque origin',
        { source: frameWindow, origin: 'null', data: { type: 'geometry', height: 180 } },
        null,
      ],
      [
        'an extra field',
        {
          source: frameWindow,
          origin: frameOrigin,
          data: { type: 'geometry', height: 180, token: 'x' },
        },
        null,
      ],
      [
        'height a string',
        { source: frameWindow, origin: frameOrigin, data: { type: 'geometry', height: '180' } },
        null,
      ],
      [
        'height missing',
        { source: frameWindow, origin: frameOrigin, data: { type: 'geometry' } },
        null,
      ],
      [
        'height NaN',
        { source: frameWindow, origin: frameOrigin, data: { type: 'geometry', height: NaN } },
        null,
      ],
      [
        'height Infinity',
        {
          source: frameWindow,
          origin: frameOrigin,
          data: { type: 'geometry', height: Infinity },
        },
        null,
      ],
      [
        'error text not a string',
        { source: frameWindow, origin: frameOrigin, data: { type: 'error', text: 42 } },
        null,
      ],
      [
        'another type',
        { source: frameWindow, origin: frameOrigin, data: { type: 'navigate', to: '/' } },
        null,
      ],
      ['not an object', { source: frameWindow, origin: frameOrigin, data: 'geometry' }, null],
      ['an array', { source: frameWindow, origin: frameOrigin, data: ['geometry', 180] }, null],
    ];
  for (const [name, message, result] of cases) {
    assert.deepEqual(readFrameMessage(message, expected), result, name);
  }

  // After the frame was removed (no window to compare with): ignored.
  assert.equal(
    readFrameMessage(
      { source: frameWindow, origin: frameOrigin, data: { type: 'geometry', height: 180 } },
      { frameWindow: null, frameOrigin },
    ),
    null,
  );
});

test('messages rule: geometry out of bounds is clamped, not-a-number ignored', () => {
  const cases: [unknown, number | null][] = [
    [-50, 100],
    [0, 100],
    [99.6, 100],
    [100, 100],
    [180.4, 180],
    [420, 420],
    [5000, 420],
    [Number.MAX_VALUE, 420],
    [-Number.MAX_VALUE, 100],
    [NaN, null],
    [Infinity, null],
    [-Infinity, null],
    ['300', null],
    [null, null],
  ];
  for (const [value, result] of cases) {
    assert.equal(clampFrameHeight(value), result, String(value));
  }
});

/** A controlled clock and timers for the throttle. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      now: () => now,
      setTimeout(callback: () => void, milliseconds: number) {
        nextId++;
        timers.set(nextId, { at: now + milliseconds, callback });
        return nextId;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    advance(milliseconds: number) {
      const until = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

test('messages rule: at most one height per 100 ms, the last one wins', () => {
  const clock = fakeTimers();
  const applied: number[] = [];
  const throttle = new HeightThrottle((height) => applied.push(height), clock.timers);

  // 1,000 geometry messages in one burst, the last 250: the first at once,
  // then the last one when the interval ends.
  for (let index = 0; index < 999; index++) {
    throttle.report(100 + (index % 300));
  }
  throttle.report(250);
  assert.deepEqual(applied, [100]);
  clock.advance(99);
  assert.deepEqual(applied, [100]);
  clock.advance(1);
  assert.deepEqual(applied, [100, 250]);

  // A steady stream every 10 ms for one second: at most 11 applied.
  for (let step = 0; step < 100; step++) {
    clock.advance(10);
    throttle.report(101 + step);
  }
  clock.advance(200);
  assert.ok(applied.length <= 2 + 11, String(applied.length));
  assert.equal(applied.at(-1), 200);

  // An equal height is not applied again.
  const count = applied.length;
  clock.advance(500);
  throttle.report(200);
  assert.equal(applied.length, count);

  // Removed while a height waits: nothing is applied afterwards.
  throttle.report(300);
  throttle.report(310);
  assert.equal(applied.at(-1), 300);
  throttle.dispose();
  clock.advance(1000);
  assert.equal(applied.at(-1), 300);
  assert.equal(clock.pending(), 0);
});

test('messages rule: the shell posts only theme and visible, with exactly their fields', () => {
  const theme = themeFromVariables(
    (name) =>
      ({
        '--foreground': ' #a9b1d6 ',
        '--background': '#1a1b26',
        '--accent': 'red',
        '--muted': 'url(https://example.com/x)',
      })[name] ?? '',
  );
  // Unreadable or non-hex colours keep the chat's defaults; the background
  // is the panel's tint over the page background.
  assert.deepEqual(theme, {
    foreground: '#a9b1d6',
    background: mixColours('#a9b1d6', '#1a1b26', 0.04),
    accent: '#7aa2f7',
    muted: '#737b9c',
    scale: 1,
  });
  assert.equal(mixColours('#a9b1d6', '#1a1b26', 0.04), '#20212d');
  assert.deepEqual(Object.keys(themeMessage(theme)), ['type', 'theme']);
  assert.deepEqual(Object.keys(themeMessage({ ...theme, extra: 'x' } as never).theme), [
    'foreground',
    'background',
    'accent',
    'muted',
    'scale',
  ]);
  assert.deepEqual(visibleMessage(false), { type: 'visible', visible: false });
});

// ---- Visibility ---------------------------------------------------------------------

test('visibility rule table', () => {
  const visible = { inView: true, pageHidden: false, covered: false, connected: true };
  const cases: [string, typeof visible, boolean][] = [
    ['in view', visible, true],
    ['scrolled out of view', { ...visible, inView: false }, false],
    ['hidden tab', { ...visible, pageHidden: true }, false],
    ['behind the settings screen', { ...visible, covered: true }, false],
    ['behind the narrow Activity overlay', { ...visible, covered: true }, false],
    ['Activity beside the chat (wide window)', visible, true],
    ['disconnected', { ...visible, connected: false }, false],
    ['scrolled out in a hidden tab', { ...visible, inView: false, pageHidden: true }, false],
  ];
  for (const [name, inputs, result] of cases) {
    assert.equal(frameVisible(inputs), result, name);
  }
  // "A different conversation shown" has no frame at all (inline-widgets.test.ts).
});

test('scrolling through a frame: toward the start with unchanged sizes is the reader', () => {
  const before = { top: 1000, scrollHeight: 3000, clientHeight: 600 };
  const cases: [string, typeof before | null, typeof before, boolean][] = [
    ['toward the start, sizes unchanged', before, { ...before, top: 700 }, true],
    ['toward the end, sizes unchanged', before, { ...before, top: 1200 }, false],
    ['not moved', before, before, false],
    [
      'content shrank (the browser pulled the view back)',
      before,
      { top: 900, scrollHeight: 1500, clientHeight: 600 },
      false,
    ],
    ['content grew', before, { top: 900, scrollHeight: 3200, clientHeight: 600 }, false],
    ['the window was resized', before, { top: 900, scrollHeight: 3000, clientHeight: 500 }, false],
    ['no earlier scroll known', null, { ...before, top: 700 }, false],
  ];
  for (const [name, previous, current, expected] of cases) {
    assert.equal(readerScrollThroughFrame(previous, current), expected, name);
  }
});

test('frame states rule: a refusal by the page policy fails exactly that origin', () => {
  const origin = 'https://widgets.example.ts.net';
  const refusal = {
    disposition: 'enforce',
    effectiveDirective: 'frame-src',
    blockedURI: `${origin}/f/${handle}/`,
  };
  const cases: [string, typeof refusal, boolean][] = [
    ['enforced frame-src refusal of this origin', refusal, true],
    ['the origin alone', { ...refusal, blockedURI: origin }, true],
    [
      'the same host on another port',
      { ...refusal, blockedURI: `${origin}:8443/f/${handle}/` },
      false,
    ],
    ['report-only', { ...refusal, disposition: 'report' }, false],
    ['another directive', { ...refusal, effectiveDirective: 'connect-src' }, false],
    ['not an address', { ...refusal, blockedURI: 'inline' }, false],
  ];
  for (const [name, violation, expected] of cases) {
    assert.equal(policyRefusedFrame(violation, origin), expected, name);
  }
});
