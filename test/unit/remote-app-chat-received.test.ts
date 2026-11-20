/**
 * What a remote client receives about a session application's chat
 * permissions: the table in src/remote/README.md ("Application chat access"),
 * derived from the rules, not from the code.
 *
 * One conversation with the synthetic `chat-notes` application goes through
 * the table's states in order, through the real gateway, listener and
 * application service (test/app-consent-fixture.ts). After every step the
 * phone's latest `application.chatAccess` must equal the listener's state
 * rebuilt without the send grant's ID, and nothing the phone ever received
 * may contain a grant ID or a view address.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { consentFixture, type ConsentFixture } from '../app-consent-fixture.ts';
import { waitFor, type PhoneClient } from '../remote-fixture.ts';

type Json = Record<string, any>;

/** The conversation's latest `application` as this phone received it. */
function phoneApplication(phone: PhoneClient, id: string): Json | undefined {
  for (let index = phone.messages.length - 1; index >= 0; index--) {
    const envelope = phone.messages[index] as Json;
    if (envelope.type !== 'engine') {
      continue;
    }
    const message = envelope.message;
    let session: Json | undefined;
    if (message.type === 'state' && Array.isArray(message.sessions)) {
      session = message.sessions.find((each: Json) => each.id === id);
    }
    if (
      (message.type === 'agent-session' || message.type === 'agent-restored') &&
      message.session.id === id
    ) {
      session = message.session;
    }
    if (session) {
      return session.application;
    }
  }
  return undefined;
}

/** The listener's permission state as a remote client must receive it. */
function expectedRemote(f: ConsentFixture): Json {
  const access = f.listenerApplication().chatAccess!;
  return {
    requested: access.requested,
    read: access.read,
    send: {
      allowed: access.send!.allowed,
      remaining: access.send!.remaining,
      busy: access.send!.busy,
    },
    revision: access.revision,
  };
}

/**
 * Wait until the listener has reached the row's values and the phone's
 * latest state equals the listener's, then check the row's values on the
 * phone and that no grant ID or view address ever reached it.
 */
