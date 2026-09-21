# Companion widgets

A widget is a reusable browser view with JSON props and declared actions. Agents
send a name and data; the library supplies the implementation. Ordinary Markdown
answers, choices, session names and freeform follow-ups remain available.

The initial library contains `todo`, `bar-chart`, `pipeline`, `comparison` and
`webgl-cube`. The cube is a small working WebGL example, including a drag action.

## Agent workflow

1. `companion_widgets({})` lists the library directory and available widgets.
2. `companion_widgets({name: "todo"})` returns its schemas, actions and example.
3. `companion_widget({widget: "todo", props: {title: "Release", items: []}})`
   publishes a bubble and returns its `id` and `revision`.
4. `companion_widget_call({id, action: "add_item", args: {text: "Run tests"}})`
   adds an item without resending the list. The result contains its `itemId`.
5. `companion_widgets({id})` inspects current props/revision. Use
   `companion_widget_update({id, revision, props})` to replace all props.
   Its `lastViewport` reports `widthCssPixels`, `heightCssPixels` and `textScale`
   from the latest sidebar layout, or `null` before layout/after view eviction.
   Treat these as a recent measurement; a hidden or resized view may differ.
6. `companion_widget_present({id, presentation: {placement: "pinned",
heightPercent: 25, replaceActivity: true}})` pins the widget above the chat.
   Use `placement: "inline"` to unpin it.

Height is a percentage of usable **sidebar content height**, below the title and
tab controls. Width follows the sidebar. One widget per conversation can be
pinned; pinning another atomically returns the first inline. The default is 25%.
Below 100%, the requested height is capped to leave the input, its controls and
a readable transcript visible, accounting for text zoom and the activity strip.
At 100% the widget replaces the transcript, activity and composer. Host-owned
**Back to chat** and **Stop** controls remain available. Back to chat also works
locally when disconnected; durable unpin requires the service. Local dismissal
applies to the displayed widget revision: an unchanged reconnect snapshot stays
dismissed, while a newer server update or closing/reopening the conversation can
restore its saved pin. The unsent chat draft is
retained. Widgets belong to their conversation, including while another tab is
selected.

Widgets accept clicks and keyboard input directly. The top-right arrow fades in
on hover or keyboard focus and opens a dedicated Chromium window. Clicking the
widget itself interacts with it. Press Escape from widget input to focus the
host's pop-out button. Both views share the same saved state. Pop-outs close when
the conversation or Companion closes; reopening restores the inline/pinned view.
While Chromium starts, the arrow shows progress and rejects duplicate clicks.
Launch failures remain visible through background refreshes until the next
attempt or a different widget view is selected.

## Adding a widget

Create a directory named with lowercase letters, digits and hyphens. It contains
exactly the three entry files below; supporting source/build files are allowed,
but runtime code and assets must be bundled into these files or data URLs.

- `widget.json`: name, positive integer version, description, `parameters` props
  schema, named `actions`, and an `example` props object.
- `widget.js`: browser-only ES module exporting `describe`, `mount` and `actions`.
- `style.css`: local CSS using the theme variables below.

Use ordinary directories and regular entry files. Symlinks are rejected for the
library path, its ancestor directories, each widget directory and all three entry
files, including links to other files inside the library. Copy or bundle shared
sources into the entry files instead. On Linux, the loader opens each path
component relative to an already opened directory through `/proc/self/fd`, refuses
symlinks, and validates and reads the same file handle with a byte limit. Renaming
a directory during a load cannot redirect it to an outside symlink destination.
An edit in progress may fail to load; retry after saving all three files.

Start from an existing example. An action's manifest entry declares
`description`, `parameters` for arguments and `returns` for its custom result.
Schemas use this bounded JSON Schema subset: `type`, `properties`, `required`,
`additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`,
`minimum`, `maximum`, `enum`, `default`, `description`, `title`. Nesting is limited
to 12 levels, properties to 100 per object and enums to 64 values. Regular
expressions, external references and schema combinators are intentionally absent.
Cross-field validation can run inside the browser's `describe` or action code.

```js
export function describe(props) {
  // A readable transcript/context/copy fallback, 1–4000 characters.
  return `${props.title}: ${props.count}`;
}

export const actions = {
  increment(props, args) {
    props.count += args.amount;
    return { props, result: { count: props.count } };
  },
};

export function mount(root, api) {
  const button = document.createElement('button');
  button.onclick = () => {
    void api.call('increment', { amount: 1 }).catch(() => {});
  };
  root.append(button);
  return {
    update(props) {
      button.textContent = `${props.title}: ${props.count}`;
    },
    dispose() {
      // Release timers, observers, WebGL resources and event listeners here.
    },
  };
}
```

Reducers receive cloned current props and args, plus `{requestId}` as a third
argument. Return `{props, result}`; result defaults to `{}`. Keep reducers free of
DOM side effects. They may run again if a failed operation is retried. Use the
request ID for stable generated item IDs. Validate cross-field constraints before
returning; throwing leaves saved props unchanged. Results are checked against
`returns` before the host adds `id` and `revision`.

`api.call` uses the same action path as the agent. It resolves after persistence.
`update` may run when props, theme or zoom change; preserve DOM/input drafts,
selection and focus there. Mount once, reconcile stable item IDs, and dispose
resources when the view closes. Browser surfaces may be evicted; durable state
belongs in props, not module globals or DOM storage. Use `textContent` for data.

