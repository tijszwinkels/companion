import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeHtml, parseHtmlBubble, renderHtml } from '../../integrations/panel/Html.mjs';
import registerHtml, { htmlTool } from '../../src/agents/html-tool.ts';
import { PiBackend } from '../../src/agents/pi-backend.ts';
import { PiTranscript } from '../../src/agents/pi-transcript.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { chatMessage, type AgentBackend, type AgentMessage } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';

const html =
  '<table width="100%" cellpadding="8"><tr><td style="background-color: var(--selection)">Input</td><td>→</td><td style="color: var(--accent)">Result</td></tr></table>';
const payload = { version: 1, html, text: 'Input leads to Result.' };

async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-html-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fixture-pi');
  await copyFile(fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url)), executable);
  await chmod(executable, 0o700);
  const settings = { ...defaultAgentSettings, executable };
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(settings));
  return { directory, settings };
}

test('native HTML tool validates, registers prompt hints and returns a portable display payload', async () => {
  let registered: unknown;
  registerHtml({
    registerTool: (tool) => {
      registered = tool;
    },
  });
  assert.equal(registered, htmlTool);
  assert.match(htmlTool.promptSnippet, /HTML/);
  assert.match(htmlTool.promptGuidelines.join(' '), /ordinary Markdown/);
  assert.deepEqual((await htmlTool.execute('one', payload)).details.companionHtml, payload);
  await assert.rejects(
    htmlTool.execute('one', { html: '<img src="file:///etc/passwd">', text: 'fallback' }),
  );
  await assert.rejects(htmlTool.execute('one', payload, AbortSignal.abort()), {
    name: 'AbortError',
  });
  for (const invalid of [
    null,
    {},
    { ...payload, version: 2 },
    { ...payload, text: '' },
    { ...payload, text: 'x'.repeat(4001) },
  ]) {
    assert.throws(() => parseHtmlBubble(invalid));
  }
});

