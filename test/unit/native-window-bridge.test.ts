import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(
  new URL('../../integrations/omarchy/plugin/Service.qml', import.meta.url),
  'utf8',
);

// Exercise the actual adapter functions with inert compositor/transport objects.
// This proves their ordering decisions, not real Wayland focus behavior.
function fixture() {
  const requests: unknown[] = [];
  const native = {
    ready: true,
    status: { active: false },
    send: (request: unknown) => requests.push(request),
  };
  const root: any = {
    pendingHistoryInsert: { action: 'paste', id: 'utterance', target: '0x123', restoring: true },
  };
  const Hyprland: any = {
    activeToplevel: { address: '456', lastIpcObject: { class: 'companion' } },
  };
  const context = { root, native, Hyprland, insertDeadline: { stop() {} } };
  const method = (name: string) => {
    const body = source.match(
      new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`),
    )?.[0];
    assert.ok(body, name);
    return runInNewContext('(' + body + ')', context) as (...args: any[]) => void;
  };
  root.isNativeWindow = method('isNativeWindow');
  root.insertionError = method('insertionError');
  return { root, native, Hyprland, requests, method };
}

test('native handoff keeps the shell observer from reclaiming conversation ownership', () => {
  const setup = fixture();
  setup.root.send = () => assert.fail('observer must not report its old selection');
  setup.method('reportPanelState')();
});

test('native history insertion waits for both Qt focus-out and the compositor target', () => {
  const setup = fixture();
  const finish = setup.method('finishNativeInsert');
  finish();
  assert.equal(setup.requests.length, 0);
  assert.ok(setup.root.pendingHistoryInsert);
  setup.Hyprland.activeToplevel = { address: '123', lastIpcObject: { class: 'editor' } };
  setup.native.status.active = true;
  finish();
  assert.equal(setup.requests.length, 0);
  setup.native.status.active = false;
  finish();
  assert.deepEqual(JSON.parse(JSON.stringify(setup.requests)), [
    { action: 'paste-after-release', id: 'utterance', target: '0x123' },
  ]);
  assert.equal(setup.root.pendingHistoryInsert, null);
  finish();
  assert.equal(setup.requests.length, 1);
});

test('native history insertion cancels when focus moves to another application', () => {
  const setup = fixture();
  setup.Hyprland.activeToplevel = { address: '999', lastIpcObject: { class: 'editor' } };
  setup.method('finishNativeInsert')();
  assert.equal(setup.requests.length, 0);
  assert.equal(setup.root.pendingHistoryInsert, null);
  assert.equal(setup.root.lastErrorAction, 'paste');
});

test('Activity text waits for focus release and keeps its original text and target', () => {
  const setup = fixture();
  setup.root.pendingHistoryInsert = {
    action: 'submit-utterance',
    text: 'new session inspect this',
    target: '0x123',
    restoring: true,
  };
  const finish = setup.method('finishNativeInsert');
  finish();
  assert.equal(setup.requests.length, 0);
  setup.Hyprland.activeToplevel = { address: '123', lastIpcObject: { class: 'editor' } };
  finish();
  assert.deepEqual(JSON.parse(JSON.stringify(setup.requests)), [
    { action: 'utterance-after-release', text: 'new session inspect this', target: '0x123' },
  ]);
  finish();
  assert.equal(setup.requests.length, 1);
});

test('Activity text focus failure returns the draft instead of submitting to a different app', () => {
  const setup = fixture();
  setup.root.pendingHistoryInsert = {
    action: 'submit-utterance',
    text: 'insert retained',
    target: '0x123',
    restoring: true,
  };
  setup.Hyprland.activeToplevel = { address: '999', lastIpcObject: { class: 'editor' } };
  setup.method('finishNativeInsert')();
  const [result] = setup.requests as { action: string; text: string; error: string }[];
  assert.equal(result.action, 'utterance-failed');
  assert.equal(result.text, 'insert retained');
  assert.match(result.error, /Focus changed/);
});
