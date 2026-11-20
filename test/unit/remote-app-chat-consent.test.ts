/**
 * Who may set a session application's chat permission: one table of cases
 * derived from the rules in src/desktop/README.md ("Application chat access
 * from a paired device"), not from the code.
 *
 * Every case runs for both permissions (read, send) and both directions
 * (allow, stop), through the real gateway, a real control socket and the
 * real application service (test/app-consent-fixture.ts). A case whose
 * connection changes while the request waits holds the application's queue,
 * so the request is admitted first and runs after the change.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  consentFixture,
  type ConsentFixture,
  type Permission,
  type Reply,
} from '../app-consent-fixture.ts';
import { delay, waitFor } from '../remote-fixture.ts';

// ---- Expected answers ------------------------------------------------------

/** The change was made. */
const changed = 'changed';
/** The desktop's refusal, unchanged. */
const noLongerSelected = /^Error: This conversation is no longer selected on the desktop$/;
/** A remote connection's refusals (rule 5). */
const openFirst = /^Error: Open this conversation on this device first$/;
const showFirst = /^Error: Show this conversation on this device first$/;
/** The application service's refusal for a stale identity (rule 6). */
const permissionsChanged =
  /Application or permissions changed; review the current permission controls\.$/;

type Outcome = typeof changed | RegExp;

/** The state of the requesting connection when the request arrives. */
type Arrival =
  | 'desktop shows it'
  | 'desktop shows another'
  | 'selected, visible'
  | 'selected, hidden'
  | 'another selected'
  | 'nothing selected'
  | 'never reported'
  | 'visibility withdrawn';

/** What changes while the admitted request waits in the application's queue. */
type Meanwhile =
  | 'nothing'
  | 'desktop selects another'
  | 'becomes hidden'
  | 'selects another'
  | 'client leaves'
  | 'becomes visible';

interface WhoCase {
  arrival: Arrival;
  meanwhile: Meanwhile;
  allow: Outcome;
  stop: Outcome;
}

/** The table "Who may set a permission", row by row. */
const whoCases: WhoCase[] = [
  // Desktop connection: exactly the previous rule (rule 1).
  { arrival: 'desktop shows it', meanwhile: 'nothing', allow: changed, stop: changed },
  {
    arrival: 'desktop shows another',
    meanwhile: 'nothing',
    allow: noLongerSelected,
    stop: noLongerSelected,
  },
  {
    arrival: 'desktop shows it',
    meanwhile: 'desktop selects another',
    allow: noLongerSelected,
    stop: noLongerSelected,
  },
  // Remote connection: allowing needs selected and visible, stopping only
  // selected (rules 2–5).
  { arrival: 'selected, visible', meanwhile: 'nothing', allow: changed, stop: changed },
  { arrival: 'selected, hidden', meanwhile: 'nothing', allow: showFirst, stop: changed },
  { arrival: 'another selected', meanwhile: 'nothing', allow: openFirst, stop: openFirst },
  { arrival: 'nothing selected', meanwhile: 'nothing', allow: openFirst, stop: openFirst },
  { arrival: 'never reported', meanwhile: 'nothing', allow: openFirst, stop: openFirst },
  { arrival: 'visibility withdrawn', meanwhile: 'nothing', allow: showFirst, stop: changed },
  { arrival: 'selected, visible', meanwhile: 'becomes hidden', allow: showFirst, stop: changed },
  {
    arrival: 'selected, visible',
    meanwhile: 'selects another',
    allow: openFirst,
    stop: openFirst,
  },
  { arrival: 'selected, visible', meanwhile: 'client leaves', allow: showFirst, stop: changed },
  // Refused when it arrives (not visible then), whatever happens later.
  { arrival: 'selected, hidden', meanwhile: 'becomes visible', allow: showFirst, stop: changed },
];

const remoteArrivals: ReadonlySet<Arrival> = new Set([
  'selected, visible',
  'selected, hidden',
  'another selected',
  'nothing selected',
  'never reported',
]);

// ---- Running one case -------------------------------------------------------

/**
 * Run one row for one permission and direction: arrange the opposite state
 * through the desktop, put the requesting connection in the arrival state,
 * send the change (holding the queue when something changes meanwhile), and
 * compare the answer and the listener's state with the expected outcome.
 */
