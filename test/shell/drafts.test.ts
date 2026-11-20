import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import { chatMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import type { TestBrowser, TestPage } from '../mobile/browser.ts';
import { waitFor, type SyntheticRun } from '../remote-fixture.ts';
import {
  assertNoViolations,
  assertOwnOrigin,
  buttonExpression,
  click,
  clickButton,
  desktopPage,
  entryExpression,
  horizontalOverflow,
  online,
  openConversation,
  pairedPage,
  requestActions,
  setup,
  skip,
  withGateway,
  type Fixture,
  type SocketLog,
} from './page.ts';

/**
 * Listener drafts in the browser (integrations/shell/README.md, "Listener
 * drafts"), against the real gateway and listener control socket with a
 * synthetic agent backend, in temporary directories on loopback: the rows of
 * the README's tables a browser can time, played with real input. Every
 * ordering the browser cannot time (answers held back or lost, every
 * mode switch) is in listener-drafts.test.ts.
 *
 * The other editors are real too: a second page of the same device (its own
 * connection), a desktop-role client on the listener's control socket
 * (`draftHost: true`, as the Qt panel reports), and the listener's own
 * agent-draft entry point. A gateway without drafts is the real gateway
 * behind the older-gateway proxy (older-gateway.ts).
 *
 * With `COMPANION_SHELL_SCREENSHOTS=<directory>` the last test saves
 * screenshots at 420 and 1280 px (keep them out of Git).
 */

// ---- Fixtures ------------------------------------------------------------------------

/** Start a conversation with a finished answer; returns its ID. */
async function answered(fixture: Fixture, title: string): Promise<string> {
  const before = fixture.runs.length;
  const id = fixture.sessions.start({ ...frame, utterance: title }, signal());
  await waitFor(() => fixture.runs.length > before);
  const run = fixture.runs.find((candidate) =>
    candidate.request.prompt.text.includes(title),
  ) as SyntheticRun;
  run.emit({ ...chatMessage(`answer-${id}`, 'assistant', `Answer to ${title}.`), state: 'done' });
  run.finish();
  await waitFor(
    () => fixture.sessions.snapshot().find((entry) => entry.id === id)?.status === 'completed',
  );
  return id;
}

/** The listener's draft of a conversation ('' for none). */
function listenerDraft(fixture: Fixture, id: string): { text: string; source: string } {
  const drafts = fixture.desktop.runtime['drafts'].snapshot() as {
    sessionId: string;
    text: string;
    source: string;
  }[];
  const draft = drafts.find((entry) => entry.sessionId === id);
  return { text: draft?.text ?? '', source: draft?.source ?? '' };
}

/** An agent proposes a draft through the listener's `companion_session_draft` entry point. */
async function propose(fixture: Fixture, id: string, text: string, from: string): Promise<string> {
  const result = await (fixture.sessions as any).draftFromAgent(
    {
      id,
      text,
      ifDraftExists: 'reject',
      focus: false,
      origin: { kind: 'agent', sessionId: from, title: 'Planner', depth: 1 },
    },
    signal(),
  );
  return result.outcome;
}

type Message = Record<string, any>;

/**
 * A desktop editor: another connection to the listener's control socket
 * that reports `draftHost: true`, as the Qt panel does. It reads the
 * snapshot and every change, and writes with `draft-set`.
 */
async function desktopEditor(fixture: Fixture, context: { after(callback: () => void): void }) {
  const socket = createConnection(fixture.desktop.socketPath);
  const messages: Message[] = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  });
  await once(socket, 'connect');
  context.after(() => socket.destroy());
  let edits = 0;

  const send = (request: object) => socket.write(JSON.stringify(request) + '\n');
  send({ action: 'panel-state', id: '', composerFocused: false, draftHost: true });
  await waitFor(() => messages.some((message) => message.type === 'draft-snapshot'));

  return {
    /** The text this editor shows for `id`: the snapshot, then every change. */
    shown(id: string): string {
      let text = '';
      for (const message of messages) {
        if (message.type === 'draft-snapshot') {
          text = message.drafts.find((entry: Message) => entry.id === id)?.text ?? '';
        }
        if (message.type === 'draft' && message.id === id) {
          text = message.text;
        }
      }
      return text;
    },
    write(id: string, text: string): void {
      edits++;
      send({ action: 'draft-set', id, text, editId: `desktop-${edits}` });
    },
  };
}

