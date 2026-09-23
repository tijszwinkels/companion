import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { Chromium, type BrowserPage } from '../../src/widgets/chromium.ts';
import { WidgetService } from '../../src/widgets/service.ts';

// All browser input uses private CDP pipes; all saved state is synthetic.
async function fixture() {
  const browser = new Chromium();
  const source = await readFile(new URL('./widget.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const page = await browser.page();
  await page.call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.document(`<!doctype html><style>:root{--foreground:#cdd6f4;--background:#1e1e2e;--muted:#a6adc8;background:var(--background);font-size:16px}body{margin:0;padding:12px}${css}</style><div id="root"></div><script type="module">
    import * as widget from ${JSON.stringify(moduleUrl)};
    window.props = {title:'Synthetic checklist',items:[{id:'a',text:'First task',completed:false},{id:'b',text:'Second task',completed:false}]};
    window.calls = [];
    window.fail = false;
    window.delay = false;
    window.commitThenFail = false;
    window.delayReply = false;
    window.pending = Promise.resolve();
    const api = {call(action,args) {
      calls.push({action,args});
      return window.pending = (async () => {
        if(window.delay) await new Promise(resolve => {window.release=resolve});
        if(window.fail) throw Error('Synthetic failure');
        window.props = widget.actions[action](structuredClone(props),args,{requestId:'new-'+calls.length}).props;
        refresh();
        if(window.delayReply) await new Promise(resolve => {window.reply=resolve});
        if(window.commitThenFail) throw Error('Synthetic lost acknowledgement');
      })();
    }};
    const view = widget.mount(document.getElementById('root'),api);
    window.refresh = () => view.update(props);
    refresh();
    window.ready = true;
  </script>`);
  await waitFor(page, 'window.ready === true');
  return { browser, page };
}

async function waitFor(page: BrowserPage, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate(expression)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out: ' + expression);
}

async function click(page: BrowserPage, selector: string) {
  const point = (await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({block:'nearest'});
    const box = element.getBoundingClientRect();
    return {x:box.x+box.width/2, y:box.y+box.height/2};
  })()`)) as { x: number; y: number };
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.call('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 });
  }
}

async function key(page: BrowserPage, name: string, code: number, modifiers = 0) {
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: name,
    windowsVirtualKeyCode: code,
    modifiers,
    ...(name === 'Enter' ? { text: '\r' } : {}),
  });
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: name,
    windowsVirtualKeyCode: code,
    modifiers,
  });
}

async function type(page: BrowserPage, text: string) {
  await key(page, 'a', 65, 2);
  await key(page, 'Backspace', 8);
  if (text) {
    await page.call('Input.insertText', { text });
  }
}

async function settle(page: BrowserPage) {
  await page.evaluate(
    'pending.catch(()=>{}).then(()=>new Promise(resolve=>setTimeout(resolve,0)))',
  );
}

const draft = '.item-editor input';
const notice = "document.querySelector('.edit-notice').textContent";
const message = "document.querySelector('.message').textContent";

test('real browser keys validate, preserve drafts, reject duplicate saves and cancel in the pop-out', async () => {
  const { browser, page } = await fixture();
  try {
    assert.ok(
      Math.abs(
        Number(
          await page.evaluate(
            "parseFloat(getComputedStyle(document.querySelector('.todo-card')).fontSize)",
          ),
        ) -
          16 * 1.204 * 0.9,
      ) < 0.01,
    );
    await click(page, 'form input');
    await key(page, 'Enter', 13);
    assert.match(String(await page.evaluate(message)), /cannot be empty/);
    await type(page, 'New draft');
    assert.equal(await page.evaluate(message), '');
    await page.evaluate('delay=true');
    await key(page, 'Enter', 13);
    await key(page, 'Enter', 13);
    assert.equal(await page.evaluate('calls.length'), 1);
    await page.evaluate('release()');
    await settle(page);
    assert.equal(await page.evaluate('props.items.length'), 3);
    await page.evaluate('delay=false');
    await click(page, '.item-text');
    assert.equal(await page.evaluate('props.items[0].completed'), false);
    assert.equal(
      await page.evaluate("document.querySelector('.item-text').getAttribute('aria-label')"),
      'Edit: First task',
    );
    for (const value of ['', '   ']) {
      await type(page, value);
      await key(page, 'Enter', 13);
      assert.match(String(await page.evaluate(notice)), /cannot be empty/);
      assert.equal(await page.evaluate('calls.length'), 1);
    }
    await type(page, 'Edited task');
    assert.equal(await page.evaluate(notice), '');
    await page.evaluate(
      'props.textScale=1.2; props.title="Unrelated update"; refresh(); delay=true',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'Edited task',
    );
    await key(page, 'Enter', 13);
    await key(page, 'Enter', 13);
    assert.equal(await page.evaluate('calls.length'), 2);
    assert.equal(
      await page.evaluate(
        "document.activeElement === document.querySelector('.item-editor input')",
      ),
      true,
    );
    await page.evaluate('release()');
    await settle(page);
    assert.equal(await page.evaluate('props.items[0].text'), 'Edited task');
    assert.equal(
      await page.evaluate("document.activeElement === document.querySelector('.item-text')"),
      true,
    );
    await key(page, 'Enter', 13);
    await type(page, 'Unsent pop-out draft');
    await key(page, 'Escape', 27);
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), true);
    assert.equal(await page.evaluate('props.items[0].text'), 'Edited task');
    await key(page, 'Enter', 13);
    await type(page, 'Keep on failure');
    await page.evaluate('delay=false; fail=true');
    await key(page, 'Enter', 13);
    await settle(page);
    assert.match(String(await page.evaluate(notice)), /Could not save/);
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'Keep on failure',
    );
    await type(page, 'Another draft');
    assert.equal(await page.evaluate(notice), '');
  } finally {
    await browser.close();
  }
});

test('same-item renames before and during save need a fresh deliberate confirmation', async () => {
  const { browser, page } = await fixture();
  try {
    await click(page, '.item-text');
    await type(page, 'My draft');
    await page.evaluate('props.items[0].text="Remote rename"; refresh()');
    assert.match(String(await page.evaluate(notice)), /Remote rename/);
    await key(page, 'Enter', 13);
    assert.equal(
      await page.evaluate('calls.length'),
      0,
      'First save only acknowledges the displayed conflict',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor button').textContent"),
      'Replace saved text',
    );
    // A second rename invalidates the first confirmation. Unrelated updates do not.
    await page.evaluate('props.items[0].text="Remote again"; refresh()');
    await key(page, 'Enter', 13);
    assert.equal(await page.evaluate('calls.length'), 0);
    await page.evaluate(
      'props.items[1].text="Unrelated task"; props.title="Unrelated title"; refresh(); delay=true',
    );
    await key(page, 'Enter', 13);
    assert.equal(await page.evaluate('calls.length'), 1);
    assert.equal(await page.evaluate('calls[0].args.expectedText'), 'Remote again');
    // The reducer sees a rename arriving after the UI has dispatched its save.
    await page.evaluate('props.items[0].text="During save"; refresh(); release()');
    await settle(page);
    assert.equal(await page.evaluate('props.items[0].text'), 'During save');
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'My draft',
    );
    assert.match(String(await page.evaluate(notice)), /During save/);
    await key(page, 'Enter', 13);
    assert.equal(await page.evaluate('calls.length'), 1);
    await page.evaluate('delay=false');
    await key(page, 'Enter', 13);
    await settle(page);
    assert.equal(await page.evaluate('props.items[0].text'), 'My draft');
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), true);
  } finally {
    await browser.close();
  }
});

test('reorder, removal, pending completion and ambiguous add failures retain useful state', async () => {
  const { browser, page } = await fixture();
  try {
    await click(page, '.check-circle');
    await settle(page);
    await click(page, '.item-text');
    await type(page, 'Recovery draft');
    await page.evaluate(
      "document.activeElement.setSelectionRange(2,7,'backward'); props.items.reverse(); refresh()",
    );
    assert.deepEqual(
      await page.evaluate(
        '({value:document.activeElement.value,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,direction:document.activeElement.selectionDirection})',
      ),
      { value: 'Recovery draft', start: 2, end: 7, direction: 'backward' },
    );
    await page.evaluate('delay=true');
    await key(page, 'Enter', 13);
    await page.evaluate(
      'props.items=props.items.filter(item=>item.id!=="a"); refresh(); release()',
    );
    await settle(page);
    assert.equal(await page.evaluate('document.activeElement.value'), 'Recovery draft');
    assert.match(
      String(
        await page.evaluate(
          "document.querySelector('.item-editor:not([hidden]) .edit-notice').textContent",
        ),
      ),
      /removed.*copy/,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor:not([hidden]) button').disabled"),
      true,
    );
    await click(page, '.item-editor:not([hidden]) button[type=button]');
    assert.equal(
      await page.evaluate("document.activeElement.getAttribute('aria-label')"),
      'New todo',
    );
    // The remaining task's optimistic checkbox must not flicker on title updates.
    await click(page, '.check-circle');
    await page.evaluate('props.title="Title changed"; refresh()');
    assert.equal(await page.evaluate("document.querySelector('.check-circle').checked"), true);
    await page.evaluate('fail=true; release()');
    await settle(page);
    assert.equal(await page.evaluate("document.querySelector('.check-circle').checked"), false);
    assert.match(String(await page.evaluate(message)), /Could not save/);
    await click(page, 'form input');
    await type(page, 'Uncertain addition');
    assert.equal(await page.evaluate(message), '');
    await page.evaluate('delay=false; fail=false; commitThenFail=true');
    await key(page, 'Enter', 13);
    await settle(page);
    assert.equal(await page.evaluate('props.items.length'), 2);
    assert.equal(
      await page.evaluate("document.querySelector('form input').value"),
      'Uncertain addition',
    );
    assert.match(String(await page.evaluate(message)), /Check the list before adding it again/);
    assert.equal(await page.evaluate('calls.filter(call=>call.action==="add_item").length'), 1);
  } finally {
    await browser.close();
  }
});

test('completion acknowledgement reconciles a newer saved value without pending flicker', async () => {
  const { browser, page } = await fixture();
  try {
    await page.evaluate('delayReply=true');
    await click(page, '.check-circle');
    await waitFor(page, 'typeof reply === "function"');
    assert.equal(await page.evaluate('props.items[0].completed'), true);

    // Another writer commits before the viewer finishes the action round trip.
    // The host delivers these props while the checkbox is still disabled.
    await page.evaluate('props.items[0].completed=false; refresh()');
    assert.equal(await page.evaluate("document.querySelector('.check-circle').checked"), true);
    await page.evaluate('reply()');
    await settle(page);

    assert.equal(await page.evaluate('props.items[0].completed'), false);
    assert.equal(await page.evaluate("document.querySelector('.check-circle').checked"), false);
    assert.equal(await page.evaluate("document.querySelector('.check-circle').disabled"), false);
    assert.equal(
      await page.evaluate("document.querySelector('.check-circle').getAttribute('aria-label')"),
      'Complete: First task',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-text').classList.contains('completed')"),
      false,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.progress').textContent"),
      '0 / 2 done',
    );
  } finally {
    await browser.close();
  }
});

test('restoring an orphaned editor retains the draft and restores the Cancel action', async () => {
  const { browser, page } = await fixture();
  try {
    await click(page, '.item-text');
    await type(page, 'Keep this draft');
    await page.evaluate('props.items=[]; refresh()');
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor button[type=button]').textContent"),
      'Dismiss',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor button[type=submit]').disabled"),
      true,
    );

    await page.evaluate(
      'props.items=[{id:"a",text:"Restored saved text",completed:false}]; refresh()',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'Keep this draft',
    );
    assert.match(String(await page.evaluate(notice)), /Restored saved text/);
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor button[type=button]').textContent"),
      'Cancel',
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor button[type=submit]').disabled"),
      false,
    );
    await click(page, '.item-editor button[type=button]');
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), true);
    assert.equal(await page.evaluate('props.items[0].text'), 'Restored saved text');
    assert.equal(await page.evaluate('calls.length'), 0);
  } finally {
    await browser.close();
  }
});

// Measure the browser's resolved colors, including ancestor transparency and
// color-mix, rather than inferring contrast from CSS variable names.
const contrastScript = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', {willReadFrequently:true});
  const rgba = color => {
    context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1);
    return [...context.getImageData(0,0,1,1).data].map((value,index)=>index===3?value/255:value);
  };
  const over = (front,back) => front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3])).concat(1);
  const background = element => {
    if (!element) return [255,255,255,1];
    return over(rgba(getComputedStyle(element).backgroundColor),background(element.parentElement));
  };
  const luminance = color => color.slice(0,3).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
  const ratio = (first,second) => (Math.max(luminance(first),luminance(second))+0.05)/(Math.min(luminance(first),luminance(second))+0.05);
  const text = selector => {
    const element = document.querySelector(selector);
    const back = background(element);
    return ratio(over(rgba(getComputedStyle(element).color),back),back);
  };
  const checkbox = document.querySelector('.check-circle');
  return {text:Object.fromEntries(['h2','.progress','.item-text','.completed','.message','.edit-notice','form > button','.item-editor button','.item-editor input'].map(selector=>[selector,text(selector)])),
    boundary:ratio(rgba(getComputedStyle(checkbox).borderColor),background(checkbox.parentElement)),
    checkedMark:ratio(rgba(getComputedStyle(document.querySelector('.check-circle:checked'),'::after').borderLeftColor),background(document.querySelector('.check-circle:checked'))),
    placeholder:ratio(rgba(getComputedStyle(document.querySelector('form input'),'::placeholder').color),background(document.querySelector('form input')))};
})()`;

test('light/dark rendered contrast and the full width/root/textScale matrix preserve controls', async () => {
  const { browser, page } = await fixture();
  try {
    await click(page, '.item-text');
    await type(page, 'Draft');
    await page.evaluate(
      'props.items[0].text="Long".repeat(75); props.items[1].completed=true; refresh(); document.querySelector(".message").textContent="Synthetic error to measure"',
    );
    for (const theme of [
      { name: 'dark', foreground: '#cdd6f4', background: '#1e1e2e', muted: '#a6adc8' },
      { name: 'light', foreground: '#4c4f69', background: '#eff1f5', muted: '#6c6f85' },
    ]) {
      await page.evaluate(
        `for(const [name,value] of Object.entries(${JSON.stringify(theme)})) document.documentElement.style.setProperty('--'+name,value)`,
      );
      const contrast = (await page.evaluate(contrastScript)) as {
        text: Record<string, number>;
        boundary: number;
        checkedMark: number;
        placeholder: number;
      };
      for (const [selector, ratio] of Object.entries(contrast.text)) {
        assert.ok(ratio >= 4.5, `${theme.name} ${selector}: ${ratio}`);
      }
      assert.ok(contrast.boundary >= 3, JSON.stringify(contrast));
      assert.ok(contrast.checkedMark >= 3, JSON.stringify(contrast));
      assert.ok(contrast.placeholder >= 4.5, JSON.stringify(contrast));
      console.log(theme.name + ' rendered contrast: ' + JSON.stringify(contrast));
      for (const width of [240, 320, 480, 800]) {
        await page.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 280,
          deviceScaleFactor: 1,
          mobile: false,
        });
        for (const root of [16, 24]) {
          for (const scale of [0.75, 0.9, 1.5]) {
            await page.evaluate(
              `document.documentElement.style.fontSize='${root}px';props.textScale=${scale};refresh()`,
            );
            assert.equal(
              await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),
              true,
              `${theme.name}/${width}/${root}/${scale}`,
            );
            assert.equal(
              await page.evaluate(
                `Array.from(document.querySelectorAll('button,input')).filter(element=>element.getClientRects().length).every(element=>{const b=element.getBoundingClientRect();return b.left>=0 && b.right<=innerWidth && b.width>0})`,
              ),
              true,
              'Controls must remain reachable horizontally',
            );
          }
        }
      }
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: 480,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.evaluate(
        "document.documentElement.style.fontSize='16px';props.textScale=0.9;refresh()",
      );
      const shot = await page.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        '/tmp/companion-todo-fixed-' + theme.name + '.png',
        Buffer.from(String(shot.data), 'base64'),
      );
    }
    await key(page, 'Escape', 27);
    await page.evaluate('props.items=[]; refresh()');
    assert.equal(await page.evaluate("document.querySelector('.empty').hidden"), false);
    assert.equal(await page.evaluate("document.querySelectorAll('.todo-row').length"), 0);
  } finally {
    await browser.close();
  }
});