async function runWhoCase(
  f: ConsentFixture,
  row: WhoCase,
  permission: Permission,
  allowed: boolean,
): Promise<void> {
  const label = `${row.arrival} / ${row.meanwhile} / ${allowed ? 'allow' : 'stop'} ${permission}`;
  const expected = allowed ? row.allow : row.stop;
  const { applicationConversation, otherConversation } = f;

  await f.arrange(permission, !allowed);
  const revisionBefore = f.listenerApplication().chatAccess!.revision;

  // The requesting connection in its arrival state.
  const isDesktop = row.arrival === 'desktop shows it' || row.arrival === 'desktop shows another';
  if (row.arrival === 'desktop shows another') {
    await f.desktopShows(otherConversation);
  }
  const phone = remoteArrivals.has(row.arrival) ? await f.openPhone() : undefined;
  if (phone && row.arrival === 'selected, visible') {
    await f.phoneReports(phone, applicationConversation, true);
  }
  if (phone && row.arrival === 'selected, hidden') {
    await f.phoneReports(phone, applicationConversation, false);
  }
  if (phone && row.arrival === 'another selected') {
    await f.phoneReports(phone, otherConversation, true);
  }
  if (phone && row.arrival === 'nothing selected') {
    await f.phoneReports(phone, '', true);
  }
  const control =
    row.arrival === 'visibility withdrawn' ? await f.remoteControlConnection() : undefined;
  if (control) {
    assert.equal((await control.request({ action: 'client-role', role: 'remote' })).type, 'result');
    const report = { action: 'panel-state', id: applicationConversation, visible: true };
    assert.equal((await control.request(report)).type, 'result');
    assert.equal((await control.request({ action: 'withdraw-visibility' })).type, 'result');
  }

  // Send the change; when something changes meanwhile, it waits in the queue.
  const release = row.meanwhile === 'nothing' ? undefined : await f.holdApplicationQueue();
  const request = f.change(permission, allowed);
  let awaitReply: () => Promise<Reply>;
  let phoneRequestId = '';
  if (isDesktop) {
    awaitReply = f.desktopSend(request).reply;
  } else if (phone) {
    const sent = f.phoneSend(phone, request);
    phoneRequestId = sent.requestId;
    awaitReply = sent.reply;
  } else {
    const pending = control!.request(request);
    awaitReply = () => pending;
  }

  // The change while it waits. Each comes after the request on the same
  // connection, so the listener has admitted the request before it.
  if (row.meanwhile === 'desktop selects another') {
    await f.desktopShows(otherConversation);
  }
  if (row.meanwhile === 'becomes hidden') {
    await f.phoneReports(phone!, applicationConversation, false);
  }
  if (row.meanwhile === 'selects another') {
    await f.phoneReports(phone!, otherConversation, true);
  }
  if (row.meanwhile === 'becomes visible') {
    await f.phoneReports(phone!, applicationConversation, true);
  }
  if (row.meanwhile === 'client leaves') {
    // The gateway withdraws the departed client's visibility while its
    // request still drains; its outcome is kept in the device's receipt.
    await f.closePhone(phone!);
    await waitFor(() => !f.remoteVisibleSelections().includes(applicationConversation), 3000);
  }
  await release?.();

  let answer: Reply;
  if (row.meanwhile === 'client leaves') {
    // Ask again with the same request ID from a new connection: the receipt
    // answers with the real outcome instead of running it a second time.
    const again = await f.openPhone();
    answer = await f.phoneSend(again, request, phoneRequestId).reply();
    assert.equal(answer.duplicate, true, label);
    await f.closePhone(again);
  } else {
    answer = await awaitReply();
  }

  // Compare the answer and the listener's state.
  if (expected === changed) {
    assert.equal(answer.type, 'result', `${label}: ${answer.message}`);
    assert.equal(f.allowedNow(permission), allowed, label);
  } else {
    assert.equal(answer.type, 'error', label);
    assert.match(answer.message!, expected, label);
    assert.equal(f.allowedNow(permission), !allowed, label);
    assert.equal(f.listenerApplication().chatAccess!.revision, revisionBefore, label);
  }

  // Leave the connections as the next case expects them.
  if (phone && row.meanwhile !== 'client leaves') {
    await f.closePhone(phone);
  }
  control?.close();
  await f.desktopShows(applicationConversation);
}

