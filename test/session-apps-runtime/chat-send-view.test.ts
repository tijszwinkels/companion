/** Actual sandbox API → capability service → FIFO → scripted Pi/Claude turns. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Chromium } from '../../src/widgets/chromium.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { waitForRelease } from './chat-send-fixture.ts';
import { applicationFixture, eventually } from './fixture.ts';

async function inApp(browser: Chromium, expression: string): Promise<any> {
  const targets = (await browser.call('Target.getTargets')).targetInfos as {
    type: string;
    targetId: string;
  }[];
  const target = targets.find((entry) => entry.type === 'iframe');
  if (!target) return undefined;
  const attached = await browser.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const session = String(attached.sessionId);
  try {
    const reply = await browser.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session,
    );
    assert.ok(
      !reply.exceptionDetails,
      JSON.stringify(reply.exceptionDetails ?? null).slice(0, 400),
    );
    return (reply.result as { value?: unknown }).value;
  } finally {
    await browser.call('Target.detachFromTarget', { sessionId: session }).catch(() => {});
  }
}

for (const harness of ['pi', 'claude-code'] as const) {
  test(`${harness}: authored sender retains its handle after a lost response, probes without replay and preserves pending edits`, async (context) => {
    const fixture = await applicationFixture(context);
    const { sessions } = fixture;
    const browser = new Chromium();
    context.after(() => browser.close());
    await fixture.bundle(
      'sender-probe',
      {
        version: 1,
        description: 'Synthetic sender',
        application: { capabilities: ['chat.read', 'chat.send'] },
        parameters: { type: 'object', properties: { count: { type: 'integer' } } },
        actions: {
          bump: {
            description: 'Edit',
            parameters: { type: 'object' },
            returns: { type: 'object' },
          },
        },
        queries: {},
        example: { count: 0 },
      },
      `export function describe(s){return 'Synthetic count '+s.count;}
      export const actions={bump(s){s.count++;return {state:s};}};
      export function mount(root,api){window.probeApi=api;return {update(){}};}`,
    );
    const id = sessions.start(frame, signal(), 'coding', harness);
    fixture.script(id, async (turn) => {
      await turn.tool('companion_app_apply', {
        bundle: 'sender-probe',
        expectedVersion: 0,
        eventMode: 'next-input',
      });
    });
    await sessions.idle();
    const application = () => fixture.view(id).application!;
    async function grant(allowed = true) {
      const app = application();
      await sessions.setApplicationChatSend(id, {
        applicationId: app.id,
        version: app.version,
        revision: app.chatAccess!.revision,
        allowed,
      });
    }
    const url = application().viewUrl!;
    const page = await browser.page(
      (candidate) => candidate === url || candidate.startsWith(url + '/'),
    );
    await page.call('Page.navigate', { url });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await inApp(browser, 'typeof window.probeApi')) === 'object') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await inApp(browser, 'typeof window.probeApi'), 'object');
    assert.match(
      await inApp(browser, 'probeApi.chat.prepareSend().catch(e=>e.message)'),
      /consent/,
    );
    await grant();
    const handle = await inApp(
      browser,
      'probeApi.chat.prepareSend().then(h=>{window.original=h;return h;})',
    );
    assert.equal(handle.version, 1);
    assert.equal(
      application().chatAccess!.send!.remaining,
      5,
      'Prepare does not admit or consume quota',
    );
    assert.equal(
      application().chatAccess!.read,
      false,
      'Sending does not require or grant reading',
    );
    const started = deferred<void>();
    const release = deferred<void>();
    fixture.script(id, async (turn) => {
      started.resolve();
      await waitForRelease(release, turn.signal);
    });
    // Queue an edit after this human turn has started, so it waits for the next one.
    sessions.followUp(id, 'Hold synthetic model', signal());
    await started.promise;
    await inApp(browser, 'probeApi.call("bump")');
    assert.equal(application().eventStatus!.undelivered, 1);
    fixture.script(id, async (turn) => {
      assert.equal(turn.harness, harness);
      assert.match(turn.text, /^\[Companion application message\]/);
      assert.match(turn.text, /not authenticated human input/);
      assert.ok(turn.text.endsWith('Synthetic app request'));
      assert.doesNotMatch(turn.text, /Companion application event/);
    });
    // Lose only the acknowledgement AFTER the real backend has accepted it.
    await page.evaluate(`window.dropSendReply=true;window.originalFetch=window.fetch;
      window.fetch=async (...args)=>{const response=await window.originalFetch(...args);
        if(String(args[0]).endsWith('/chat-send')&&window.dropSendReply){window.dropSendReply=false;throw Error('Synthetic lost acknowledgement');}
        return response;};true`);
    assert.match(
      await inApp(
        browser,
        'probeApi.chat.send(original,"Synthetic app request").catch(e=>e.message)',
      ),
      /unconfirmed.*original handle/,
    );
    assert.deepEqual(await inApp(browser, 'original'), handle);
    const queued = await inApp(
      browser,
      'probeApi.chat.receipt(original).catch(e=>({error:e.message}))',
    );
    assert.ok(!queued.error, JSON.stringify(queued));
    assert.equal(queued.state, 'queued');
    assert.equal(queued.requestId, handle.requestId);
    assert.equal(application().chatAccess!.send!.remaining, 4);
    release.resolve();
    await sessions.idle();
    const completed = await inApp(browser, 'probeApi.chat.receipt(original)');
    assert.equal(completed.state, 'completed');
    assert.equal(completed.receiptId, queued.receiptId);
    assert.equal(
      application().eventStatus!.undelivered,
      1,
      'App input leaves next-input edits waiting',
    );
    const turns = fixture.turns.length;
    // The portable broker also carries the independently granted read path,
    // including the canonical non-human source of this app-authored message.
    for (const allowed of [true, false]) {
      const app = application();
      await sessions.setApplicationChatRead(id, {
        applicationId: app.id,
        version: app.version,
        revision: app.chatAccess!.revision,
        allowed,
      });
      await inApp(browser, 'probeApi.state.read()');
      if (allowed) {
        const snapshot = await inApp(browser, 'probeApi.chat.read()');
        assert.ok(
          snapshot.messages.some(
            (row: any) =>
              row.source === 'application' && row.text.endsWith('Synthetic app request'),
          ),
        );
      } else {
        assert.match(
          await inApp(browser, 'probeApi.chat.read().catch(e=>e.message)'),
          /not currently permitted/,
        );
      }
    }
    // An explicit exact retry deduplicates. The API itself never performed it.
    assert.equal(
      (await inApp(browser, 'probeApi.chat.send(original,"Synthetic app request")')).receiptId,
      queued.receiptId,
    );
    assert.match(
      await inApp(browser, 'probeApi.chat.send(original,"Changed text").catch(e=>e.message)'),
      /unconfirmed/,
    );
    assert.equal(fixture.turns.length, turns);
    assert.equal(application().chatAccess!.send!.remaining, 4);
    assert.equal(
      fixture.view(id).messages.filter((row) => row.origin?.kind === 'application-message').length,
      1,
    );

    await grant(false);
    assert.equal((await inApp(browser, 'probeApi.chat.receipt(original)')).state, 'completed');
    assert.match(
      await inApp(browser, 'probeApi.chat.prepareSend().catch(e=>e.message)'),
      /consent/,
    );
    await grant();
    const renewed = await inApp(browser, 'probeApi.chat.prepareSend()');
    assert.notEqual(renewed.grantId, handle.grantId);
    assert.equal(
      (await inApp(browser, 'probeApi.chat.receipt(original)')).receiptId,
      queued.receiptId,
    );
    assert.equal(fixture.turns.length, turns);

    // Queue another prepared handle, revoke it before the model, then probe the
    // original cancelled receipt. A later human turn still consumes the edit.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const held = deferred<void>();
    const finish = deferred<void>();
    fixture.script(id, async (turn) => {
      held.resolve();
      await waitForRelease(finish, turn.signal);
    });
    sessions.followUp(id, 'Hold again', signal());
    await held.promise;
    await inApp(browser, 'probeApi.call("bump")');
    const cancelled = await inApp(
      browser,
      'probeApi.chat.prepareSend().then(h=>{window.second=h;return probeApi.chat.send(h,"Never run this");})',
    );
    assert.equal(cancelled.state, 'queued');
    await grant(false);
    assert.equal((await inApp(browser, 'probeApi.chat.receipt(second)')).state, 'cancelled');
    finish.resolve();
    await sessions.idle();
    assert.ok(!fixture.turns.some((turn) => turn.text.endsWith('Never run this')));
    assert.equal(application().eventStatus!.undelivered, 1);
    fixture.script(id, async (turn) => {
      assert.match(turn.text, /Companion application event/);
      await turn.tool('companion_app_apply', { bundle: 'sender-probe', expectedVersion: 1 });
    });
    sessions.followUp(id, 'Consume the edit and replace the code', signal());
    await sessions.idle();
    await eventually(() => application().version === 2);
    // The successor cannot use an old handle even if authored code saved it.
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await page.evaluate('window.widgetBootstrap?.application?.version')) === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await page.evaluate('window.widgetBootstrap?.application?.version'), 2);
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await inApp(browser, 'typeof window.probeApi')) === 'object') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(
      await inApp(browser, `probeApi.chat.receipt(${JSON.stringify(handle)}).catch(e=>e.message)`),
      /exact send handle/,
    );
    assert.equal(application().chatAccess!.send!.allowed, false);
    assert.equal(application().eventStatus!.undelivered, 0);
  });
}
