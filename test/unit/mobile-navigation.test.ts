import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Navigation, type PhonePage } from '../../integrations/mobile/src/navigation.ts';

/** Browser history double with explicitly delayed traversal, as real Back has. */
function historyFixture(context: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  const entries: unknown[] = [null];
  let position = 0;
  let pending = 0;
  const history = {
    get state() {
      return entries[position];
    },
    replaceState(state: unknown) {
      entries[position] = structuredClone(state);
    },
    pushState(state: unknown) {
      entries.splice(position + 1);
      entries.push(structuredClone(state));
      position += 1;
    },
    back() {
      pending += 1;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(target, { history }),
  });
  context.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'window', original);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });
  const pages: PhonePage[] = [];
  const navigation = new Navigation((page) =>
    pages.push({ selected: page.selected, showingPrevious: page.showingPrevious }),
  );
  function traverse() {
    assert.ok(pending > 0);
    pending -= 1;
    position = Math.max(0, position - 1);
    target.dispatchEvent(Object.assign(new Event('popstate'), { state: entries[position] }));
  }
  return { navigation, pages, traverse };
}

test('navigation from a modal action waits until Back consumes the modal entry', (context) => {
  const { navigation, pages, traverse } = historyFixture(context);
  navigation.navigate({ selected: 'conversation', showingPrevious: false });
  let closed = 0;
  const modal = navigation.openModal(() => {
    closed += 1;
  });
  modal.dismiss();
  navigation.navigate({ selected: '', showingPrevious: true });
  assert.equal(closed, 0);
  assert.equal(pages.at(-1)?.selected, 'conversation');
  traverse();
  assert.equal(closed, 1);
  assert.deepEqual(pages.at(-1), { selected: '', showingPrevious: true });
  window.history.back();
  traverse();
  assert.equal(pages.at(-1)?.selected, 'conversation');
});

test('a second modal opened during dismissal survives the pending Back', (context) => {
  const { navigation, traverse } = historyFixture(context);
  navigation.navigate({ selected: 'conversation', showingPrevious: false });
  const first = navigation.openModal(() => {});
  first.release();
  let secondClosed = 0;
  const second = navigation.openModal(() => {
    secondClosed += 1;
  });
  traverse();
  assert.equal(secondClosed, 0);
  second.dismiss();
  traverse();
  assert.equal(secondClosed, 1);
});

test('sign-out invalidates route entries even when a dismissal is already queued', (context) => {
  const { navigation, pages, traverse } = historyFixture(context);
  navigation.navigate({ selected: 'private-conversation-id', showingPrevious: false });
  const modal = navigation.openModal(() => {});
  modal.dismiss();
  navigation.reset();
  traverse();
  assert.deepEqual(pages.at(-1), { selected: '', showingPrevious: false });
});
