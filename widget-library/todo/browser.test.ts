import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { Chromium } from '../../src/widgets/chromium.ts';

// Synthetic data in isolated headless Chromium; never uses the user's browser.
test('todo redesign preserves drafts, actions and responsive layout', async () => {
  const browser = new Chromium();
  const source = await readFile(new URL('./widget.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  try {
    const page = await browser.page();
    await page.document(`<!doctype html><style>:root{--foreground:#cdd6f4;--background:#202028;--muted:#a6adc8;background:var(--background);font-size:16px}body{margin:0;padding:12px}${css}</style><div id="root"></div><script type="module">
      import * as widget from ${JSON.stringify(moduleUrl)};
      window.props = {title:'Companion feature ideas',items:[{id:'a',text:'Add model switcher at the bottom',completed:false},{id:'b',text:'Make sessions reorderable',completed:false},{id:'c',text:'Resize the activity sidebar',completed:true}]};
      let sequence = 0;
      window.fail = false;
      window.delay = false;
      window.pending = Promise.resolve();
      const api = {call(action,args) {
        return window.pending = (async () => {
          if(window.delay) await new Promise(resolve => {window.release=resolve});
          if(window.fail) throw Error('Synthetic failure');
          window.props = widget.actions[action](structuredClone(props),args,{requestId:'new-'+(++sequence)}).props;
          view.update(props);
        })();
      }};
      const view = widget.mount(document.getElementById('root'),api);
      window.refresh = () => view.update(props);
      refresh();
      window.ready = true;
    </script>`);
    for (
      let attempt = 0;
      attempt < 50 && !(await page.evaluate('window.ready === true'));
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await page.evaluate('window.ready === true'), true);
    const settle = async () =>
      page.evaluate('pending.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,0)))');
    const cardFontSize = async () =>
      Number(
        await page.evaluate(
          "parseFloat(getComputedStyle(document.querySelector('.todo-card')).fontSize)",
        ),
      );
    assert.ok(Math.abs((await cardFontSize()) - 16 * 1.204 * 0.9) < 0.01);
    await page.evaluate(
      `document.querySelector('form input').value='My draft'; props.textScale=1.2; refresh()`,
    );
    assert.ok(Math.abs((await cardFontSize()) - 16 * 1.204 * 1.2) < 0.01);
    assert.equal(
      await page.evaluate('getComputedStyle(document.documentElement).fontSize'),
      '16px',
    );
    assert.equal(await page.evaluate("document.querySelector('form input').value"), 'My draft');
    await page.evaluate(
      `delay=true; document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit(); release()`,
    );
    await settle();
    assert.equal(await page.evaluate('props.items.length'), 4);
    await page.evaluate(`delay=false; document.querySelector('.check-circle').click()`);
    await settle();
    assert.equal(await page.evaluate('props.items[0].completed'), true);
    assert.equal(
      await page.evaluate("document.querySelector('.progress').textContent"),
      '2 / 4 done',
    );
    await page.evaluate(`fail=true; document.querySelector('.check-circle').click()`);
    await settle();
    assert.equal(await page.evaluate("document.querySelector('.check-circle').checked"), true);
    assert.match(
      String(await page.evaluate("document.querySelector('.message').textContent")),
      /Could not save/,
    );
    await page.evaluate(
      `document.querySelector('form input').value='Keep me'; document.querySelector('form').requestSubmit()`,
    );
    await settle();
    assert.equal(await page.evaluate("document.querySelector('form input').value"), 'Keep me');
    await page.evaluate(`fail=false; document.querySelector('.item-text').click()`);
    assert.equal(
      await page.evaluate('props.items[0].completed'),
      true,
      'editing must not toggle completion',
    );
    await page.evaluate(
      `document.querySelector('.item-editor input').value='Edited task'; props.textScale=0.85; refresh()`,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'Edited task',
    );
    await page.evaluate(
      `delay=true; document.querySelector('.item-editor').requestSubmit(); document.querySelector('.item-editor').requestSubmit(); release()`,
    );
    await settle();
    assert.equal(await page.evaluate('props.items[0].text'), 'Edited task');
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), true);
    await page.evaluate(
      `delay=false; fail=true; document.querySelector('.item-text').click(); document.querySelector('.item-editor input').value='Unsaved edit'; document.querySelector('.item-editor').requestSubmit()`,
    );
    await settle();
    assert.equal(
      await page.evaluate("document.querySelector('.item-editor input').value"),
      'Unsaved edit',
    );
    assert.equal(await page.evaluate('props.items[0].text'), 'Edited task');
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), false);
    await page.evaluate(
      `document.querySelector('.item-editor input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`,
    );
    assert.equal(await page.evaluate("document.querySelector('.item-editor').hidden"), true);
    await page.evaluate(
      `fail=false; document.querySelector('.item-text').click(); document.querySelector('.item-editor input').value='   '; document.querySelector('.item-editor').requestSubmit()`,
    );
    assert.equal(await page.evaluate('props.items[0].text'), 'Edited task');
    assert.match(
      String(await page.evaluate("document.querySelector('.message').textContent")),
      /cannot be empty/,
    );
    await page.evaluate(`props.items[0].text='Long'.repeat(75); refresh()`);
    for (const width of [240, 320, 480, 800]) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 280,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const fontSize of [16, 24]) {
        await page.evaluate(`document.documentElement.style.fontSize='${fontSize}px'`);
        for (const textScale of [0.75, 0.9, 1.5]) {
          await page.evaluate(`props.textScale=${textScale}; refresh()`);
          assert.equal(
            await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),
            true,
            `overflow at ${width}/${fontSize}/${textScale}`,
          );
        }
      }
    }
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 420,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(
      `document.documentElement.style.fontSize='16px'; props.textScale=0.9; props.items[0].text='Add model switcher at the bottom'; document.querySelector('.message').textContent=''; refresh()`,
    );
    const screenshot = await page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      '/tmp/companion-todo-redesign.png',
      Buffer.from(String(screenshot.data), 'base64'),
    );
    await page.evaluate('props.items=[]; refresh()');
    assert.equal(await page.evaluate("document.querySelector('.empty').hidden"), false);
    assert.equal(await page.evaluate("document.querySelectorAll('.todo-row').length"), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});
