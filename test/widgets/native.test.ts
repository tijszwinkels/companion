import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { WidgetService } from '../../src/widgets/service.ts';
import type { WidgetAttachment } from '../../src/widgets/types.ts';

test('native Qt embeds Chromium and keeps interaction inside the widget', async () => {
  const directory = await mkdtemp('/tmp/companion-native-widget-test-');
  const owner = randomUUID();
  const references: WidgetAttachment[] = [];
  let service = new WidgetService(directory, async (_, value) => {
    references.push(value);
  });
  try {
    const lease = await service.lease(owner, new AbortController().signal);
    const publication = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        props: {
          title: 'Native interaction',
          items: [{ id: 'one', text: 'Direct Chromium', completed: false }],
        },
        requestId: 'native-view',
      }),
    });
    assert.equal(publication.status, 200, await publication.text());
    const replacement = await fetch(lease.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
      body: JSON.stringify({
        method: 'publish',
        widget: 'todo',
        requestId: 'replacement-view',
        props: { title: 'Replacement view', items: [] },
      }),
    });
    assert.equal(replacement.status, 200, await replacement.text());
    const template = await readFile(new URL('./native.qml.in', import.meta.url), 'utf8');
    const source = template
      .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
      .replace('@REFERENCE@', '(' + JSON.stringify(references[0]) + ')')
      .replace('@ORIGINAL_STRESS@', '(' + JSON.stringify(references[0]) + ')')
      .replace('@REPLACEMENT_STRESS@', '(' + JSON.stringify(references[1]) + ')')
      .replace('@ORIGINAL@', '(' + JSON.stringify(references[0]) + ')')
      .replace('@REPLACEMENT@', '(' + JSON.stringify(references[1]) + ')')
      .replace('@CAPTURE@', join(directory, 'native.png'));
    const path = join(directory, 'tst_native.qml');
    await writeFile(path, source);
    const build = resolve('native/widget-renderer/build');
    try {
      const result = await promisify(execFile)(
        join(build, 'companion-widget-tests'),
        ['-input', path, '-nocrashhandler'],
        {
          env: {
            ...process.env,
            QT_QPA_PLATFORM: 'offscreen',
            QT_QUICK_BACKEND: 'software',
            QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
            QML_IMPORT_PATH: join(build, 'qml'),
          },
          timeout: 30000,
          killSignal: 'SIGKILL',
        },
      );
      assert.match(result.stdout, /4 passed, 0 failed/);
      await service.close();
      service = new WidgetService(directory, async () => {});
      const reopened = await service.restored(owner);
      for (const entry of reopened) {
        const response = await fetch(entry.reference.viewUrl + '/state');
        assert.equal(response.status, 200);
        const state = (await response.json()) as any;
        if (state.props.title === 'Replacement view') {
          assert.equal(state.props.items[0].text, 'successor');
        } else {
          assert.equal(state.props.items[0].completed, true);
          assert.equal(state.props.items[1].text, 'native input');
        }
      }
      assert.equal(reopened.length, 2);
    } catch (error) {
      throw Error(
        [String(error), (error as any).stdout, (error as any).stderr].filter(Boolean).join('\n'),
        { cause: error },
      );
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Run the real prepared Quickshell binary with only a synthetic FloatingWindow.
// A private runtime/config keeps this completely separate from the live shell.
test('prepared Quickshell renders an actual widget in its own offscreen scene', async () => {
  const directory = await mkdtemp('/tmp/companion-native-host-test-');
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
        widget: 'pipeline',
        props: {
          title: 'Embedded Chromium',
          steps: ['Props', 'Native view', 'Interaction'],
          active: 1,
        },
        requestId: 'host',
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const template = await readFile(new URL('./native-host.qml.in', import.meta.url), 'utf8');
    const capture = join(directory, 'native-host.png');
    const source = template
      .replace('@PANEL@', new URL('../../integrations/panel', import.meta.url).href)
      .replace('@REFERENCE@', '(' + JSON.stringify(reference) + ')')
      .replace('@CAPTURE@', capture);
    const path = join(directory, 'shell.qml');
    await writeFile(path, source);
    const runtime = join(directory, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    const build = resolve('native/widget-renderer/build');
    const result = await promisify(execFile)(
      join(build, 'quickshell-build/src/quickshell'),
      ['--path', path],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_RUNTIME_DIR: runtime,
          QT_QPA_PLATFORM: 'offscreen',
          QT_QUICK_BACKEND: 'software',
          QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
          QML_IMPORT_PATH: join(build, 'qml'),
        },
        timeout: 30000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /NATIVE_HOST_PASS/, result.stdout + result.stderr);
    const png = await readFile(capture);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 480);
    assert.equal(png.readUInt32BE(20), 320);
    // Keep only the synthetic rendered image for human inspection; state and
    // all runtime/cache data disappear with the temporary test directory.
    const artifacts = join(build, 'artifacts');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'native-host.png'), png);
    const evidence = result.stdout.match(/NATIVE_HOST_PASS (.+)/)?.[1];
    console.log('Prepared host: ' + evidence);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
