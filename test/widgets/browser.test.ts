import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { Chromium } from '../../src/widgets/chromium.ts';
import { defaultViewport, widgetDocument } from '../../src/widgets/document.ts';
import { WidgetRegistry } from '../../src/widgets/registry.ts';
import { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import {
  defaultPresentation,
  type WidgetAttachment,
  type WidgetRecord,
} from '../../src/widgets/types.ts';

// These checks start only isolated headless Chromium processes. All input goes
// to their private CDP pipes; no desktop browser, microphone or OS input is used.
test('capture density sharpens frames without changing logical viewport dimensions', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-density-');
  const renderer = new WidgetRenderer();
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(
    directory,
    async (_, value) => {
      reference = value;
    },
    undefined,
    renderer,
  );
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const command = async (body: object) => {
      const response = await fetch(lease.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as any;
    };
    const created = await command({
      method: 'publish',
      widget: 'comparison',
      props: {
        options: [
          { title: 'One', points: ['First'] },
          { title: 'Two', points: ['Second'] },
        ],
      },
      requestId: 'density',
    });
    const inspect = () => command({ method: 'discover', id: created.id });
    assert.equal((await inspect()).lastViewport, null);

    for (const [width, height, pixelRatio, scale] of [
      [320, 180, 1.5, 1],
      [480, 280, 2, 1.5],
    ]) {
      const response = await fetch(
        reference!.viewUrl +
          `/frame?width=${width}&height=${height}&pixelRatio=${pixelRatio}&scale=${scale}`,
      );
      assert.equal(response.status, 200);
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), width * pixelRatio);
      assert.equal(png.readUInt32BE(20), height * pixelRatio);
      assert.deepEqual((await inspect()).lastViewport, {
        widthCssPixels: width,
        heightCssPixels: height,
        textScale: scale,
      });
    }
    for (const pixelRatio of ['0', '3.1', 'NaN', 'Infinity']) {
      const response = await fetch(reference!.viewUrl + '/frame?pixelRatio=' + pixelRatio);
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }
    const bounded = await fetch(reference!.viewUrl + '/frame?width=1600&height=2200&pixelRatio=3');
    assert.equal(bounded.status, 200);
    const large = Buffer.from(await bounded.arrayBuffer());
    assert.ok(large.readUInt32BE(16) > 1600);
    assert.ok(large.readUInt32BE(16) * large.readUInt32BE(20) <= 8_000_000);

    await renderer.discard([created.id]);
    assert.equal(
      (await inspect()).lastViewport,
      null,
      'Evicted view dimensions must not look current',
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real widget publication, direct input, actions, pin transactions and reopen', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-test-');
  const owner = randomUUID();
  const changes = new Map<string, WidgetAttachment>();
  let service = new WidgetService(directory, async (record, reference) => {
    changes.set(record.id, reference);
  });
  try {
    const controller = new AbortController();
    const lease = await service.lease(owner, controller.signal);
    let sequence = 0;
    async function command(body: object, status = 200) {
      const response = await fetch(lease.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
        body: JSON.stringify({ requestId: 'test-' + ++sequence, ...body }),
      });
      const result = (await response.json()) as any;
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }
    const created = await command({
      method: 'publish',
      widget: 'todo',
      props: {
        title: 'Release checklist',
        items: [{ id: 'one', text: 'Render an actual browser widget', completed: false }],
      },
      requestId: 'publish',
    });
    assert.equal(
      (await command({ method: 'publish', widget: 'todo', props: {}, requestId: 'publish' })).id,
      created.id,
    );
    const reference = changes.get(created.id)!;
    const frame = await fetch(reference.viewUrl + '/frame?width=480&height=280');
    assert.equal(frame.status, 200);
    const png = Buffer.from(await frame.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    await writeFile('/tmp/companion-widget-todo.png', png);
    const state = async () => (await (await fetch(reference.viewUrl + '/state')).json()) as any;
    const input = async (body: object) => {
      const response = await fetch(reference.viewUrl + '/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.text());
    };
    // Coordinates refer to the rendered checkbox, not a DOM script click.
    await input({ type: 'mousePressed', x: 24, y: 63, button: 'left', buttons: 1 });
    await input({ type: 'mouseReleased', x: 24, y: 63, button: 'left', buttons: 0 });
    await (await fetch(reference.viewUrl + '/frame')).arrayBuffer();
    assert.equal((await state()).props.items[0].completed, true);
    const added = await command({
      method: 'call',
      id: created.id,
      action: 'add_item',
      args: { text: 'Keep the state after reopening' },
      requestId: 'add',
    });
    assert.equal(
      (
        await command({
          method: 'call',
          id: created.id,
          action: 'add_item',
          args: { text: 'duplicate' },
          requestId: 'add',
        })
      ).itemId,
      added.itemId,
    );
    assert.equal((await state()).props.items.length, 2);
    await command({ method: 'update', id: created.id, revision: 1, props: { items: [] } }, 400);
    await command({ method: 'call', id: created.id, action: 'run_shell', args: {} }, 400);
    const before = await state();
    await command({ method: 'call', id: created.id, action: 'add_item', args: { text: 42 } }, 400);
    assert.equal((await state()).revision, before.revision);
    await command({
      method: 'update',
      id: created.id,
      revision: before.revision,
      props: { ...before.props, title: 'A revised checklist' },
    });
    assert.equal((await state()).props.title, 'A revised checklist');

    await command({
      method: 'present',
      id: created.id,
      presentation: { placement: 'pinned', heightPercent: 100 },
    });
    const second = await command({
      method: 'publish',
      widget: 'pipeline',
      props: { steps: ['Discover', 'Publish', 'Interact'] },
      presentation: { placement: 'pinned', heightPercent: 25 },
    });
    assert.equal((await state()).presentation.placement, 'inline');
    const disk = JSON.parse(await readFile(join(directory, owner + '.json'), 'utf8'));
    assert.equal(
      disk.filter((record: WidgetRecord) => record.presentation.placement === 'pinned').length,
      1,
    );
    assert.equal(
      disk.find((record: WidgetRecord) => record.id === second.id).presentation.heightPercent,
      25,
    );
    const wrongOrigin = await fetch(reference.viewUrl + '/state', {
      headers: { Origin: 'https://example.invalid' },
    });
    assert.equal(wrongOrigin.status, 403);
    controller.abort();
    await command({ method: 'discover' }, 403);
    await service.close();
    service = new WidgetService(directory, async () => {});
    const restored = await service.restored(owner);
    const reopened = restored.find(({ record }) => record.id === created.id)!;
    assert.equal(
      reopened.record.props.items instanceof Array && reopened.record.props.items.length,
      2,
    );
    assert.notEqual(reopened.reference.viewUrl, reference.viewUrl);
    assert.equal((await fetch(reopened.reference.viewUrl + '/frame')).status, 200);
    await service.deactivate(owner);
    assert.equal((await fetch(reopened.reference.viewUrl + '/state')).status, 404);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('all bundled widgets render, WebGL draws pixels, and capture latency is measured', async (context) => {
  const directory = await mkdtemp('/tmp/companion-widget-render-');
  const registry = new WidgetRegistry(directory);
  const renderer = new WidgetRenderer();
  const browser = new Chromium();
  try {
    const names = ['todo', 'bar-chart', 'pipeline', 'comparison', 'webgl-cube'];
    for (const name of names) {
      const bundle = await registry.load(name);
      const record: WidgetRecord = {
        id: randomUUID(),
        owner: randomUUID(),
        name,
        bundle: bundle.hash,
        props: registry.validate(bundle.manifest.parameters, bundle.manifest.example),
        revision: 1,
        text: '',
        receipts: [],
        presentation: defaultPresentation,
      };
      assert.ok((await renderer.describe(record, bundle)).length);
      const frames = [];
      for (let index = 0; index < 5; index++) {
        const start = performance.now();
        const png = await renderer.frame(record, bundle, defaultViewport);
        frames.push(Math.round(performance.now() - start));
        assert.ok(png.length > 1000);
        if (!index) {
          await writeFile('/tmp/companion-widget-' + name + '.png', png);
        }
      }
      context.diagnostic(name + ' capture ms: ' + frames.join(', '));
      assert.ok((await renderer.layout(record, bundle, { ...defaultViewport, scale: 1.5 })) > 40);
      if (name === 'webgl-cube') {
        // Instrument only this test copy inside the same production sandbox.
        const probeBundle = {
          ...bundle,
          javascript: `export function describe(){const gl=document.createElement('canvas').getContext('webgl');if(!gl)throw Error('No WebGL');gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return JSON.stringify([...pixel]);} export function mount(){return {update(){}};}`,
        };
        const page = await browser.page();
        await page.document(await widgetDocument(probeBundle, record, defaultViewport));
        const pixel = JSON.parse(
          String(await page.evaluate('window.widgetHost.command({kind:"describe",props:{}})')),
        );
        assert.ok(pixel[0] >= 63 && pixel[0] <= 64);
        assert.ok(pixel[1] >= 127 && pixel[1] <= 128);
        assert.ok(pixel[2] >= 191 && pixel[2] <= 192);
        assert.equal(pixel[3], 255);
        await page.close();
      }
    }
  } finally {
    await renderer.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('opaque widgets cannot read their host, load resources or poison later renderer work', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-isolation-');
  const registry = new WidgetRegistry(directory);
  const renderer = new WidgetRenderer();
  try {
    const original = await registry.load('todo');
    const record: WidgetRecord = {
      id: randomUUID(),
      owner: randomUUID(),
      name: 'todo',
      bundle: original.hash,
      props: { title: 'To do', items: [] },
      revision: 1,
      text: '',
      receipts: [],
      presentation: defaultPresentation,
    };
    const malicious = {
      ...original,
      javascript: `
      export async function describe() {
        let host = false;
        try { host = !!parent.document.body; } catch {}
        const network = await fetch('http://127.0.0.1:1/private').then(() => true, () => false);
        const file = await fetch('file:///etc/passwd').then(() => true, () => false);
        return JSON.stringify({host, network, file, process: typeof process, require: typeof require});
      }
      export function mount() { return {update(){}}; }
    `,
    };
    assert.deepEqual(JSON.parse(await renderer.describe(record, malicious)), {
      host: false,
      network: false,
      file: false,
      process: 'undefined',
      require: 'undefined',
    });
    const stuck = {
      ...original,
      javascript:
        'export function describe(){while(true){}} export function mount(){return {update(){}}}',
    };
    await assert.rejects(
      renderer.describe({ ...record, id: randomUUID() }, stuck),
      /finish|respond|timed out/,
    );
    assert.match(await renderer.describe({ ...record, id: randomUUID() }, original), /To do/);
  } finally {
    await renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the pop-out viewer transport shares changes with the inline view in a second isolated browser', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-viewer-');
  let view: WidgetAttachment | undefined;
  const service = new WidgetService(directory, async (_, reference) => {
    view = reference;
  });
  const browser = new Chromium();
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        props: { items: [{ id: 'test', text: 'Shared state', completed: false }] },
        requestId: 'viewer',
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const url = view!.viewUrl!;
    const page = await browser.page(
      (candidate) => candidate === url || candidate.startsWith(url + '/'),
    );
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 280,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call('Page.navigate', { url });
    for (
      let attempt = 0;
      attempt < 40 && !(await page.evaluate('window.widgetReady === true'));
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await page.evaluate('window.widgetReady === true'), true);
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/companion-widget-popout.png', Buffer.from(String(shot.data), 'base64'));
    await page.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 24,
      y: 56,
      button: 'left',
      clickCount: 1,
    });
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 24,
      y: 56,
      button: 'left',
      clickCount: 1,
    });
    let state: any;
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await (await fetch(url + '/state')).json();
      if (state.props.items[0].completed) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      state.props.items[0].completed,
      true,
      String(await page.evaluate('document.body.innerText')),
    );
    const addition = await fetch(url + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_item',
        args: { text: 'Added from Companion' },
        requestId: 'inline-add',
      }),
    });
    assert.equal(addition.status, 200, await addition.text());
    const expected = ((await (await fetch(url + '/state')).json()) as any).revision;
    let revision = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      revision = Number(await page.evaluate('revision'));
      if (revision === expected) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(revision, expected, String(await page.evaluate('document.body.innerText')));
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// A synthetic widget with rem-based heading/body text, a per-widget typography
// prop and one hardcoded px label. Library widgets follow the same rem pattern.
async function writeTypographyWidget(library: string): Promise<void> {
  const directory = join(library, 'typography');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'widget.json'),
    JSON.stringify({
      name: 'typography',
      version: 1,
      description: 'Synthetic heading, body and fixed label for text scaling checks.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 100 },
          body: { type: 'string', maxLength: 2000 },
          textScale: { type: 'number', minimum: 0.75, maximum: 1.5, default: 1 },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      actions: {},
      example: { title: 'Heading', body: 'Body' },
    }),
  );
  await writeFile(
    join(directory, 'widget.js'),
    `export function describe(props) { return props.title + ': ' + props.body; }
export const actions = {};
export function mount(root) {
  return {
    update(props) {
      root.style.setProperty('--widget-text-scale', String(props.textScale));
      const heading = document.createElement('h2');
      heading.textContent = props.title;
      const body = document.createElement('p');
      body.textContent = props.body;
      const fixed = document.createElement('small');
      fixed.textContent = 'fixed';
      root.replaceChildren(heading, body, fixed);
    },
  };
}
`,
  );
  await writeFile(
    join(directory, 'style.css'),
    `h2 { font-size: calc(1.5rem * var(--widget-text-scale)); margin: 0; }
p { font-size: calc(1rem * var(--widget-text-scale)); margin: 0; }
small { font-size: 12px; }
`,
  );
}