Theme variables are `--foreground`, `--background`, `--accent`, `--muted`.
The root font size follows the reader's zoom; prefer `rem` and flexible layouts.
An inline bubble measures its content and reserves 100–420 theme units; larger
content scrolls inside the widget. A pinned widget receives its reserved viewport.
The initial offscreen preview is 480 × 280 CSS pixels, **not** a guarantee of the
sidebar's size. Layouts must adapt to sidebar width, text zoom and pop-out resizing.
The host supplies 12 CSS pixels of padding on every side. Measure
`root.getBoundingClientRect().width` for usable content width and
`window.innerHeight` for viewport height. Prefer wrapping flex/grid layouts,
`minmax(min(100%, 10rem), 1fr)` grid columns and SVG `viewBox` over fixed widths.
Canvas/WebGL widgets should observe their container with `ResizeObserver`, resize
their drawing buffer for `devicePixelRatio`, and disconnect the observer in
`dispose`. Keep essential information visible in a small area and let overflow
scroll when the user reserves less height.

Self-contained HTML, CSS, inline SVG, canvas and WebGL are available. CDN imports,
remote images, fonts, fetches and browser storage are unavailable. Bundle needed
libraries locally; do not add network dependencies to a widget.

## State, errors and cancellation

Props are limited to 128 KiB of JSON; action results to 16 KiB, and action args in
the browser to 32 KiB. A conversation can retain 24 widgets. Each publication
retains its exact manifest/JS/CSS under a SHA-256 hash in the private state folder;
later library edits affect new instances only. Saved transcripts contain a small
reference and text fallback. Reopening regenerates private URLs and repairs the
transcript from canonical widget state. Missing/corrupt bundles retain readable
fallback text.

Operations serialize per conversation. Full replacement requires a revision;
actions optionally use one. Browser interactions always carry the displayed
revision so a stale click cannot overwrite a newer edit. Inspect and retry after
a conflict. The last 64 successful mutation IDs (up to 64 KiB total) are retained
for retry deduplication. Tool-call IDs are scoped to one agent turn. Reusing a
completed call ID returns its prior result; a fresh call ID is a new operation.

Cancellation observed before the atomic state write leaves state unchanged.
After the write starts, the committed operation is published even if its turn
stops. A display-transcript write failure can therefore report an error after the
widget state was committed: inspect the instance before issuing a fresh retry.
Closing a conversation revokes UI capabilities, drains accepted work and closes
its browser views. No widget runs in the listener or native Pi extension.

## Renderer and limits

This implementation uses the installed Chromium and Bubblewrap on Linux, with
QtQuick displaying captured PNG frames. The installed Quickshell constructs its
application with an empty argument list; importing QtWebEngine there aborts.
No Quickshell replacement or system configuration change is required.

Chromium keeps its own sandbox, an isolated temporary profile and a private
Bubblewrap network/PID namespace. Home directories and desktop service sockets
are not mounted. The explicit pop-out receives only the Wayland display socket.
There is no TCP debugging port. Browser automation uses anonymous pipes. The
opaque sandbox iframe has no host credentials or application APIs; its only
bridge accepts declared widget actions. CSP blocks network content, nesting,
workers and form navigation. Browser permissions, file choosers and downloads
are denied. The trusted pop-out host's capability-scoped state/action requests
are fulfilled through the private pipe; Chromium itself has no network access.
There is no fallback that disables these protections.

Sidebar capture is capped at 10 frames/second and pauses for hidden/offscreen
views. Eight browser surfaces are retained at most; idle ones can be recreated.
Capture follows the Qt display pixel density (up to 3×, with an 8-megapixel
backing-buffer budget). CSS geometry and input coordinates remain in logical
pixels; text zoom is separate from capture density.
This suits compact graphics and lists. It is not a native browser texture or a
60 fps embedded canvas. Headless checks demonstrated WebGL drawing; GPU speed
and the actual desktop pop-out still require a coordinated live check. Pop-out
is a dedicated Chromium app window, not the user's ordinary browser profile.
It currently requires Wayland. No listener restart or live installation is part
of development validation.

The Qt surface forwards pointer, wheel, text, navigation keys, explicit copy and
paste. It does not expose a browser accessibility tree or an IME composition
bridge; the text fallback and actual Chromium window remain useful for those
workflows. File/network/browser integrations are outside the widget contract.

## Validation

Run `npm test`, `npm run check`, `npm run format:check`, and `npm run test:widgets`.
The latter requires `/usr/lib/chromium/chromium`, `bwrap`, and Qt's
`/usr/lib/qt6/bin/qmltestrunner`. It uses isolated profiles and offscreen Qt only:
actual rendering, WebGL pixel reads, pointer/keyboard input, shared viewer state,
malicious/failed widget behavior, persistence/reopening and conversation features.
It prints capture timings and writes synthetic screenshots under `/tmp`.
Run all portable panel tests with:

```sh
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

No model call, microphone capture, desktop input or headed browser is used by
these checks. Test the actual pop-out/focus behavior with the user before a live
installation. The installer copies `WidgetSurface.qml` alongside the portable
panel; the listener reads library and browser host assets from this checkout.