test('real persisted actions reject stale revisions and item text while preserving legacy callers', async () => {
  const directory = await mkdtemp('/tmp/companion-todo-conflict-');
  const service = new WidgetService(directory, async () => {});
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    let sequence = 0;
    const command = async (body: object, status = 200) => {
      const response = await fetch(lease.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
        body: JSON.stringify({ requestId: 'conflict-' + ++sequence, ...body }),
      });
      const result = (await response.json()) as any;
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    const created = await command({
      method: 'publish',
      widget: 'todo',
      props: { items: [{ id: 'a', text: 'Original', completed: false }] },
    });
    const rename = (args: object, revision?: number) => ({
      method: 'call',
      id: created.id,
      action: 'rename_item',
      args: { itemId: 'a', ...args },
      ...(revision === undefined ? {} : { revision }),
    });
    const changed = await command(rename({ text: 'Remote' })); // Old callers need no extra argument.
    await command(rename({ text: 'Stale', expectedText: 'Original' }, created.revision), 400);
    await command(rename({ text: 'Stale', expectedText: 'Original' }, changed.revision), 400);
    assert.equal(
      (await command({ method: 'discover', id: created.id })).props.items[0].text,
      'Remote',
    );
    const unrelated = await command({
      method: 'call',
      id: created.id,
      action: 'set_completed',
      args: { itemId: 'a', completed: true },
    });
    const saved = await command(
      rename({ text: 'Confirmed', expectedText: 'Remote' }, unrelated.revision),
    );
    const state = await command({ method: 'discover', id: created.id });
    assert.equal(state.revision, saved.revision);
    assert.deepEqual(state.props.items, [{ id: 'a', text: 'Confirmed', completed: true }]);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
