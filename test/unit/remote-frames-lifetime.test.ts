/**
 * Frame handle lifetime: one table of cases derived from the rules in
 * src/remote/README.md ("Rules: handle lifetime"), not from the code.
 *
 * Each case uses a real gateway with a frame origin on loopback, a real
 * listener control socket and widget service socket, and a synthetic widget
 * and application (test/frame-fixture.ts). A short grace period stands in for
 * the 30 seconds where a case waits for it to pass.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FrameHandles, graceMilliseconds } from '../../src/remote/frames/handles.ts';
import { frameFixture } from '../frame-fixture.ts';
import { delay, type PhoneClient } from '../remote-fixture.ts';

type Fixture = Awaited<ReturnType<typeof frameFixture>>;
type Json = Record<string, any>;

const shortGrace = 300;
const handleShape = /^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]{43}\/$/;

/** The widget and application frame addresses of one conversation in a snapshot. */
async function framesFrom(phone: PhoneClient, conversationId: string, widgetId: string) {
  const snapshot = await phone.engine('state', (message) =>
    message.sessions?.some(
      (session: Json) =>
        session.id === conversationId &&
        session.messages.some((row: Json) => row.widget?.id === widgetId) &&
        session.application,
    ),
  );
  const session = snapshot.sessions.find((entry: Json) => entry.id === conversationId);
  return {
    session,
    widget: session.messages.find((row: Json) => row.widget?.id === widgetId).widget
      .frameUrl as string,
    application: session.application.frameUrl as string,
  };
}

/** A conversation with one counter widget and the notes application. */
async function setUp(fixture: Fixture) {
  const { id, run } = await fixture.conversation();
  const widgetId = await fixture.publishCounter(run);
  await fixture.applyNotes(run);
  return { id, run, widgetId };
}

async function status(fixture: Fixture, url: string): Promise<number> {
  const response = await fixture.frameRequest(url + 'state');
  await response.arrayBuffer();
  return response.status;
}

async function waitForStatus(fixture: Fixture, url: string, expected: number): Promise<void> {
  const until = Date.now() + 3000;
  while ((await status(fixture, url)) !== expected) {
    assert.ok(Date.now() < until, `frame never answered ${expected}`);
    await delay(20);
  }
}

interface LifetimeCase {
  rule: string;
  name: string;
  grace?: number;
  run(fixture: Fixture): Promise<void>;
}