async function phoneShows(
  f: ConsentFixture,
  phone: PhoneClient,
  row: string,
  values: { read: boolean; allowed: boolean; remaining: number; busy: boolean },
): Promise<Json> {
  const id = f.applicationConversation;
  const listenerReached = () => {
    const expected = expectedRemote(f);
    return (
      expected.read === values.read &&
      isDeepStrictEqual(expected.send, {
        allowed: values.allowed,
        remaining: values.remaining,
        busy: values.busy,
      })
    );
  };
  try {
    await waitFor(() => {
      const access = phoneApplication(phone, id)?.chatAccess;
      return listenerReached() && isDeepStrictEqual(access, expectedRemote(f));
    }, 3000);
  } catch {
    // Fall through: the assertions below say what differs.
  }

  const application = phoneApplication(phone, id)!;
  const access = application.chatAccess;
  assert.deepEqual(access, expectedRemote(f), row);
  assert.deepEqual(access.requested, ['chat.read', 'chat.send'], row);
  assert.equal(access.read, values.read, row);
  assert.deepEqual(
    access.send,
    { allowed: values.allowed, remaining: values.remaining, busy: values.busy },
    row,
  );
  assert.match(access.revision, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Any of the above: no grant ID, no view address; a frame address instead.
  const listener = f.listenerApplication();
  const received = JSON.stringify(phone.messages);
  assert.ok(!received.includes('grantId'), row);
  assert.ok(!received.includes(listener.chatAccess!.send!.grantId), row);
  assert.ok(!received.includes(listener.viewUrl!.slice(-64)), row);
  assert.equal(application.viewUrl, undefined, row);
  assert.ok(String(application.frameUrl).startsWith(f.fixture.frameOrigin + '/f/'), row);
  return access;
}

/** Ask the application to send one chat message, as its view would. */
async function applicationSends(f: ConsentFixture, text: string): Promise<void> {
  const listener = f.listenerApplication();
  const response = await fetch(listener.viewUrl + '/chat-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: listener.version,
      grantId: listener.chatAccess!.send!.grantId,
      requestId: 'send' + randomUUID().replaceAll('-', ''),
      text,
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

test('what a remote client receives: the table, step by step', async (context) => {
  // Sends are two seconds apart at least, measured on the monotonic clock;
  // the test moves that clock instead of waiting.
  const realNow = performance.now.bind(performance);
  let skipped = 0;
  context.mock.method(performance, 'now', () => realNow() + skipped);

  const f = await consentFixture();
  context.after(() => f.close());
  const id = f.applicationConversation;

  const phone = await f.openPhone();
  await f.phoneReports(phone, id, true);
  await f.desktopShows(id);

  // No grant.
  const initial = await phoneShows(f, phone, 'no grant', {
    read: false,
    allowed: false,
    remaining: 0,
    busy: false,
  });

  // Reading allowed only (by this phone); the result is the same state.
  const allowRead = await f.phoneSend(phone, f.change('read', true)).reply();
  assert.equal(allowRead.type, 'result', allowRead.message ?? '');
  assert.deepEqual(allowRead.result, expectedRemote(f));
  await phoneShows(f, phone, 'reading allowed only', {
    read: true,
    allowed: false,
    remaining: 0,
    busy: false,
  });

  // Every connection sees the same grant: a second connection of the device.
  const second = await f.openPhone();
  await phoneShows(f, second, 'second connection', {
    read: true,
    allowed: false,
    remaining: 0,
    busy: false,
  });
  await f.closePhone(second);

  // Stopped by the other side: the desktop stops the phone's grant.
  const readGrant = f.listenerApplication().chatAccess!.revision;
  const desktopStops = await f.desktopSend(f.change('read', false)).reply();
  assert.equal(desktopStops.type, 'result', desktopStops.message ?? '');
  const afterDesktopStop = await phoneShows(f, phone, 'stopped by the desktop', {
    read: false,
    allowed: false,
    remaining: 0,
    busy: false,
  });
  assert.notEqual(afterDesktopStop.revision, readGrant);

  // ... and the phone stops the desktop's grant.
  const desktopAllows = await f.desktopSend(f.change('read', true)).reply();
  assert.equal(desktopAllows.type, 'result', desktopAllows.message ?? '');
  await phoneShows(f, phone, 'allowed by the desktop', {
    read: true,
    allowed: false,
    remaining: 0,
    busy: false,
  });
  const phoneStops = await f.phoneSend(phone, f.change('read', false)).reply();
  assert.equal(phoneStops.type, 'result', phoneStops.message ?? '');
  assert.equal(f.allowedNow('read'), false);
  await phoneShows(f, phone, 'stopped by the phone', {
    read: false,
    allowed: false,
    remaining: 0,
    busy: false,
  });

  // Application code replaced: everything denied again, new revision.
  for (const permission of ['read', 'send'] as const) {
    const reply = await f.phoneSend(phone, f.change(permission, true)).reply();
    assert.equal(reply.type, 'result', reply.message ?? '');
  }
  await phoneShows(f, phone, 'both allowed', {
    read: true,
    allowed: true,
    remaining: 5,
    busy: false,
  });
  const beforeReplacement = f.listenerApplication().chatAccess!.revision;
  await f.fixture.applyNotes(f.applicationRun, 1, 'chat-notes');
  const replaced = await phoneShows(f, phone, 'code replaced', {
    read: false,
    allowed: false,
    remaining: 0,
    busy: false,
  });
  assert.notEqual(replaced.revision, beforeReplacement);
  assert.equal(phoneApplication(phone, id)!.version, 2);

  // Let the first turn end so that application messages can run.
  f.applicationRun.finish();
  await waitFor(
    () => f.fixture.sessions.snapshot().find((each) => each.id === id)!.status === 'completed',
  );

  // Sending allowed, messages left; busy while one waits or runs.
  const allowSend = await f.phoneSend(phone, f.change('send', true)).reply();
  assert.equal(allowSend.type, 'result', allowSend.message ?? '');
  await phoneShows(f, phone, 'sending allowed', {
    read: false,
    allowed: true,
    remaining: 5,
    busy: false,
  });

  for (let sent = 1; sent <= 5; sent++) {
    const runsBefore = f.fixture.runs.length;
    await applicationSends(f, `Synthetic application message ${sent}`);
    await waitFor(() => f.fixture.runs.length === runsBefore + 1, 3000);
    await phoneShows(f, phone, `message ${sent} running`, {
      read: false,
      allowed: true,
      remaining: 5 - sent,
      busy: true,
    });

    f.fixture.runs[runsBefore].finish();
    await phoneShows(f, phone, `message ${sent} done`, {
      read: false,
      allowed: true,
      remaining: 5 - sent,
      busy: false,
    });
    skipped += 2100;
  }
  // All sent: still allowed, nothing left (the last loop step checked it).

  // Conversation closed and reopened: denied again, new revision.
  const beforeClose = f.listenerApplication().chatAccess!.revision;
  const closed = await f.phoneSend(phone, { action: 'close-agent', id }).reply();
  assert.equal(closed.type, 'result', closed.message ?? '');
  await phone.engine('agent-removed', (message) => message.id === id);
  const reopened = await f.phoneSend(phone, { action: 'reopen-agent', id }).reply();
  assert.equal(reopened.type, 'result', reopened.message ?? '');
  await waitFor(() =>
    f.fixture.sessions.snapshot().some((each) => each.id === id && each.application?.chatAccess),
  );
  const afterReopen = await phoneShows(f, phone, 'closed and reopened', {
    read: false,
    allowed: false,
    remaining: 0,
    busy: false,
  });
  assert.notEqual(afterReopen.revision, beforeClose);
  assert.notEqual(afterReopen.revision, initial.revision);
});