test('allowlist rejects resource loads, actions, CSS escapes, malformed and excessive layouts', () => {
  const invalid = [
    '<script>alert(1)</script>',
    '<svg><rect/></svg>',
    '<iframe src="https://example.com"></iframe>',
    '<img src="file:///private.png">',
    '<object data="file:///private"></object>',
    '<a href="https://example.com">click</a>',
    '<meta http-equiv="refresh" content="0;url=file:///private">',
    '<style>@import "https://example.com";</style>',
    '<p style="background-image: url(file:///private)">x</p>',
    '<p style="background: url(https://example.com)">x</p>',
    '<p onclick="run()">x</p>',
    '<p style="color: &#35;ffffff">x</p>',
    '<p style="color: #ffffff; color: #000000">x</p>',
    '<p style="font-family: url(https://example.com)">x</p>',
    '<p style="c\\olor: #ffffff">x</p>',
    '<p style="font-size: 9999px">x</p>',
    '<p style="position: fixed">x</p>',
    '<table width="999999"><tr><td>x</td></tr></table>',
    '<p width="50%">x</p>',
    '<p style=color:red>x</p>',
    '<p/><p>x</p>',
    '<p>x</div>',
    '<p><b>x</p></b>',
    '<!-- x -->',
    '<table><tr><td><table></table></td></tr></table>',
    '<table><td>x</td></table>',
    '<table>text</table>',
    '<p align="left" align="right">x</p>',
    '<table><tr>' + '<td>x</td>'.repeat(5) + '</tr></table>',
    '<table>' + '<tr><td>x</td></tr>'.repeat(13) + '</table>',
    '<span>'.repeat(9) + 'x' + '</span>'.repeat(9),
    '<br>'.repeat(161),
    'x'.repeat(12289),
    '<p>&#0;</p>',
    '<p>&#x110000;</p>',
  ];
  for (const source of invalid) {
    assert.throws(() => normalizeHtml(source), source.slice(0, 100));
  }
  const escaped = normalizeHtml(
    '<p>&lt;img src="file:///private"&gt; &rarr; Result &amp; text</p>',
  );
  assert.doesNotMatch(escaped, /<img/);
  assert.equal(normalizeHtml(escaped), escaped, 'Normalization is idempotent');
  assert.equal(normalizeHtml('<p>Fish & chips<br/>done</p>'), '<p>Fish &amp; chips<br>done</p>');
  const rendered = renderHtml(
    '<span style="font-size: 20px; color: var(--accent)">var(--accent)</span>',
    1.5,
    '#ffffff',
    '#cccccc',
    '#123456',
    '#333333',
  );
  assert.match(rendered, /font-size: 30px; color: #123456/);
  assert.match(rendered, />var\(--accent\)<\/span>/, 'Literal text is not theme-substituted');
});

test('transcript publishes only once from a successful correlated completion, never from updates or cancellation', () => {
  const updates: AgentMessage[] = [];
  const controller = new AbortController();
  const transcript = new PiTranscript((message) => updates.push(message), controller.signal);
  const result = {
    content: [{ type: 'text', text: 'Published' }],
    details: { companionHtml: payload },
  };
  const start = (id: string, name = 'companion_html') =>
    transcript.receive({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: name,
      args: payload,
    });
  const end = (id: string, isError: boolean | undefined = false) =>
    transcript.receive({ type: 'tool_execution_end', toolCallId: id, result, isError });
  end('unrelated');
  start('other', 'read');
  end('other');
  start('failed');
  end('failed', true);
  start('one');
  transcript.receive({ type: 'tool_execution_update', toolCallId: 'one', partialResult: result });
  assert.equal(updates.filter((message) => message.html).length, 0);
  end('one');
  end('one');
  start('one');
  end('one');
  transcript.receive({ type: 'tool_execution_update', toolCallId: 'one', partialResult: result });
  assert.equal(updates.filter((message) => message.html).length, 1);
  assert.equal(updates.at(-1)?.kind, 'assistant');
  start('cancelled');
  controller.abort();
  end('cancelled');
  assert.equal(updates.filter((message) => message.html).length, 1);
});

for (const variant of ['valid', 'malformed', 'missing', 'version']) {
  test(`real subprocess RPC HTML ${variant} preserves the ordinary answer`, async (context) => {
    const { directory, settings } = await fixture(context);
    const updates: AgentMessage[] = [];
    await new PiBackend().run(
      { id: 'html', directory, settings, prompt: { text: `html ${variant}` }, resume: false },
      signal(),
      (message) => updates.push(message),
    );
    assert.equal(updates.filter((message) => message.html).length, variant === 'valid' ? 1 : 0);
    assert.equal(updates.at(-1)?.text, '## Answer\n**42**');
    if (variant !== 'valid') {
      assert.equal(updates.filter((message) => message.kind === 'notice').length, 1);
    }
    if (variant === 'malformed') {
      assert.equal(updates.find((message) => message.kind === 'notice')?.text, payload.text);
    }
    const captured = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
    assert.ok(
      captured.argv.includes(
        fileURLToPath(new URL('../../src/agents/html-tool.ts', import.meta.url)),
      ),
    );
    assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
  });
}

test('HTML survives persistence/reopen, damaged HTML keeps text, and old snapshots stay compatible', async (context) => {
  const { directory } = await fixture(context);
  const store = new SessionStore(join(directory, '.companion-sessions'));
  const sessions = new AgentSessions({ backend: new PiBackend() }, () => {}, directory);
  context.after(() => sessions.close());
  const id = sessions.start({ ...frame, utterance: 'html valid' }, signal());
  await sessions.idle();
  assert.equal(sessions.snapshot()[0].status, 'completed');
  const original = sessions.snapshot()[0].messages.find((message) => message.html)!;
  assert.equal(original.text, payload.text);
  await sessions.remove(id);
  await sessions.reopen(id);
  assert.deepEqual(
    sessions.snapshot()[0].messages.find((message) => message.html),
    original,
  );
  const saved = await store.read(id);
  const visual = saved.messages.find((message) => message.html)!;
  visual.html = '<img src="file:///private.png">';
  await store.save(saved);
  const restored = await store.read(id);
  assert.equal(restored.messages.find((message) => message.id === visual.id)?.html, undefined);
  assert.equal(restored.messages.find((message) => message.id === visual.id)?.text, payload.text);
  assert.equal(restored.messages[0].html, undefined);
});

test('HTML counts toward the session budget and stale callbacks cannot publish after a turn ends', async (context) => {
  const { directory } = await fixture(context);
  let retainedEmit: (message: AgentMessage) => void = () => {};
  const backend: AgentBackend = {
    id: 'fixture',
    label: 'fixture',
    dependencies: {},
    async run(_request, _signal, emit) {
      retainedEmit = emit;
      for (let index = 0; index < 30; index++) {
        emit({
          ...chatMessage(String(index), 'assistant', payload.text),
          html: '<p>' + 'x'.repeat(12000) + '</p>',
        });
      }
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  context.after(() => sessions.close());
  sessions.start(frame, signal());
  await sessions.idle();
  const view = sessions.snapshot()[0];
  assert.equal(view.status, 'error');
  assert.match(view.error, /transcript limit/);
  const count = view.messages.length;
  retainedEmit({ ...chatMessage('late', 'assistant', payload.text), html });
  assert.equal(sessions.snapshot()[0].messages.length, count);
});