const cases: LifetimeCase[] = [
  {
    rule: '1',
    name: 'issued: a random 256-bit handle per view, never the listener address',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);

      assert.match(frames.widget, handleShape);
      assert.match(frames.application, handleShape);
      assert.notEqual(frames.widget, frames.application);
      assert.ok(frames.widget.startsWith(fixture.frameOrigin));
      const everything = JSON.stringify(phone.messages);
      assert.ok(!everything.includes('/view/'));
      assert.ok(!everything.includes('viewUrl'));
      assert.ok(!everything.includes('chatAccess'));

      const document = await fixture.frameRequest(frames.widget);
      assert.equal(document.status, 200);
      const html = await document.text();
      const capabilities = [...fixture.sessions.snapshot()[0].messages]
        .map((row) => row.widget?.viewUrl)
        .filter(Boolean) as string[];
      for (const viewUrl of capabilities) {
        assert.ok(!html.includes(viewUrl.slice(-64)), 'document names the capability');
      }
      assert.ok(!html.includes('127.0.0.1:'));
    },
  },
  {
    rule: '2',
    name: 'reused across snapshots and incremental events',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token, fixture.origin, true);
      const first = await framesFrom(phone, id, widgetId);

      const action = await fixture.frameRequest(first.widget + 'action', {
        body: { action: 'increment', args: {}, requestId: 'lifetime-reuse', revision: 1 },
      });
      assert.equal(action.status, 200);
      await action.arrayBuffer();
      const event = await phone.engine('agent-session', (message) =>
        message.session.messages.some((row: Json) => row.widget?.revision === 2),
      );
      const row = event.session.messages.find((entry: Json) => entry.widget?.id === widgetId);
      assert.equal(row.widget.frameUrl, first.widget);
      assert.equal(event.session.application.frameUrl, first.application);
    },
  },
  {
    rule: '2',
    name: 'a second connection of the same device gets the same handles',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const first = await framesFrom(await fixture.phone(token), id, widgetId);
      const second = await framesFrom(await fixture.phone(token), id, widgetId);
      assert.equal(second.widget, first.widget);
      assert.equal(second.application, first.application);
    },
  },
  {
    rule: '3',
    name: 'another device gets different handles and outlives the first device',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const one = await fixture.pair('Phone one');
      const two = await fixture.pair('Phone two');
      const first = await framesFrom(await fixture.phone(one.token), id, widgetId);
      const second = await framesFrom(await fixture.phone(two.token), id, widgetId);
      assert.notEqual(second.widget, first.widget);
      assert.notEqual(second.application, first.application);

      await fixture.devices.revoke(one.deviceId);
      await waitForStatus(fixture, first.widget, 404);
      assert.equal(await status(fixture, first.application), 404);
      assert.equal(await status(fixture, second.widget), 200);
      assert.equal(await status(fixture, second.application), 200);
    },
  },
  {
    rule: '4',
    name: 'last connection closed and back within the grace period: same handles',
    grace: shortGrace,
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const before = await framesFrom(phone, id, widgetId);
      phone.socket.close();
      await phone.closed;

      // Frames keep working while the tab reconnects.
      assert.equal(await status(fixture, before.widget), 200);
      const after = await framesFrom(await fixture.phone(token), id, widgetId);
      assert.equal(after.widget, before.widget);
      assert.equal(after.application, before.application);

      // A new connection cancelled the timer: past the grace period they live on.
      await delay(shortGrace * 2);
      assert.equal(await status(fixture, before.widget), 200);
    },
  },
  {
    rule: '4',
    name: 'back after the grace period: old handles end, new ones are issued',
    grace: shortGrace,
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const before = await framesFrom(phone, id, widgetId);
      phone.socket.close();
      await phone.closed;

      await delay(shortGrace + 200);
      assert.equal(await status(fixture, before.widget), 404);
      assert.equal(await status(fixture, before.application), 404);
      const after = await framesFrom(await fixture.phone(token), id, widgetId);
      assert.notEqual(after.widget, before.widget);
      assert.equal(await status(fixture, after.widget), 200);
    },
  },
  {
    rule: '4',
    name: 'the default grace period is 30 seconds',
    async run() {
      assert.equal(graceMilliseconds, 30_000);
    },
  },
  {
    rule: '5',
    name: 'device revoked while connected: handles end with the recheck',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token, deviceId } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);
      await fixture.devices.revoke(deviceId);
      assert.equal((await phone.closed).code, 4403);
      await waitForStatus(fixture, frames.widget, 404);
      assert.equal(await status(fixture, frames.application), 404);
    },
  },
  {
    rule: '5',
    name: 'device revoked during the grace period: handles end with the recheck',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token, deviceId } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);
      phone.socket.close();
      await phone.closed;
      assert.equal(await status(fixture, frames.widget), 200);

      await fixture.devices.revoke(deviceId);
      await waitForStatus(fixture, frames.widget, 404);
      assert.equal(await status(fixture, frames.application), 404);
    },
  },
  {
    rule: '5',
    name: 'conversation closed: handles end at once, for connected and absent devices',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const connected = await fixture.pair('Connected');
      const absent = await fixture.pair('In grace period');
      const phone = await fixture.phone(connected.token);
      const frames = await framesFrom(phone, id, widgetId);
      const leaving = await fixture.phone(absent.token);
      const absentFrames = await framesFrom(leaving, id, widgetId);
      leaving.socket.close();
      await leaving.closed;

      await fixture.sessions.remove(id);
      await phone.engine('agent-removed', (message) => message.id === id);
      assert.equal(await status(fixture, frames.widget), 404);
      assert.equal(await status(fixture, frames.application), 404);
      // agent-removed ends the conversation's handles for every device,
      // including one that has no connection right now.
      assert.equal(await status(fixture, absentFrames.widget), 404);
      assert.equal(await status(fixture, absentFrames.application), 404);
      assert.equal(fixture.gateway.frames!.handles.size, 0);
    },
  },
  {
    rule: '5',
    name: 'conversation closed while no connection saw it: the upstream 404 ends the handles',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);
      phone.socket.close();
      await phone.closed;
      const handles = fixture.gateway.frames!.handles;
      assert.equal(handles.size, 2);

      await fixture.sessions.remove(id);
      assert.equal(handles.size, 2, 'no relay saw agent-removed');
      assert.equal(await status(fixture, frames.widget), 404);
      assert.equal(handles.size, 1);
      assert.equal(await status(fixture, frames.application), 404);
      assert.equal(handles.size, 0);
    },
  },
  {
    rule: '5',
    name: 'application removed: the widget service 404 ends its handle for every device',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const one = await fixture.pair('One');
      const two = await fixture.pair('Two');
      const first = await framesFrom(await fixture.phone(one.token), id, widgetId);
      const second = await framesFrom(await fixture.phone(two.token), id, widgetId);

      // The listener has no "remove application" operation yet; simulate its
      // outcome on the widget service: the conversation has no application.
      const applications = (fixture.sessions as any).widgets.applications;
      applications.entries.get(id).record = undefined;

      assert.equal(await status(fixture, first.application), 404);
      assert.equal(await status(fixture, second.application), 404);
      // The widget of the same conversation is not affected.
      assert.equal(await status(fixture, first.widget), 200);
    },
  },
  {
    rule: '5',
    name: 'ordered facts only: a late snapshot or removal from another relay ends nothing new',
    async run() {
      const conversation = '00000000-0000-4000-8000-000000000001';
      const view = (hex: string) => `http://127.0.0.1:1234/view/${hex.repeat(64)}`;
      const handleOf = (url: string) => url.split('/')[4];
      const handles = new FrameHandles('https://frames.example');
      const current = handles.connect('device-one');
      const lagging = handles.connect('device-two');
      const sameDeviceLagging = handles.connect('device-one');

      // An application appears; one relay is already past it.
      const application = current.application(conversation, view('a'))!;
      // Relays still processing an older snapshot (no application) or an
      // older close of the conversation's previous instance end nothing.
      lagging.conversationRemoved(conversation);
      sameDeviceLagging.conversationRemoved(conversation);
      assert.ok(handles.lookup(handleOf(application)));

      // A relay that saw the view and then the removal ends it everywhere.
      const other = lagging.application(conversation, view('a'))!;
      assert.notEqual(other, application);
      lagging.conversationRemoved(conversation);
      assert.equal(handles.lookup(handleOf(application)), undefined);
      assert.equal(handles.lookup(handleOf(other)), undefined);

      // The reopened conversation's new views are unaffected by a late removal.
      const reopened = current.widget(conversation, view('b'))!;
      sameDeviceLagging.conversationRemoved(conversation);
      assert.ok(handles.lookup(handleOf(reopened)));
    },
  },
  {
    rule: '6',
    name: 'application replaced by a new code version: same handle, new version served',
    async run(fixture) {
      const { id, run, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const before = await framesFrom(phone, id, widgetId);
      await fixture.applyNotes(run, 1);
      const event = await phone.engine(
        'agent-session',
        (message) => message.session.id === id && message.session.application?.version === 2,
      );
      assert.equal(event.session.application.frameUrl, before.application);
      const state = await fixture.frameRequest(before.application + 'state');
      assert.equal(((await state.json()) as Json).version, 2);
    },
  },
  {
    rule: '5',
    name: 'gateway restart: handles were memory only and are gone',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const frames = await framesFrom(await fixture.phone(token), id, widgetId);
      const handle = frames.widget.split('/')[4];

      await fixture.gateway.close();
      await fixture.gateway.start();
      assert.equal(await status(fixture, frames.widget), 404);
      assert.equal(await status(fixture, frames.application), 404);

      // The restarted gateway issues new handles, and they work.
      const fresh = await framesFrom(await fixture.phone(token), id, widgetId);
      assert.notEqual(fresh.widget, frames.widget);
      assert.equal(await status(fixture, fresh.widget), 200);
      assert.equal(await status(fixture, fresh.application), 200);

      // Nothing about the handle was written anywhere in the state directory.
      const stateDirectory = join(fixture.directory, 'remote-state');
      for (const name of await readdir(stateDirectory)) {
        const content = await readFile(join(stateDirectory, name), 'utf8').catch(() => '');
        assert.ok(!content.includes(handle), `${name} contains a handle`);
      }
    },
  },
  {
    rule: '2',
    name: 'history page loaded later: the same handle as in the snapshot',
    async run(fixture) {
      const { id, widgetId } = await setUp(fixture);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);

      phone.send({ requestId: 'select', action: 'panel-state', id });
      await phone.reply('select');
      phone.send({
        requestId: 'page',
        action: 'agent-history-page',
        id,
        epoch: frames.session.toolEpoch,
        direction: 'after',
        index: 0,
        offset: 0,
      });
      const reply = (await phone.reply('page')) as Json;
      assert.equal(reply.type, 'result');
      const row = reply.result.messages.find((entry: Json) => entry.widget?.id === widgetId);
      assert.equal(row.widget.frameUrl, frames.widget);
      assert.equal(row.widget.viewUrl, undefined);
    },
  },
  {
    rule: '2',
    name: 'pinned widget: the pinned attachment carries the same handle',
    async run(fixture) {
      const { id, run } = await fixture.conversation();
      const widgetId = await fixture.publishCounter(run, { placement: 'pinned' });
      await fixture.applyNotes(run);
      const { token } = await fixture.pair();
      const phone = await fixture.phone(token);
      const frames = await framesFrom(phone, id, widgetId);
      assert.equal(frames.session.pinnedMessage.widget.id, widgetId);
      assert.equal(frames.session.pinnedMessage.widget.frameUrl, frames.widget);
      assert.equal(frames.session.pinnedMessage.widget.viewUrl, undefined);
    },
  },
  {
    rule: '7',
    name: 'at the per-device bound no new handle is issued and nothing is evicted',
    async run() {
      const conversation = '00000000-0000-4000-8000-000000000002';
      const handles = new FrameHandles('https://frames.example');
      const device = handles.connect('device');
      const view = (index: number) =>
        `http://127.0.0.1:1234/view/${index.toString(16).padStart(64, '0')}`;
      const issued: string[] = [];
      for (let index = 0; index < 1024; index++) {
        issued.push(device.widget(conversation, view(index))!);
      }
      assert.equal(new Set(issued).size, 1024);
      assert.equal(device.widget(conversation, view(5000)), undefined);
      assert.equal(device.widget(conversation, view(0)), issued[0]);
      assert.ok(handles.lookup(issued[0].split('/')[4]));
      // Another device still gets handles until the total bound.
      assert.ok(handles.connect('other').widget(conversation, view(5000)));
    },
  },
  {
    rule: '1',
    name: 'only listener view addresses become handles',
    async run() {
      const conversation = '00000000-0000-4000-8000-000000000003';
      const handles = new FrameHandles('https://frames.example');
      const device = handles.connect('device');
      for (const viewUrl of [
        'http://localhost:1234/private-capability',
        'http://127.0.0.1:1234/view/' + 'A'.repeat(64),
        'http://127.0.0.1:1234/view/' + 'a'.repeat(63),
        'http://127.0.0.1:1234/view/' + 'a'.repeat(64) + '/state',
        'https://127.0.0.1:1234/view/' + 'a'.repeat(64),
        'http://evil.example/view/' + 'a'.repeat(64),
        undefined,
        42,
      ]) {
        assert.equal(device.widget(conversation, viewUrl), undefined, String(viewUrl));
      }
      assert.equal(
        device.widget('not-a-uuid', 'http://127.0.0.1:1/view/' + 'a'.repeat(64)),
        undefined,
      );
      assert.equal(handles.size, 0);
    },
  },
  {
    rule: '7',
    name: 'a connection forgets views that ended, so its history stays within the bounds',
    async run() {
      const conversation = '00000000-0000-4000-8000-000000000004';
      const handles = new FrameHandles('https://frames.example');
      const device = handles.connect('device');
      const view = (index: number) =>
        `http://127.0.0.1:1234/view/${index.toString(16).padStart(64, '0')}`;
      for (let index = 0; index < 50; index++) {
        device.application(conversation, view(index));
        handles.viewEnded(view(index).slice(-64));
      }
      assert.equal(handles.size, 0);
      const histories = [...(handles as any).devices.get('device').connections.values()];
      assert.deepEqual(
        histories.map((history: Map<string, Set<string>>) => history.size),
        [0],
      );
    },
  },
];

for (const entry of cases) {
  test(`handle lifetime rule ${entry.rule}: ${entry.name}`, async (context) => {
    const fixture = await frameFixture({ graceMilliseconds: entry.grace });
    context.after(() => fixture.close());
    await entry.run(fixture);
  });
}