/** The text box's value. */
function box(page: TestPage): Promise<string> {
  return page.evaluate<string>(`document.querySelector('.chat textarea')?.value ?? ''`);
}

/** A page expression: the text box shows exactly `text`. */
function boxShows(text: string): string {
  return `document.querySelector('.chat textarea')?.value === ${JSON.stringify(text)}`;
}

/** Type `text` at the end of the text box, as the person would after clicking into it. */
async function typeAtEnd(page: TestPage, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const area = document.querySelector('.chat textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  })()`);
  await page.type(text);
}

/** A page expression: the "not saved" line with Save and Discard is shown. */
const unsavedShown = `(() => {
  const line = document.querySelector('.composer .conflict.unsaved');
  if (!line) return false;
  const labels = [...line.querySelectorAll('button')].map((button) => button.textContent.trim());
  return labels.join(',') === 'Save,Discard';
})()`;

/** A page expression: the agent's note with Clear. */
const agentNoteShown = `(() => {
  const note = [...document.querySelectorAll('.composer .note')].find((element) =>
    element.textContent.startsWith('Drafted by agent · Planner — review before sending'));
  return Boolean(note && note.querySelector('button.link')?.textContent.trim() === 'Clear');
})()`;

/**
 * Every frame the page sent and received, in the order the browser reports
 * them (through the DevTools protocol).
 */
function traffic(browser: TestBrowser, page: TestPage): { sent: boolean; frame: Message }[] {
  const frames: { sent: boolean; frame: Message }[] = [];
  browser.on((message) => {
    if (message.sessionId !== page.sessionId) {
      return;
    }
    const sent = message.method === 'Network.webSocketFrameSent';
    if (!sent && message.method !== 'Network.webSocketFrameReceived') {
      return;
    }
    try {
      frames.push({ sent, frame: JSON.parse(String(message.params.response.payloadData)) });
    } catch {
      // Not JSON: not the gateway's.
    }
  });
  return frames;
}

/** The `draft-set` requests the page sent, in order. */
function draftSets(sockets: SocketLog, from = 0): Message[] {
  return sockets.sent
    .slice(from)
    .filter((sent) => sent.type === 'request' && sent.action === 'draft-set') as Message[];
}

/** Requests this suite allows a page to send. */
const allowedActions = [
  'panel-state',
  'draft-set',
  'send-agent',
  'close-agent',
  'activity-history',
];

async function assertCleanPage(fixture: Fixture, page: TestPage, sockets: SocketLog) {
  assertOwnOrigin(fixture, page, sockets);
  await assertNoViolations(page);
  for (const action of requestActions(sockets)) {
    assert.ok(allowedActions.includes(action), `unexpected request ${action}`);
  }
  assert.deepEqual(page.errors, []);
}

/** Show the list as a full list (remembered width) and reload. */
async function fullList(page: TestPage, origin: string): Promise<void> {
  await page.evaluate(
    `localStorage.setItem('companion.shell.layout.listWidth', JSON.stringify({ version: 1, value: 300 }))`,
  );
  await page.navigate(`${origin}/`);
  await page.waitFor(online, 8000);
  await page.waitFor(`document.querySelector('.conversations.full')`);
}

/** The list entry's ✎ and last line for the conversation titled `title`. */
function entryDraft(
  page: TestPage,
  title: string,
): Promise<{ pencil: boolean; line: string; label: string }> {
  return page.evaluate(`(() => {
    const entry = ${entryExpression(title)};
    const pencil = entry.querySelector('.entry-draft');
    return {
      pencil: Boolean(pencil) && getComputedStyle(pencil).display !== 'none',
      line: entry.querySelector('.entry-last-line').textContent,
      label: entry.querySelector('.entry-select').getAttribute('aria-label'),
    };
  })()`);
}

// ---- Tests ---------------------------------------------------------------------------

test(
  'typed text reaches a second page of this device and the desktop, theirs reaches it, and a send clears it everywhere',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = await answered(fixture, 'Shared draft conversation');
    const first = await pairedPage(fixture, browser, 1280, 800);
    const second = await desktopPage(browser, 1280, 800, first.browserContextId);
    await second.page.navigate(`${fixture.origin}/`);
    await second.page.waitFor(online, 8000);
    const desktop = await desktopEditor(fixture, context);

    for (const tab of [first.page, second.page]) {
      await tab.call('Page.bringToFront');
      await openConversation(tab, 'Shared draft conversation');
    }

    // Typed in the first page: the listener, the second page and the desktop.
    await first.page.call('Page.bringToFront');
    await typeAtEnd(first.page, 'Typed in the first page');
    await waitFor(() => listenerDraft(fixture, id).text === 'Typed in the first page');
    await second.page.waitFor(boxShows('Typed in the first page'));
    await waitFor(() => desktop.shown(id) === 'Typed in the first page');

    // Written on the desktop: both pages, with no notice.
    desktop.write(id, 'Written on the desktop');
    await first.page.waitFor(boxShows('Written on the desktop'));
    await second.page.waitFor(boxShows('Written on the desktop'));
    assert.equal(await first.page.evaluate(unsavedShown), false);

    // Typed in the second page: the first page and the desktop.
    await second.page.call('Page.bringToFront');
    await typeAtEnd(second.page, ', and the second page');
    const combined = 'Written on the desktop, and the second page';
    await first.page.waitFor(boxShows(combined));
    await waitFor(() => desktop.shown(id) === combined);

    // A send from the first page: the listener clears its draft (it still
    // equals the sent text), and every editor follows.
    await first.page.call('Page.bringToFront');
    const sentBefore = first.sockets.sent.length;
    await clickButton(first.page, 'Send');
    await first.page.waitFor(boxShows(''));
    await second.page.waitFor(boxShows(''));
    await waitFor(() => desktop.shown(id) === '');
    assert.equal(listenerDraft(fixture, id).text, '');
    const session = fixture.sessions.snapshot().find((entry) => entry.id === id)!;
    assert.equal(session.messages.filter((message) => message.text === combined).length, 1);

    // pendingSend went out before the send and was withdrawn after its answer;
    // no empty draft was written for the send.
    const after = first.sockets.sent.slice(sentBefore).filter((sent) => sent.type === 'request');
    const sendIndex = after.findIndex((sent) => sent.action === 'send-agent');
    assert.ok(sendIndex > 0);
    assert.equal(after[sendIndex - 1].action, 'panel-state');
    assert.equal(after[sendIndex - 1].pendingSend, id);
    await waitFor(() =>
      first.sockets.sent
        .slice(sentBefore)
        .some((sent) => sent.action === 'panel-state' && sent.pendingSend === ''),
    );
    assert.deepEqual(draftSets(first.sockets, sentBefore), []);

    for (const tab of [first, second]) {
      await assertCleanPage(fixture, tab.page, tab.sockets);
    }
  },
);

