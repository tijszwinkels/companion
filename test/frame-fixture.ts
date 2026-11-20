/**
 * Fixture for the gateway's frame origin (src/remote/frames/).
 *
 * A real listener control socket, a real widget service (with its private
 * Unix socket) and a real gateway with a frame origin, all on loopback and in
 * temporary directories. Widgets and the application come from a synthetic
 * library written here, and the widget service's renderer is replaced by one
 * that runs the bundle's own reducers, queries and describe() in Node: the
 * isolated Chromium renderer is not available in every test environment, and
 * these tests are about the transport, not about rendering.
 *
 * Nothing reads personal state, calls a model or binds a non-loopback address.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { widgetTools } from '../src/agents/widget-tools.ts';
import type { WidgetBundle, WidgetRecord, JsonObject } from '../src/widgets/types.ts';
import { frame, signal } from './helpers.ts';
import { freePort, remoteFixture, waitFor, type SyntheticRun } from './remote-fixture.ts';

/** A widget with one action: a button that counts its clicks. */
const counterManifest = {
  name: 'counter',
  version: 1,
  description: 'A synthetic counter for frame tests.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 100, default: 'Clicks' },
      count: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
    },
    required: [],
    additionalProperties: false,
  },
  actions: {
    increment: {
      description: 'Add one.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      returns: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  },
  example: { title: 'Clicks', count: 0 },
};

const counterModule = `
export function describe(props) {
  return props.title + ': ' + props.count;
}
export const actions = {
  increment(props) {
    props.count += 1;
    return { props, result: { count: props.count } };
  },
};
export function mount(root, api) {
  const button = document.createElement('button');
  button.id = 'increment';
  button.onclick = () => { void api.call('increment', {}).catch(() => {}); };
  root.append(button);
  return {
    update(props) { button.textContent = props.title + ': ' + props.count; },
    dispose() {},
  };
}
`;

/** A session application with one action and one query. */
const notesManifest = {
  name: 'notes',
  version: 1,
  description: 'A synthetic note list for frame tests.',
  application: { eventMode: 'next-input' },
  parameters: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        default: [],
      },
    },
    required: ['notes'],
    additionalProperties: false,
  },
  actions: {
    add_note: {
      description: 'Add a note.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['text'],
        additionalProperties: false,
      },
      returns: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  queries: {
    count_notes: {
      description: 'How many notes there are.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      returns: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  },
  example: { notes: [] },
};

const notesModule = `
export function describe(state) {
  return 'Notes: ' + state.notes.length;
}
export const actions = {
  add_note(state, args) {
    state.notes.push(args.text);
    return { state, result: {} };
  },
};
export const queries = {
  count_notes(state) {
    return { count: state.notes.length };
  },
};
export function mount(root) {
  const list = document.createElement('ul');
  root.append(list);
  return {
    update(state) { list.textContent = state.notes.join(', '); },
    dispose() {},
  };
}
`;

async function writeWidget(
  library: string,
  manifest: { name: string },
  javascript: string,
): Promise<void> {
  const directory = join(library, manifest.name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'widget.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(directory, 'widget.js'), javascript);
  await writeFile(join(directory, 'style.css'), 'button { font-size: 1rem; }\n');
}

/** The bundle's own module, evaluated in Node (test-controlled code only). */
type WidgetModule = {
  describe(props: JsonObject): string;
  actions?: Record<string, (props: JsonObject, args: JsonObject, context: object) => any>;
  queries?: Record<string, (props: JsonObject, args: JsonObject) => any>;
  mount?: unknown;
};

const modules = new Map<string, Promise<WidgetModule>>();

function moduleOf(bundle: WidgetBundle): Promise<WidgetModule> {
  let loaded = modules.get(bundle.hash);
  if (!loaded) {
    const url = 'data:text/javascript;base64,' + Buffer.from(bundle.javascript).toString('base64');
    loaded = import(url) as Promise<WidgetModule>;
    modules.set(bundle.hash, loaded);
  }
  return loaded;
}

/** Write the synthetic `counter` widget and `notes` application into `library`. */
export async function writeSyntheticLibrary(library: string): Promise<void> {
  await writeWidget(library, counterManifest, counterModule);
  await writeWidget(library, notesManifest, notesModule);
}

/**
 * Replace the methods of a widget renderer object in place (the application
 * host holds the same object) with Node-side equivalents.
 */
export function useNodeRenderer(renderer: object): void {
  Object.assign(renderer, {
    async describe(record: WidgetRecord, bundle: WidgetBundle) {
      return String((await moduleOf(bundle)).describe(structuredClone(record.props)));
    },
    async reduce(
      record: WidgetRecord,
      bundle: WidgetBundle,
      action: string,
      args: JsonObject,
      requestId: string,
    ) {
      const implementation = (await moduleOf(bundle)).actions?.[action];
      if (!implementation) {
        throw Error('Widget action is not implemented');
      }
      const value = implementation(structuredClone(record.props), structuredClone(args), {
        requestId,
      });
      return { props: value.props ?? value.state, result: value.result ?? {} };
    },
    async query(record: WidgetRecord, bundle: WidgetBundle, name: string, args: JsonObject) {
      const implementation = (await moduleOf(bundle)).queries?.[name];
      if (!implementation) {
        throw Error('Application query is not implemented');
      }
      return implementation(structuredClone(record.props), structuredClone(args));
    },
    async inspect(_record: WidgetRecord, bundle: WidgetBundle) {
      const implementation = await moduleOf(bundle);
      return {
        mount: typeof implementation.mount === 'function',
        describe: typeof implementation.describe === 'function',
        actions: Object.keys(implementation.actions ?? {}),
        queries: Object.keys(implementation.queries ?? {}),
      };
    },
    async render() {},
    async discard() {},
    dimensions() {
      return undefined;
    },
    async close() {},
  });
}

export interface FrameFixtureOptions {
  /** Configure the frame origin (default true). */
  frames?: boolean;
  /** Grace period after a device's last connection (default 30 s). */
  graceMilliseconds?: number;
  /** Static files the gateway serves (default: none). */
  appDirectory?: string;
  /** Point the frame origin at another widget socket (a fake upstream). */
  widgetSocket?: string;
}

/** The remote fixture plus a frame origin, a synthetic library and helpers. */
export async function frameFixture(options: FrameFixtureOptions = {}) {
  const library = await mkdtemp(join(tmpdir(), 'companion-frame-library-'));
  await writeSyntheticLibrary(library);

  const framePort = await freePort();
  const frameOrigin = `http://127.0.0.1:${framePort}`;
  const withFrames = options.frames ?? true;

  const fixture = await remoteFixture({
    widgetLibrary: library,
    appDirectory: options.appDirectory,
    gateway: withFrames
      ? {
          frames: {
            listen: { host: '127.0.0.1', port: framePort },
            origin: frameOrigin,
            graceMilliseconds: options.graceMilliseconds,
            widgetSocket: options.widgetSocket,
          },
        }
      : {},
  });
  useNodeRenderer(
    (fixture.sessions as unknown as { widgets: { renderer: object } }).widgets.renderer,
  );

  /** Start a conversation and return its id and the first synthetic run. */
  async function conversation(): Promise<{ id: string; run: SyntheticRun }> {
    const before = fixture.runs.length;
    const id = fixture.sessions.start(frame, signal());
    await waitFor(() => fixture.runs.length === before + 1);
    return { id, run: fixture.runs[before] };
  }

  function tools(run: SyntheticRun) {
    const lease = run.request.widgets!;
    const all = widgetTools(lease.endpoint, lease.token);
    return (name: string) => all.find((tool) => tool.name === name)!;
  }

  /** Publish a counter widget from a run's lease; returns the widget id. */
  async function publishCounter(
    run: SyntheticRun,
    presentation?: { placement: 'inline' | 'pinned'; heightPercent?: number },
  ): Promise<string> {
    const result = await tools(run)('companion_widget').execute('publish-' + Math.random(), {
      widget: 'counter',
      props: { title: 'Clicks', count: 0 },
      ...(presentation ? { presentation } : {}),
    });
    return JSON.parse(result.content[0].text).id as string;
  }

  /** Install (expectedVersion 0) or replace the notes application. */
  async function applyNotes(run: SyntheticRun, expectedVersion = 0): Promise<void> {
    await tools(run)('companion_app_apply').execute('apply-' + expectedVersion, {
      bundle: 'notes',
      expectedVersion,
      eventMode: 'next-input',
    });
  }

  /** A request to the frame origin with the browser's usual headers. */
  function frameRequest(
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { ...init.headers };
    if (method === 'POST' && headers.Origin === undefined) {
      headers.Origin = frameOrigin;
    }
    if (init.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
  }

  async function close(): Promise<void> {
    await fixture.close();
    await rm(library, { recursive: true, force: true });
  }

  return {
    ...fixture,
    frameOrigin,
    framePort,
    conversation,
    publishCounter,
    applyNotes,
    frameRequest,
    close,
  };
}
