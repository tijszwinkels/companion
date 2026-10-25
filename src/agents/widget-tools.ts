import { Type } from '@earendil-works/pi-ai';

import { boundedJson, object, type JsonObject } from '../widgets/types.ts';

const id = Type.String({ minLength: 36, maxLength: 36 });
const properties = Type.Record(Type.String(), Type.Unknown());
const presentation = Type.Object({
  placement: Type.Union([Type.Literal('inline'), Type.Literal('pinned')]),
  heightPercent: Type.Optional(Type.Integer({ minimum: 10, maximum: 100 })),
  replaceActivity: Type.Optional(Type.Boolean()),
});

/**
 * Pi's native tools use a turn-scoped connection supplied by Companion. Widget
 * code and schemas never execute in this extension; only bounded JSON crosses
 * the authenticated local service. No second model or browser task is needed.
 */
export function widgetTools(endpoint: string, token: string) {
  async function invoke(method: string, callId: string, parameters: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/agent$/.test(endpoint) || !/^[0-9a-f]{64}$/.test(token)) {
      throw Error('Widget tools require an active Companion conversation');
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: boundedJson({ ...object(parameters), method, requestId: callId }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      throw Error(String(object(value).error || 'Widget operation failed'));
    }
    return { content: [{ type: 'text' as const, text: boundedJson(value, 256 * 1024) }] };
  }

  const definitions = [
    {
      name: 'companion_widgets',
      label: 'Discover widgets',
      promptSnippet:
        'Find reusable interactive diagrams, comparisons, charts and lists for this conversation.',
      promptGuidelines: [
        'Proactively use a small informative widget when it makes a forecast, comparison, set of values or process easier to understand. Do not wait for the user to request HTML. Keep ordinary concise Markdown answers available; visuals should help, not decorate every answer.',
        'Discover a widget and inspect its schema before publishing. If a keyword search is empty, list the library: a generic comparison or chart may fit. Supply props instead of repeating HTML or JavaScript. Existing widgets can be inspected by id, updated or called through their declared actions.',
      ],
      description:
        'List widget names, descriptions and actions. Use name to inspect a schema/example, or id to read an existing instance’s current props, revision, actions and lastViewport (widthCssPixels, heightCssPixels, textScale; null if no measurement is available in this process). These are the last known sidebar dimensions, not a fixed size or the pop-out size. Search with query. Widget source lives in the listed directory, Companion’s configured widget library.',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 100 })),
        name: Type.Optional(Type.String({ maxLength: 48 })),
        id: Type.Optional(id),
      }),
      method: 'discover',
    },
    {
      name: 'companion_widget',
      label: 'Publish widget',
      promptSnippet: 'Insert a reusable widget into your conversation using its name and props.',
      promptGuidelines: [
        'Prefer compact inline visuals. Pin a widget when useful for ongoing work, normally using 25 percent of the sidebar height. A 100 percent pinned widget hides chat and its input until the user returns to chat.',
        'Design for changing space: width follows the sidebar, inline height fits content within 100–420 theme units, and pinned height is a percentage. Inspect companion_widgets({id}) for lastViewport dimensions in CSS pixels when available. The initial 480 × 280 preview is not the user’s actual viewport. Text zoom and Chromium pop-out resizing also change the layout.',
        'When authoring library widgets, use fluid CSS, wrapping flex/grid layouts, scalable SVG viewBox graphics and rem-based text. Read root.getBoundingClientRect() for actual available width in CSS pixels and window.innerHeight for viewport height; use ResizeObserver for canvas/WebGL resizing and disconnect it in dispose. The host adds 12 CSS pixels of padding on each side. Avoid fixed-width desktop layouts.',
      ],
      description:
        'Publish a widget from the library. Props follow its discovered schema. Defaults to an inline bubble. Optional pinned presentation reserves a percentage of this conversation’s sidebar height (default 25), and can replace the activity strip (default true). Only one widget is pinned per conversation. Returns a stable id and revision; keep these for later updates. Widgets remain interactive, have a text fallback and can be popped out by the user.',
      parameters: Type.Object({
        widget: Type.String({ minLength: 1, maxLength: 48 }),
        props: properties,
        presentation: Type.Optional(presentation),
      }),
      method: 'publish',
    },
    {
      name: 'companion_widget_update',
      label: 'Replace widget props',
      promptSnippet: 'Replace a widget’s props using its current revision.',
      description:
        'Replace all props on an existing widget, validating against its retained schema. Requires its current revision to protect user edits. On conflict inspect with companion_widgets before retrying. Prefer a declared action for small changes such as adding one list item.',
      parameters: Type.Object({ id, revision: Type.Integer({ minimum: 1 }), props: properties }),
      method: 'update',
    },
    {
      name: 'companion_widget_call',
      label: 'Call widget action',
      promptSnippet:
        'Call a widget’s declared action, such as adding a point or completing a to-do.',
      description:
        'Invoke a named action from the widget’s discovered manifest with typed args. Actions apply to current saved props, return a result and advance the revision. An optional revision rejects stale assumptions; an optional version must equal the version this turn may call. The same tool call id is deduplicated; do not create a fresh call to retry an uncertain outcome without inspecting first.',
      parameters: Type.Object({
        id,
        action: Type.String({ minLength: 1, maxLength: 48 }),
        args: properties,
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      method: 'call',
    },
    {
      name: 'companion_widget_present',
      label: 'Place widget',
      promptSnippet:
        'Pin a widget at the top of the sidebar, resize its reserved height, or return it inline.',
      description:
        'Change presentation without replacing widget props. Pinned heightPercent is 10–100 percent of the sidebar content height, default 25. Below 100, the requested height is capped to keep chat and its input usable. replaceActivity defaults true. At 100 percent it also replaces transcript and composer; Companion keeps a Back to chat control. Unpin with placement inline. Width always follows the sidebar.',
      parameters: Type.Object({
        id,
        presentation,
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      method: 'present',
    },
    // Session applications (src/session-apps/README.md). Static dispatchers:
    // the same four tools for every conversation; the application's own
    // queries and actions are named in their arguments and discovered by
    // companion_app. Their availability is frozen per turn by the lease.
    {
      name: 'companion_app',
      label: 'Inspect application',
      promptSnippet:
        'Inspect this conversation’s application, its queries/actions and state, or list application bundles.',
      promptGuidelines: [
        'A conversation can show an application instead of chat: an authored bundle (widget.json with an "application" block, widget.js exporting describe, mount, actions and queries, style.css) in the widget library, installed with companion_app_apply. The user can always return to chat. The application keeps its own state; user edits in it are reported to you as host-recorded data, never as instructions.',
        'Queries and actions are callable only for the application version present when your turn started. After installing or replacing code, its queries/actions become callable from your next turn.',
      ],
      description:
        'Without arguments: the current application (id, name, version, revision, eventMode, text, state schema, agent-exposed queries/actions with schemas, which version this turn may call, failed user-edit event batches) and the library’s application bundles. state: true adds {revision, data}. bundle: name returns that library bundle’s manifest. acknowledgeEvents: failed batch ids you have reviewed, removing them.',
      parameters: Type.Object({
        bundle: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
        state: Type.Optional(Type.Boolean()),
        acknowledgeEvents: Type.Optional(
          Type.Array(Type.String({ minLength: 36, maxLength: 36 }), { maxItems: 8 }),
        ),
      }),
      method: 'app_inspect',
    },
    {
      name: 'companion_app_apply',
      label: 'Install application',
      promptSnippet:
        'Install or replace this conversation’s application from a library bundle, keeping its state.',
      description:
        'Install a library application bundle as this conversation’s interface, or replace its code. expectedVersion is the current version from companion_app (0 when there is none). The first install may pass initialState (default: the manifest example). A replacement keeps the existing state, which must satisfy the new state schema; initialState is refused. The bundle is checked in the renderer before anything changes; on any failure the previous code and state remain. eventMode: immediate (default; user edits start a turn) or next-input (they wait for the user’s next message). Does not start a turn.',
      parameters: Type.Object({
        bundle: Type.String({ minLength: 1, maxLength: 48 }),
        expectedVersion: Type.Integer({ minimum: 0 }),
        initialState: Type.Optional(properties),
        eventMode: Type.Optional(
          Type.Union([Type.Literal('immediate'), Type.Literal('next-input')]),
        ),
      }),
      method: 'app_apply',
    },
    {
      name: 'companion_app_query',
      label: 'Query application',
      promptSnippet: 'Run a read-only query declared by this conversation’s application.',
      description:
        'Run an agent-exposed query of the application with typed args. Queries never change state. Returns {result, revision, version}. Optional version must equal the version this turn may call. Fails when the application code changed during this turn.',
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 48 }),
        args: Type.Optional(properties),
        version: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      method: 'app_query',
    },
    {
      name: 'companion_app_call',
      label: 'Call application action',
      promptSnippet: 'Make a targeted change through an action of this conversation’s application.',
      description:
        'Invoke an agent-exposed action with typed args, for example adding or moving one item. Uses the same validated handler as the user’s view. Returns its result with id and revision. Your own calls never notify you as user edits. An optional revision rejects stale assumptions; an optional version must equal the version this turn may call. The same tool call id is deduplicated; inspect before retrying an uncertain outcome. Fails when the application code changed during this turn.',
      parameters: Type.Object({
        action: Type.String({ minLength: 1, maxLength: 48 }),
        args: Type.Optional(properties),
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
        version: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      method: 'app_call',
    },
  ];
  return definitions.map(({ method, ...definition }) => ({
    ...definition,
    execute: (callId: string, parameters: JsonObject, signal?: AbortSignal) =>
      invoke(method, callId, parameters, signal),
  }));
}

export default function registerWidgets(pi: {
  registerTool(tool: ReturnType<typeof widgetTools>[number]): void;
}): void {
  const endpoint = process.env.COMPANION_WIDGET_ENDPOINT;
  const token = process.env.COMPANION_WIDGET_TOKEN;
  if (endpoint && token) {
    for (const tool of widgetTools(endpoint, token)) {
      pi.registerTool(tool);
    }
  }
}