test(
  'fast typing ends with exactly the final text at the listener, one edit in flight at a time',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = await answered(fixture, 'Fast typing conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    const frames = traffic(browser, page);
    await openConversation(page, 'Fast typing conversation');

    const final = 'The quick brown fox jumps over the lazy dog, twice: quick, quick.';
    await page.evaluate(`document.querySelector('.chat textarea').focus()`);
    for (const character of final) {
      await page.type(character);
    }
    await page.waitFor(boxShows(final));
    await waitFor(() => listenerDraft(fixture, id).text === final, 5000);
    assert.equal(await box(page), final);

    // Every edit names a longer prefix than the one before (no stale text
    // after newer text), the last one is the final text, and each left only
    // after the previous one's answer had arrived.
    const edits = draftSets(sockets);
    assert.ok(edits.length >= 1 && edits.length <= final.length);
    for (let index = 0; index < edits.length; index++) {
      assert.ok(final.startsWith(edits[index].text));
      if (index > 0) {
        assert.ok(edits[index].text.length > edits[index - 1].text.length);
      }
    }
    assert.equal(edits[edits.length - 1].text, final);
    // One in flight: each edit left only after every earlier edit's answer
    // had arrived, as the browser reports the frames.
    let outstanding = '';
    let answeredEdits = 0;
    for (const { sent, frame: message } of frames) {
      if (sent && message.action === 'draft-set') {
        assert.equal(outstanding, '', 'an edit left while another was in flight');
        outstanding = message.requestId;
      }
      if (!sent && message.requestId && message.requestId === outstanding) {
        assert.equal(message.type, 'result');
        outstanding = '';
        answeredEdits++;
      }
    }
    assert.equal(answeredEdits, edits.length, 'every edit was answered');
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a refused edit keeps the text with Save and Discard, and nothing is lost',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = await answered(fixture, 'Refused edit conversation');
    const other = await answered(fixture, 'Flooded conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    const frames = traffic(browser, page);
    await openConversation(page, 'Refused edit conversation');

    // Another connection of the same device uses up the device's draft-edit
    // allowance (src/remote/README.md, "Drafts", rate): the page's next
    // edit is refused as "Too many draft edits".
    const token = await page.evaluate<string>(
      `JSON.parse(localStorage.getItem('companion.remote.device')).token`,
    );
    const flood = await fixture.phone(token, fixture.origin, true, { drafts: true });
    await waitFor(() => flood.messages.some((message) => message.type === 'authenticated'));
    flood.send({ requestId: 'report', action: 'panel-state', id: '' });
    await flood.reply('report');
    let flooding = true;
    let floodEdits = 0;
    const floodLoop = (async () => {
      while (flooding) {
        floodEdits++;
        flood.send({
          requestId: `flood-${floodEdits}`,
          action: 'draft-set',
          id: other,
          text: `flood ${floodEdits}`,
          editId: `flood-${floodEdits}`,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    /** Stop flooding and wait until the allowance admits an edit again. */
    async function stopFlood(): Promise<void> {
      flooding = false;
      await floodLoop;
      for (let probe = 0; ; probe++) {
        flood.send({
          requestId: `probe-${probe}`,
          action: 'draft-set',
          id: other,
          text: 'probe',
          editId: `probe-${probe}`,
        });
        const reply = await flood.reply(`probe-${probe}`);
        if (reply.type === 'result') {
          return;
        }
      }
    }
    await waitFor(() =>
      flood.messages.some(
        (message) =>
          message.type === 'error' && /Too many draft edits/.test(String(message.message)),
      ),
    );

    await typeAtEnd(page, 'Refused while flooded');
    await page.waitFor(unsavedShown);
    assert.match(
      await page.evaluate<string>(
        `document.querySelector('.composer .conflict.unsaved').textContent`,
      ),
      /Your text is not saved: Too many draft edits/,
    );
    assert.equal(await box(page), 'Refused while flooded');
    assert.notEqual(listenerDraft(fixture, id).text, 'Refused while flooded');
    // While it is not saved, the conversation cannot be closed from here.
    assert.equal(await page.evaluate(`${buttonExpression('Close session')}.disabled`), true);

    // Save writes it once the allowance admits edits again. The allowance
    // refills 40 times a second, so a Save right after the flood can be
    // refused once more; the text then stays unsaved, and the person presses
    // Save again. Each Save is one edit, and its answer decides.
    await stopFlood();
    const savedBefore = draftSets(sockets).length;
    let saves = 0;
    let saved = false;
    while (!saved) {
      saves++;
      assert.ok(saves <= 20, 'Save never got through');
      const before = draftSets(sockets).length;
      await clickButton(page, 'Save');
      await waitFor(() => draftSets(sockets).length === before + 1);
      const requestId = draftSets(sockets)[before].requestId;
      await waitFor(() => frames.some(({ sent, frame }) => !sent && frame.requestId === requestId));
      const answer = frames.find(({ sent, frame }) => !sent && frame.requestId === requestId)!;
      saved = answer.frame.type === 'result';
      if (!saved) {
        assert.match(String(answer.frame.message), /Too many draft edits/);
        await page.waitFor(unsavedShown);
      }
    }
    await waitFor(() => listenerDraft(fixture, id).text === 'Refused while flooded');
    await page.waitFor(`!${unsavedShown}`);
    assert.equal(await box(page), 'Refused while flooded');
    assert.equal(draftSets(sockets).length, savedBefore + saves, 'one edit per Save');

    // Refused again, then Discard: the listener's draft returns, nothing is written.
    flooding = true;
    const again = (async () => {
      while (flooding) {
        floodEdits++;
        flood.send({
          requestId: `flood-${floodEdits}`,
          action: 'draft-set',
          id: other,
          text: `flood ${floodEdits}`,
          editId: `flood-${floodEdits}`,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const errorsBefore = flood.messages.length;
    await waitFor(() =>
      flood.messages
        .slice(errorsBefore)
        .some((message) => message.type === 'error' && /Too many/.test(String(message.message))),
    );
    await typeAtEnd(page, ', and more');
    await page.waitFor(unsavedShown);
    flooding = false;
    await again;
    const discardBefore = draftSets(sockets).length;
    await clickButton(page, 'Discard');
    await page.waitFor(boxShows('Refused while flooded'));
    await page.waitFor(`!${unsavedShown}`);
    assert.equal(draftSets(sockets).length, discardBefore);
    assert.equal(listenerDraft(fixture, id).text, 'Refused while flooded');
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'an agent proposal shows its note; Clear empties it, editing removes the note, sending clears it; never a switch',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = await answered(fixture, 'Agent draft conversation');
    const other = await answered(fixture, 'Other agent conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    await openConversation(page, 'Agent draft conversation');

    // Proposed for the shown conversation: shown with the note and Clear.
    assert.equal(await propose(fixture, id, 'An agent proposal', other), 'inserted');
    await page.waitFor(boxShows('An agent proposal'));
    await page.waitFor(agentNoteShown);

    // Clear: one edit with empty text; the box and the note are empty.
    const clearBefore = draftSets(sockets).length;
    await clickButton(page, 'Clear');
    await page.waitFor(boxShows(''));
    await waitFor(() => listenerDraft(fixture, id).text === '');
    await page.waitFor(`!${agentNoteShown}`);
    assert.deepEqual(
      draftSets(sockets, 0)
        .slice(clearBefore)
        .map((edit) => edit.text),
      [''],
    );

    // Editing a proposal removes the note at once; the edit is the person's.
    assert.equal(await propose(fixture, id, 'Second proposal', other), 'inserted');
    await page.waitFor(agentNoteShown);
    await typeAtEnd(page, ', edited');
    await page.waitFor(`!${agentNoteShown}`);
    await waitFor(() => listenerDraft(fixture, id).text === 'Second proposal, edited');
    assert.equal(listenerDraft(fixture, id).source, '');

    // Sending it: the listener clears it, the box empties.
    await clickButton(page, 'Send');
    await page.waitFor(boxShows(''));
    await waitFor(() => listenerDraft(fixture, id).text === '');

    // Proposed for another conversation: no switch; the list marks it.
    assert.equal(await propose(fixture, other, 'For the other one', id), 'inserted');
    await page.waitFor(`document.querySelector('.entry-draft')`);
    assert.equal(
      await page.evaluate<string>(
        `document.querySelector('.conversation-entry.selected .entry-select').title`,
      ),
      'Agent draft conversation',
      'still the conversation shown',
    );
    assert.equal(await box(page), '');
    const marked = await entryDraft(page, 'Other agent conversation');
    assert.equal(marked.pencil, true);
    assert.equal(marked.line, 'Draft: For the other one');
    await openConversation(page, 'Other agent conversation');
    await page.waitFor(boxShows('For the other one'));
    await page.waitFor(agentNoteShown);
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'the list shows ✎ in the strip and "Draft: …" in the full list, also for the own unsent text',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    await answered(fixture, 'Shown conversation');
    const desktopDraft = await answered(fixture, 'Desktop draft conversation');
    await answered(fixture, 'Own draft conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    const desktop = await desktopEditor(fixture, context);
    desktop.write(desktopDraft, 'Written on the desktop,\nover two lines');

    await openConversation(page, 'Own draft conversation');
    await typeAtEnd(page, 'My own unsent text');
    await openConversation(page, 'Shown conversation');

    // The strip: a pencil on the icon; the last line is the description.
    await page.waitFor(`document.querySelector('.conversations.strip')`);
    await page.waitFor(`document.querySelectorAll('.entry-draft').length === 2`);
    let entry = await entryDraft(page, 'Desktop draft conversation');
    assert.equal(entry.pencil, true);
    assert.equal(entry.line, 'Draft: Written on the desktop, over two lines');
    assert.match(entry.label, /, unsent draft$/);
    entry = await entryDraft(page, 'Own draft conversation');
    assert.equal(entry.pencil, true);
    assert.equal(entry.line, 'Draft: My own unsent text');
    entry = await entryDraft(page, 'Shown conversation');
    assert.equal(entry.pencil, false, 'not for the conversation shown');
    assert.equal(entry.line, 'Answer to Shown conversation.');

    // The full list: "Draft: …" as the second line, no pencil.
    await fullList(page, fixture.origin);
    await openConversation(page, 'Shown conversation');
    await page.waitFor(
      `${entryExpression('Desktop draft conversation')}.querySelector('.entry-last-line').textContent.startsWith('Draft: ')`,
    );
    entry = await entryDraft(page, 'Desktop draft conversation');
    assert.equal(entry.pencil, false);
    assert.equal(entry.line, 'Draft: Written on the desktop, over two lines');
    const shownLine = await page.evaluate<boolean>(`(() => {
      const line = ${entryExpression('Own draft conversation')}.querySelector('.entry-last-line');
      return line.getBoundingClientRect().height > 0 && line.textContent === 'Draft: My own unsent text';
    })()`);
    assert.equal(shownLine, true);

    // Opening it removes its marks; the conversation left gets none (no draft).
    await openConversation(page, 'Own draft conversation');
    await page.waitFor(boxShows('My own unsent text'));
    entry = await entryDraft(page, 'Own draft conversation');
    assert.equal(entry.line.startsWith('Draft: '), false);
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'a local draft from before is offered once as unsaved text, never written by itself',
  { skip },
  async (context) => {
    const { fixture, browser } = await setup(context);
    const id = await answered(fixture, 'Migration conversation');
    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);

    // What this browser kept before drafts were shared (the phone Store's map).
    await page.evaluate(
      `localStorage.setItem('companion.remote.drafts', JSON.stringify({ ${JSON.stringify(id)}: 'Kept in this browser', new: 'A question to start' }))`,
    );
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await openConversation(page, 'Migration conversation');
    await page.waitFor(boxShows('Kept in this browser'));
    await page.waitFor(unsavedShown);
    assert.match(
      await page.evaluate<string>(
        `document.querySelector('.composer .conflict.unsaved').textContent`,
      ),
      /This text was kept in this browser; it is not saved in Companion yet\./,
    );
    assert.equal(listenerDraft(fixture, id).text, '', 'not written by itself');
    assert.deepEqual(draftSets(sockets), []);
    const stored = `localStorage.getItem('companion.remote.drafts')`;
    // While it is not saved, this browser keeps it: a reload offers it again.
    assert.equal(
      await page.evaluate(stored),
      JSON.stringify({ new: 'A question to start', [id]: 'Kept in this browser' }),
    );
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await openConversation(page, 'Migration conversation');
    await page.waitFor(boxShows('Kept in this browser'));
    await page.waitFor(unsavedShown);

    // Discard: the listener's (empty) draft; the local copy is deleted and
    // the new-conversation box stays local.
    await clickButton(page, 'Discard');
    await page.waitFor(boxShows(''));
    await page.waitFor(`!${unsavedShown}`);
    assert.equal(await page.evaluate(stored), JSON.stringify({ new: 'A question to start' }));

    // Offered once: after another reload nothing is offered.
    await page.navigate(`${fixture.origin}/`);
    await page.waitFor(online, 8000);
    await openConversation(page, 'Migration conversation');
    await page.waitFor(`document.querySelector('.chat textarea')`);
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Done'`);
    assert.equal(await box(page), '');
    assert.equal(await page.evaluate(unsavedShown), false);
    assert.equal(listenerDraft(fixture, id).text, '');
    assert.deepEqual(draftSets(sockets), [], 'never written by itself');
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'against a gateway without drafts the page keeps its drafts in this browser, as before',
  { skip },
  async (context) => {
    const { fixture: gatewayFixture, browser } = await setup(context);
    const fixture = await withGateway(gatewayFixture, false, context);
    const id = await answered(fixture, 'Local draft conversation');
    await answered(fixture, 'Second local conversation');
    const desktop = await desktopEditor(fixture, context);
    desktop.write(id, 'Only on the desktop');
    await waitFor(() => listenerDraft(fixture, id).text === 'Only on the desktop');

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    // The auth message asked for drafts; the older gateway ignored it.
    await openConversation(page, 'Local draft conversation');
    await page.waitFor(`document.querySelector('.state')?.textContent === 'Done'`);
    assert.equal(await box(page), '', "the listener's draft is not shown");

    await typeAtEnd(page, 'Kept in this browser only');
    await page.waitFor(
      `JSON.parse(localStorage.getItem('companion.remote.drafts') || '{}')[${JSON.stringify(id)}] === 'Kept in this browser only'`,
    );
    await openConversation(page, 'Second local conversation');
    await openConversation(page, 'Local draft conversation');
    await page.waitFor(boxShows('Kept in this browser only'));
    assert.equal(listenerDraft(fixture, id).text, 'Only on the desktop', 'nothing written');
    assert.equal(desktop.shown(id), 'Only on the desktop');

    // No pencil, no "Draft: …", no note, no "not saved".
    await openConversation(page, 'Second local conversation');
    const entry = await entryDraft(page, 'Local draft conversation');
    assert.equal(entry.pencil, false);
    assert.equal(entry.line.startsWith('Draft: '), false);
    await openConversation(page, 'Local draft conversation');
    assert.equal(await page.evaluate(unsavedShown), false);

    // A completed send clears the local draft.
    await clickButton(page, 'Send');
    await page.waitFor(boxShows(''));
    await page.waitFor(
      `!(${JSON.stringify(id)} in JSON.parse(localStorage.getItem('companion.remote.drafts') || '{}'))`,
    );

    assert.deepEqual(draftSets(sockets), [], 'no draft-set');
    for (const sent of sockets.sent) {
      if (sent.action === 'panel-state') {
        assert.equal('pendingSend' in sent, false, 'no pendingSend');
      }
    }
    assert.equal(sockets.sent[0].drafts, true, 'the page asked for drafts');
    await assertCleanPage(fixture, page, sockets);
  },
);

test(
  'unsaved text, an agent draft and the list at 420 and 1600 px without overflow; screenshots',
  { skip },
  async (context) => {
    const directory = process.env.COMPANION_SHELL_SCREENSHOTS;
    if (directory) {
      await mkdir(directory, { recursive: true });
    }
    const { fixture, browser } = await setup(context);
    const unsaved = await answered(fixture, '🧾 Invoice export');
    const proposed = await answered(fixture, '🗺️ Plan a two-day synthetic city trip');
    const desktopDraft = await answered(fixture, '🐛 Why does the list test fail?');
    await answered(fixture, 'Notification rules');
    const desktop = await desktopEditor(fixture, context);
    desktop.write(desktopDraft, 'Could it be the timer in the second test? Check the fake clock.');

    const { page, sockets } = await pairedPage(fixture, browser, 1280, 800);
    assert.equal(
      await propose(
        fixture,
        proposed,
        'Day one: old town and the river walk. Day two: museums.',
        unsaved,
      ),
      'inserted',
    );
    // Unsaved: typed while not connected (the network goes away).
    await openConversation(page, '🧾 Invoice export');
    await page.call('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.evaluate(`window.dispatchEvent(new Event('offline'))`);
    await typeAtEnd(page, 'Please also list the invoices from March.');
    await page.waitFor(unsavedShown);
    await page.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);
    await page.waitFor(online, 10_000);
    await page.waitFor(unsavedShown);
    assert.equal(listenerDraft(fixture, unsaved).text, '', 'never written by itself');

    const shots: { name: string; width: number; title: string; full: boolean }[] = [
      { name: 'unsaved', width: 420, title: '🧾 Invoice export', full: false },
      { name: 'unsaved', width: 1280, title: '🧾 Invoice export', full: false },
      { name: 'agent-draft', width: 420, title: '🗺️ Plan a two-day', full: false },
      { name: 'agent-draft', width: 1280, title: '🗺️ Plan a two-day', full: false },
      { name: 'list-strip', width: 1280, title: 'Notification rules', full: false },
      { name: 'list-full', width: 1280, title: 'Notification rules', full: true },
      { name: 'list-strip', width: 420, title: 'Notification rules', full: false },
      { name: 'agent-draft', width: 1600, title: '🗺️ Plan a two-day', full: true },
      { name: 'unsaved', width: 1600, title: '🧾 Invoice export', full: true },
    ];
    let listIsFull = false;
    for (const shot of shots) {
      if (shot.full && !listIsFull) {
        await fullList(page, fixture.origin);
        listIsFull = true;
      }
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.waitFor(`document.documentElement.clientWidth === ${shot.width}`);
      await openConversation(page, shot.title);
      if (shot.name === 'unsaved') {
        await page.waitFor(unsavedShown);
      }
      if (shot.name === 'agent-draft') {
        await page.waitFor(agentNoteShown);
      }
      if (shot.name.startsWith('list')) {
        await page.waitFor(`document.querySelectorAll('.entry-draft').length >= 2`);
      }
      assert.equal(await horizontalOverflow(page), 0, `${shot.name} at ${shot.width} px`);
      // The Save, Discard and Clear links are inside the window.
      const outside = await page.evaluate<
        string[]
      >(`[...document.querySelectorAll('.composer button.link')]
        .filter((button) => {
          const box = button.getBoundingClientRect();
          return box.right > document.documentElement.clientWidth + 0.5 || box.left < 0;
        })
        .map((button) => button.textContent)`);
      assert.deepEqual(outside, [], `${shot.name} at ${shot.width} px`);
      if (directory) {
        const list = listIsFull ? 'full' : 'strip';
        await writeFile(
          join(directory, `drafts-${shot.name}-${shot.width}-${list}.png`),
          await page.screenshot(),
        );
      }
    }
    await assertCleanPage(fixture, page, sockets);
  },
);
