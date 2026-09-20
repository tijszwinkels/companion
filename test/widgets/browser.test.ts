import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