// ---- The tables ---------------------------------------------------------------

test('who may set a permission: the table, for read and send, allow and stop', async (context) => {
  const f = await consentFixture();
  context.after(() => f.close());

  for (const row of whoCases) {
    for (const permission of ['read', 'send'] as const) {
      for (const allowed of [true, false]) {
        await runWhoCase(f, row, permission, allowed);
      }
    }
  }
});

test('who may set a permission: a stale application ID, code version or revision is refused for an admitted connection', async (context) => {
  const f = await consentFixture();
  context.after(() => f.close());

  // Replace the code once so that version 1 is an old version.
  await f.fixture.applyNotes(f.applicationRun, 1, 'chat-notes');
  await waitFor(() => f.listenerApplication().version === 2);

  type Flaw = 'wrong application ID' | 'old code version' | 'old permission revision';
  const flaws: Flaw[] = ['wrong application ID', 'old code version', 'old permission revision'];

  for (const connection of ['desktop', 'remote'] as const) {
    for (const flaw of flaws) {
      for (const permission of ['read', 'send'] as const) {
        for (const allowed of [true, false]) {
          const label = `${connection} / ${flaw} / ${allowed ? 'allow' : 'stop'} ${permission}`;
          await f.arrange(permission, !allowed);

          // An old revision: one that was current before the last change.
          let staleRevision = '';
          if (flaw === 'old permission revision') {
            staleRevision = f.listenerApplication().chatAccess!.revision;
            await f.arrange(permission, allowed);
            await f.arrange(permission, !allowed);
          }
          const revisionBefore = f.listenerApplication().chatAccess!.revision;

          const overrides: Record<string, unknown> = {};
          if (flaw === 'wrong application ID') {
            overrides.applicationId = randomUUID();
          }
          if (flaw === 'old code version') {
            overrides.version = 1;
          }
          if (flaw === 'old permission revision') {
            overrides.revision = staleRevision;
          }
          const request = f.change(permission, allowed, overrides);

          let answer: Reply;
          if (connection === 'desktop') {
            answer = await f.desktopSend(request).reply();
          } else {
            const phone = await f.openPhone();
            await f.phoneReports(phone, f.applicationConversation, true);
            answer = await f.phoneSend(phone, request).reply();
            await f.closePhone(phone);
          }

          assert.equal(answer.type, 'error', label);
          assert.match(answer.message!, permissionsChanged, label);
          assert.equal(f.allowedNow(permission), !allowed, label);
          assert.equal(f.listenerApplication().chatAccess!.revision, revisionBefore, label);
        }
      }
    }
  }
});

test('who may set a permission: preview mode checks the connection, then changes nothing', async (context) => {
  const f = await consentFixture({ preview: true });
  context.after(() => f.close());

  // Preview refuses every change, so nothing is ever allowed here.
  const cases: { arrival: Arrival; allow: Outcome | 'preview'; stop: Outcome | 'preview' }[] = [
    { arrival: 'desktop shows it', allow: 'preview', stop: 'preview' },
    { arrival: 'desktop shows another', allow: noLongerSelected, stop: noLongerSelected },
    { arrival: 'selected, visible', allow: 'preview', stop: 'preview' },
    { arrival: 'selected, hidden', allow: showFirst, stop: 'preview' },
    { arrival: 'another selected', allow: openFirst, stop: openFirst },
  ];

  for (const row of cases) {
    for (const permission of ['read', 'send'] as const) {
      for (const allowed of [true, false]) {
        const label = `preview / ${row.arrival} / ${allowed ? 'allow' : 'stop'} ${permission}`;
        const expected = allowed ? row.allow : row.stop;
        await f.desktopShows(f.applicationConversation);
        const before = structuredClone(f.listenerApplication().chatAccess);
        const request = f.change(permission, allowed);

        let answer: Reply;
        if (row.arrival === 'desktop shows it' || row.arrival === 'desktop shows another') {
          if (row.arrival === 'desktop shows another') {
            await f.desktopShows(f.otherConversation);
          }
          answer = await f.desktopSend(request).reply();
        } else {
          const phone = await f.openPhone();
          if (row.arrival === 'another selected') {
            await f.phoneReports(phone, f.otherConversation, true);
          } else {
            await f.phoneReports(
              phone,
              f.applicationConversation,
              row.arrival === 'selected, visible',
            );
          }
          answer = await f.phoneSend(phone, request).reply();
          await f.closePhone(phone);
        }

        if (expected === 'preview') {
          assert.equal(answer.type, 'result', `${label}: ${answer.message}`);
          assert.equal(answer.result, 'preview', label);
        } else {
          assert.equal(answer.type, 'error', label);
          assert.match(answer.message!, expected as RegExp, label);
        }
        assert.deepEqual(f.listenerApplication().chatAccess, before, label);
      }
    }
  }
});

