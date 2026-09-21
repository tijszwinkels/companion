// Run only inside nested-hyprland.py. This browser owns disposable, local fields;
// no real Companion listener, history, clipboard, or conversation is involved.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { command } from '../../src/system/command.ts';
import { typeText } from '../../src/system/type-text.ts';
import { activeWindow } from '../../src/sensors/screen/capture.ts';

assert.equal(process.env.COMPANION_TEST_NESTED, '1');
const { chromium } = await import(process.env.COMPANION_TEST_PLAYWRIGHT);
const signal = AbortSignal.timeout(60000);
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: false,
  args: ['--ozone-platform=wayland'],
});

async function focus(page, address) {
  // Playwright's tab activation does not guarantee native Wayland window focus.
  // Ask only our private compositor, then verify what the writer will observe.
  await command(
    'hyprctl',
    ['eval', `hl.dispatch(hl.dsp.focus({ window = "address:${address}" }))`],
    signal,
  );
  await page.locator('textarea').click();
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await activeWindow(signal)).address === address) {
      return;
    }
    await delay(25);
  }
  assert.fail('Nested editor did not receive compositor focus');
}

try {
  console.log(`EDITOR Chromium ${browser.version()}`);
  const page = await browser.newPage();
  const title = `Companion delivery test ${process.pid}`;
  await page.setContent(`<title>${title}</title><textarea autofocus></textarea>`);
  await page.locator('textarea').click();
  await page.evaluate(() => {
    window.events = [];
    for (const kind of ['keydown', 'keyup', 'beforeinput', 'input']) {
      document.addEventListener(kind, (event) => {
        window.events.push({
          type: event.type,
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          inputType: event.inputType,
          data: event.data,
          value: document.querySelector('textarea').value,
        });
      });
    }
  });

  let target;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    const windows = JSON.parse((await command('hyprctl', ['-j', 'clients'], signal)).toString());
    target = windows.find((window) => window.title.startsWith(title));
    await delay(50);
  }
  assert.ok(target);
  assert.equal(target.xwayland, false);

  for (const text of ["let's just keep it open.", 'abcdefghijklm.XYZ', 'abcdefghijklmn.XYZ']) {
    for (const spacing of [1, 50]) {
      await page.locator('textarea').fill('');
      await page.evaluate(() => {
        window.events = [];
      });
      await command('wtype', ['-d', String(spacing), '--', text], signal);
      await delay(150);
      console.log(
        JSON.stringify({
          path: 'raw-wtype',
          spacing,
          text,
          actual: await page.locator('textarea').inputValue(),
          events: await page.evaluate(() =>
            window.events.filter(
              (event) => event.code === 'Backspace' || event.inputType === 'deleteContentBackward',
            ),
          ),
        }),
      );
    }
  }

  await page.locator('textarea').fill('');
  const text = "let's just keep it open.";
  const delivered = await typeText(text, target.address, signal);
  await delay(150);
  console.log(
    JSON.stringify({
      path: 'shared-typeText',
      delivered,
      text,
      actual: await page.locator('textarea').inputValue(),
    }),
  );

  if (process.env.COMPANION_TEST_WTYPE) {
    // The candidate is private to this test; the installed executable and the
    // running Companion process are unchanged. Route only this call's wtype.
    const candidate = process.env.COMPANION_TEST_WTYPE;
    const run = (file, args, signal) => command(file === 'wtype' ? candidate : file, args, signal);
    const printableAscii = Array.from({ length: 95 }, (_, index) =>
      String.fromCharCode(32 + index),
    ).join('');
    const cases = [
      "let's just keep it open.",
      'abcdefghijklm.XYZ',
      'abcdefghijklmn.XYZ',
      '-k Return; café — naïve! Ελληνικά Next field',
      '.,;:!? /\\ \'" []{}<> () @#$%^&* _+-=~`',
      printableAscii,
      [...printableAscii].reverse().join(''),
      printableAscii + ' a~b}c|'.repeat(30),
      'abcXYZ café — Ελληνικά '.repeat(60),
      'Literal\nnewlines\tand\rcontrols\u001bmust stay text.',
    ];

    for (const text of cases) {
      const prefix = 'Existing draft: ';
      await page.locator('textarea').fill(prefix);
      await page.evaluate(() => {
        window.events = [];
      });
      const delivered = await typeText(text, target.address, signal, run);
      await delay(150);
      const expected = prefix + text.replace(/[\u0000-\u001f\u007f]/g, ' ');
      const actual = await page.locator('textarea').inputValue();
      assert.equal(delivered, true);
      assert.equal(actual, expected);
      const harmful = await page.evaluate(() =>
        window.events.filter(
          (event) =>
            event.inputType?.startsWith('delete') || event.key === 'Enter' || event.key === 'Tab',
        ),
      );
      assert.deepEqual(harmful, []);
      console.log(`PASS candidate ${text.length} characters, exact append, no deletion/Enter/Tab`);
    }

    // Exercise the same separate `-k Return` process that the Enter intent uses.
    // Its upstream physical code is Escape; verify the browser actually inserts
    // one newline and retains focus, rather than inferring success from keysyms.
    await focus(page, target.address);
    await page.locator('textarea').fill('Existing draft: ');
    await page.evaluate(() => {
      window.events = [];
    });
    assert.equal(
      await typeText(
        'Submit this.',
        target.address,
        signal,
        run,
        () => true,
        () => {},
        true,
      ),
      true,
    );
    await page.waitForFunction(
      () => document.querySelector('textarea').value === 'Existing draft: Submit this.\n',
    );
    assert.equal(
      await page.evaluate(() => document.activeElement === document.querySelector('textarea')),
      true,
    );
    const enterEvents = await page.evaluate(() =>
      window.events.filter((event) => event.type === 'keydown' && event.key === 'Enter'),
    );
    assert.equal(enterEvents.length, 1);
    assert.equal(
      await page.evaluate(() =>
        window.events.some(
          (event) => event.key === 'Escape' || event.inputType?.startsWith('delete'),
        ),
      ),
      false,
    );
    console.log(
      `PASS explicit Enter: exact newline, retained focus; ${JSON.stringify(enterEvents)}`,
    );

    // A second disposable window exercises the actual compositor focus guard.
    const other = await browser.newPage();
    await other.setContent('<title>Companion delivery other</title><textarea></textarea>');
    await other.locator('textarea').click();
    await delay(150);
    const clients = JSON.parse((await command('hyprctl', ['-j', 'clients'], signal)).toString());
    const otherWindow = clients.find((window) =>
      window.title.startsWith('Companion delivery other'),
    );
    assert.ok(otherWindow);
    await focus(other, otherWindow.address);
    assert.equal(await typeText('Must not appear.', target.address, signal, run), false);
    assert.equal(await other.locator('textarea').inputValue(), '');
    console.log('PASS focus changed before delivery: no text');

    await focus(page, target.address);
    await page.locator('textarea').fill('Draft: ');
    await page.evaluate(() => {
      window.events = [];
    });
    const controller = new AbortController();
    const cancelledSignal = AbortSignal.any([signal, controller.signal]);
    const interrupted = typeText(
      'long text '.repeat(300),
      target.address,
      cancelledSignal,
      run,
      () => true,
      () => {},
      true,
    ).then(
      () => null,
      (error) => error,
    );
    await page.waitForFunction(
      () => document.querySelector('textarea').value.length > 30,
      undefined,
      { timeout: 3000 },
    );
    controller.abort(Error('Fixture cancellation'));
    assert.ok(await interrupted);
    const partial = await page.locator('textarea').inputValue();
    await delay(100);
    assert.equal(await page.locator('textarea').inputValue(), partial);
    assert.ok(partial.startsWith('Draft: '));
    assert.ok(partial.length < 3007);
    assert.equal(
      await page.evaluate(() => window.events.some((event) => event.key === 'Enter')),
      false,
    );
    console.log('PASS cancellation stops typing and suppresses explicit Enter');

    // Move focus after the text command completes, before the optional Enter.
    await page.locator('textarea').fill('Draft: ');
    const moveAfterTyping = async (file, args, signal) => {
      const result = await run(file, args, signal);
      if (file === 'wtype') {
        await focus(other, otherWindow.address);
      }
      return result;
    };
    await assert.rejects(
      typeText(
        'Keep this draft.',
        target.address,
        signal,
        moveAfterTyping,
        () => true,
        () => {},
        true,
      ),
    );
    assert.equal(await page.locator('textarea').inputValue(), 'Draft: Keep this draft.');
    assert.equal(await other.locator('textarea').inputValue(), '');
    console.log('PASS focus changed after typing: Enter suppressed');

    // Supplementary Unicode truncation is a separate Chromium KeyEvent issue.
    // Report it explicitly; do not count this candidate as fixing all Unicode.
    await focus(page, target.address);
    await page.locator('textarea').fill('');
    await typeText('🙂', target.address, signal, run);
    await delay(100);
    console.log(
      JSON.stringify({
        knownLimitation: 'non-BMP Chromium text',
        expected: '🙂',
        actual: await page.locator('textarea').inputValue(),
      }),
    );
  } else {
    // Without a candidate executable this is a normal failing regression for
    // the installed writer, not a successful test merely because it ran.
    assert.equal(await page.locator('textarea').inputValue(), text);
  }
} finally {
  await browser.close();
}