test('Companion text scale reaches captured and pop-out views live without compounding density', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-text-scale-');
  const library = join(directory, 'library');
  await writeTypographyWidget(library);
  let view: WidgetAttachment | undefined;
  const service = new WidgetService(
    directory,
    async (_, reference) => {
      view = reference;
    },
    library,
  );
  const browser = new Chromium();
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const command = async (body: object) => {
      const response = await fetch(lease.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as any;
    };
    const created = await command({
      method: 'publish',
      widget: 'typography',
      props: {
        title: 'Scaled heading',
        body: 'Body text that wraps across several lines at larger sizes. '.repeat(4),
        textScale: 1.25,
      },
      requestId: 'typography',
    });
    const url = view!.viewUrl!;

    // Captured sidebar layout: larger text reflows taller at the same width,
    // while capture density alone changes neither layout nor text size.
    const layout = async (scale: number, pixelRatio: number) => {
      const response = await fetch(
        url + `/layout?width=480&height=280&scale=${scale}&pixelRatio=${pixelRatio}`,
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as { height: number }).height;
    };
    const normalHeight = await layout(1, 1);
    const largeHeight = await layout(2, 1);
    assert.ok(largeHeight > normalHeight * 1.5, `${normalHeight} → ${largeHeight}`);
    assert.equal(await layout(2, 3), largeHeight, 'Capture density must not scale text again');
    assert.equal(await layout(1, 2), normalHeight);

    // Open the viewer as the Chromium pop-out does: no host calls setTheme.
    const page = await browser.page(
      (candidate) => candidate === url || candidate.startsWith(url + '/'),
    );
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 280,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call('Page.navigate', { url });
    for (
      let attempt = 0;
      attempt < 40 && !(await page.evaluate('window.widgetReady === true'));
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await page.evaluate('window.widgetReady === true'), true);

    // The widget runs in a sandboxed, out-of-process iframe. Attach to it
    // directly to read computed sizes in CSS pixels.
    const targets = (await browser.call('Target.getTargets')).targetInfos as any[];
    const frameTarget = targets.find((target) => target.type === 'iframe');
    assert.ok(frameTarget, 'The widget iframe must be inspectable');
    const frameSession = String(
      (
        await browser.call('Target.attachToTarget', {
          targetId: frameTarget.targetId,
          flatten: true,
        })
      ).sessionId,
    );
    const fontSizes = async () => {
      const reply = await browser.call(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const size = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
            return {root: size(':root'), heading: size('h2'), body: size('p'), fixed: size('small')};
          })()`,
          returnByValue: true,
        },
        frameSession,
      );
      return (reply.result as any).value as {
        root: number;
        heading: number;
        body: number;
        fixed: number;
      };
    };
    const waitForRoot = async (root: number) => {
      let sizes = await fontSizes();
      for (let attempt = 0; attempt < 80 && sizes.root !== root; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        sizes = await fontSizes();
      }
      assert.equal(sizes.root, root, JSON.stringify(sizes));
      return sizes;
    };

    // The last sidebar layout used scale 2. The pop-out adopts it; heading/body
    // proportions and the per-widget 1.25 multiplier are preserved. Hardcoded
    // px text is a documented limitation and stays unchanged.
    assert.equal(((await (await fetch(url + '/state')).json()) as any).textScale, 1);
    await layout(2, 1);
    let sizes = await waitForRoot(32);
    assert.equal(sizes.body, 32 * 1.25);
    assert.equal(sizes.heading, 32 * 1.25 * 1.5);
    assert.equal(sizes.fixed, 12);
    const popoutHeight = async () => Number(await page.evaluate('window.widgetContentHeight'));
    for (let attempt = 0; attempt < 40 && (await popoutHeight()) !== largeHeight; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await popoutHeight(), largeHeight, 'Pop-out reflows like the sidebar');

    // A native sidebar reports its scale through /viewport. Follow live changes.
    const native = await fetch(url + '/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widthCssPixels: 480, heightCssPixels: 280, textScale: 1.5 }),
    });
    assert.equal(native.status, 200);
    await waitForRoot(24);

    // Theme unit × reader zoom spans 0.4–6. Scales beyond the former 0.5–3
    // report range must reach the pop-out unchanged, not clamped.
    const reportNative = async (textScale: number) => {
      const response = await fetch(url + '/viewport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widthCssPixels: 480, heightCssPixels: 280, textScale }),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    await reportNative(1.6 * 2);
    await waitForRoot(51.2);
    await reportNative(0.5 * 0.8);
    await waitForRoot(6.4);
    assert.ok((await layout(6, 1)) > largeHeight, 'The captured sidebar accepts scale 6');
    await reportNative(1.5);
    await waitForRoot(24);

    // A per-widget typography change composes with, and does not reset, the
    // global text scale.
    const current = (await (await fetch(url + '/state')).json()) as any;
    await command({
      method: 'update',
      id: created.id,
      revision: current.revision,
      props: { ...current.props, textScale: 0.75 },
      requestId: 'typography-scale',
    });
    for (let attempt = 0; attempt < 80 && sizes.body !== 24 * 0.75; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      sizes = await fontSizes();
    }
    assert.deepEqual(sizes, { root: 24, heading: 24 * 0.75 * 1.5, body: 24 * 0.75, fixed: 12 });

    // An embedding host that themes the view owns its scale; the reported
    // sidebar value must not fight it.
    await page.evaluate(
      `window.widgetHost.setTheme({...window.widgetBootstrap.theme, scale: 1.1})`,
    );
    await waitForRoot(17.6);
    await layout(2.5, 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal((await fontSizes()).root, 17.6);
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('portable QtQuick displays real Chromium frames and forwards only widget-local input', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp('/tmp/companion-widget-qml-');
  let reference: WidgetAttachment | undefined;
  const service = new WidgetService(directory, async (_, value) => {
    reference = value;
  });
  try {
    const lease = await service.lease(randomUUID(), new AbortController().signal);
    const response = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        props: {
          title: 'Direct interaction',
          items: [{ id: 'test', text: 'Clicked inside QtQuick', completed: false }],
        },
        requestId: 'qt',
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const template = await readFile(new URL('./panel.qml.in', import.meta.url), 'utf8');
    const source = template
      .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
      .replace('@REFERENCE@', '(' + JSON.stringify(reference) + ')');
    const path = join(directory, 'tst_surface.qml');
    await writeFile(path, source);
    try {
      const result = await promisify(execFile)('/usr/lib/qt6/bin/qmltestrunner', ['-input', path], {
        env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
        timeout: 20000,
      });
      assert.match(result.stdout, /3 passed, 0 failed/);
    } catch (error) {
      throw Error(String((error as any).stdout) + '\n' + String((error as any).stderr));
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation turns retain text, choices, names, widgets and freeform follow-ups across reopening', async () => {
  const { AgentSessions } = await import('../../src/agents/sessions.ts');
  const { chatMessage } = await import('../../src/agents/types.ts');
  const { widgetTools } = await import('../../src/agents/widget-tools.ts');
  const { frame, signal } = await import('../helpers.ts');
  const directory = await mkdtemp('/tmp/companion-widget-session-');
  let widgetId = '';
  const prompts: string[] = [];
  const backend: import('../../src/agents/types.ts').AgentBackend = {
    id: 'widget-test',
    label: 'Widget test',
    dependencies: {},
    async run(request, signal, emit, choices, rename) {
      prompts.push(request.prompt.text);
      if (!request.widgets) {
        emit(
          chatMessage('fallback-answer', 'assistant', 'Text still works without the visual cache.'),
        );
        return;
      }
      const tools = widgetTools(request.widgets.endpoint, request.widgets.token);
      if (!request.resume) {
        const result = await tools[1].execute(
          'publish',
          { widget: 'todo', props: { items: [] } },
          signal,
        );
        widgetId = JSON.parse(result.content[0].text).id;
        rename?.('🎛️ Widget lab');
      } else {
        const state = JSON.parse(
          (await tools[0].execute('inspect', { id: widgetId }, signal)).content[0].text,
        );
        assert.equal(state.props.items[0].text, 'A user edit between turns');
      }
      emit(chatMessage('answer', 'assistant', 'A concise **Markdown** answer.'));
      choices?.([{ label: 'Continue', description: '' }]);
    },
  };
  let sessions = new AgentSessions({ backend }, () => {}, directory);
  try {
    const id = sessions.start({ ...frame, utterance: 'Make a useful checklist' }, signal());
    await sessions.idle();
    let view = sessions.snapshot()[0];
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.title, '🎛️ Widget lab');
    assert.equal(view.choices?.options[0].label, 'Continue');
    const visual = view.messages.find((message) => message.widget)!;
    const edited = await fetch(visual.widget!.viewUrl + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_item',
        args: { text: 'A user edit between turns' },
        requestId: 'click',
      }),
    });
    assert.equal(edited.status, 200, await edited.text());
    sessions.followUp(id, 'Keep this exact freeform follow-up', signal());
    await sessions.idle();
    assert.deepEqual(prompts, ['Make a useful checklist', 'Keep this exact freeform follow-up']);
    const saved = await readFile(join(directory, '.companion-sessions', id + '.json'), 'utf8');
    assert.ok(!saved.includes('viewUrl'));
    assert.ok(saved.includes('A user edit between turns'));
    await sessions.remove(id);
    await sessions.reopen(id);
    view = sessions.snapshot()[0];
    assert.equal(view.messages.filter((message) => message.widget).length, 1);
    assert.ok(view.messages.some((message) => message.text === 'A concise **Markdown** answer.'));
    assert.equal(view.choices, undefined);
    await sessions.close();
    sessions = new AgentSessions({ backend }, () => {}, directory);
    await sessions.loadPrevious();
    await sessions.reopen(id);
    const reopened = sessions.snapshot()[0].messages.find((message) => message.widget)!;
    assert.notEqual(reopened.widget!.viewUrl, visual.widget!.viewUrl);
    assert.equal((await fetch(reopened.widget!.viewUrl + '/frame')).status, 200);
    await sessions.close();
    const records = JSON.parse(
      await readFile(join(directory, '.companion-widgets', id + '.json'), 'utf8'),
    );
    await rm(join(directory, '.companion-widgets', 'bundles', records[0].bundle + '.json'));
    sessions = new AgentSessions({ backend }, () => {}, directory);
    await sessions.loadPrevious();
    await sessions.reopen(id);
    assert.equal(
      sessions.snapshot()[0].messages.find((message) => message.widget)!.widget!.viewUrl,
      undefined,
    );
    sessions.followUp(id, 'Continue with a missing visual', signal());
    await sessions.idle();
    assert.equal(sessions.snapshot()[0].status, 'completed');
    assert.equal(
      sessions.snapshot()[0].messages.at(-1)!.text,
      'Text still works without the visual cache.',
    );
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('every bundled action satisfies its declared props and result contracts', async () => {
  const directory = await mkdtemp('/tmp/companion-widget-actions-');
  const registry = new WidgetRegistry(directory);
  const renderer = new WidgetRenderer();
  try {
    const examples: Record<string, [string, object][]> = {
      todo: [
        ['add_item', { text: 'Added' }],
        ['rename_item', { itemId: 'action-test', text: 'Renamed' }],
        ['set_completed', { itemId: 'action-test', completed: true }],
        ['remove_item', { itemId: 'action-test' }],
      ],
      'bar-chart': [['append_point', { label: 'Extra', value: 10 }]],
      pipeline: [['set_active', { index: 1 }]],
      'webgl-cube': [['set_rotation', { yaw: 45, pitch: 15 }]],
    };
    for (const [name, actions] of Object.entries(examples)) {
      const bundle = await registry.load(name);
      const record: WidgetRecord = {
        id: randomUUID(),
        owner: randomUUID(),
        name,
        bundle: bundle.hash,
        props: registry.validate(bundle.manifest.parameters, bundle.manifest.example),
        revision: 1,
        text: '',
        receipts: [],
        presentation: defaultPresentation,
      };
      assert.deepEqual(
        new Set(actions.map(([name]) => name)),
        new Set(Object.keys(bundle.manifest.actions)),
      );
      for (const [name, args] of actions) {
        const contract = bundle.manifest.actions[name];
        const result = await renderer.reduce(
          record,
          bundle,
          name,
          registry.validate(contract.parameters, args),
          'action-test',
        );
        record.props = registry.validate(bundle.manifest.parameters, result.props);
        registry.validate(contract.returns, result.result);
        assert.ok((await renderer.describe(record, bundle)).length);
        record.revision++;
      }
    }
  } finally {
    await renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