test('desktop connection: these two actions behave exactly as before', async (context) => {
  // Also passes unchanged on the revision before remote consent (only the
  // fixture is newer), so the desktop's behaviour is the same.
  const f = await consentFixture();
  context.after(() => f.close());

  for (const permission of ['read', 'send'] as const) {
    // Not shown: refused, nothing changes.
    await f.desktopShows(f.otherConversation);
    const refused = await f.desktopSend(f.change(permission, true)).reply();
    assert.equal(refused.type, 'error');
    assert.equal(refused.message, 'Error: This conversation is no longer selected on the desktop');
    assert.equal(f.allowedNow(permission), false);

    // Shown: the result is the listener's full permission state, including
    // the send grant's ID (only remote clients lose it).
    await f.desktopShows(f.applicationConversation);
    const allowed = await f.desktopSend(f.change(permission, true)).reply();
    assert.equal(allowed.type, 'result');
    assert.deepEqual(allowed.result, f.listenerApplication().chatAccess);
    assert.match(String(allowed.result?.send?.grantId), /^[0-9a-f-]{36}$/);
    assert.equal(f.allowedNow(permission), true);

    const stopped = await f.desktopSend(f.change(permission, false)).reply();
    assert.equal(stopped.type, 'result');
    assert.deepEqual(stopped.result, f.listenerApplication().chatAccess);
    assert.equal(f.allowedNow(permission), false);

    // Selection moves while the change waits: refused when it runs.
    const release = await f.holdApplicationQueue();
    const waiting = f.desktopSend(f.change(permission, true));
    await f.desktopShows(f.otherConversation);
    await release();
    const late = await waiting.reply();
    assert.equal(late.type, 'error');
    assert.equal(late.message, 'Error: This conversation is no longer selected on the desktop');
    assert.equal(f.allowedNow(permission), false);
  }
});

test('a report the gateway refuses still ends the page counting as visible', async (context) => {
  // The device's request budget runs out just when the page is hidden: the
  // gateway refuses the hide report, so it repeats the last report it
  // forwarded with `visible: false`, and the waiting grant is refused.
  const f = await consentFixture();
  context.after(() => f.close());
  const id = f.applicationConversation;

  for (const permission of ['read', 'send'] as const) {
    await f.arrange(permission, false);
    const phone = await f.openPhone();
    await f.phoneReports(phone, id, true);

    const release = await f.holdApplicationQueue();
    const waiting = f.phoneSend(phone, f.change(permission, true));

    // Spend the rest of the device's budget (pings share it), then hide.
    for (let ping = 0; ping < 60; ping++) {
      phone.socket.send(JSON.stringify({ type: 'ping' }));
    }
    const hide = await f.phoneSend(phone, { action: 'panel-state', id, visible: false }).reply();
    assert.equal(hide.type, 'error');
    assert.match(hide.message!, /Too many requests/);

    await waitFor(() => !f.remoteVisibleSelections().includes(id), 3000);
    await release();
    const answer = await waiting.reply();
    assert.equal(answer.type, 'error', permission);
    assert.match(answer.message!, showFirst, permission);
    assert.equal(f.allowedNow(permission), false, permission);

    // The selection stays: stopping still works once the budget refills.
    await delay(1000);
    await f.phoneReports(phone, id, true);
    const allowed = await f.phoneSend(phone, f.change(permission, true)).reply();
    assert.equal(allowed.type, 'result', allowed.message ?? '');
    await f.phoneReports(phone, id, false);
    const stopped = await f.phoneSend(phone, f.change(permission, false)).reply();
    assert.equal(stopped.type, 'result', stopped.message ?? '');
    assert.equal(f.allowedNow(permission), false, permission);
    await f.closePhone(phone);
  }
});
