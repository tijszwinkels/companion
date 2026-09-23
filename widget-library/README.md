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
host's pop-out button. Both views share the same saved state and the pop-out
follows the text size last reported by the sidebar view; Chromium's own
Ctrl+plus/minus zoom multiplies with it inside that window. Pop-outs close when
the conversation or Companion closes; reopening restores the inline/pinned view.
While Chromium starts, the arrow shows progress and rejects duplicate clicks.
Launch failures remain visible through background refreshes until the next
attempt or a different widget view is selected.

## To-do editing

To-do item text opens an inline editor; the checkbox controls completion only.
The sidebar's Escape key keeps the host contract above: focus moves to the
pop-out button, leaving the inline draft intact. Use **Cancel** to abandon that
edit. In the Chromium pop-out, Escape cancels the edit and focuses the item text.

An editor remembers the item's saved text when opened. Another writer's rename
is shown beside the retained draft. The first Save acknowledges that saved
value; **Replace saved text** confirms replacing it. A further rename requires
another confirmation. Changes to other items, completion or the title do not
invalidate the draft. The optional `rename_item.expectedText` argument compares
against saved text in the reducer, protecting a rename arriving during save too.
Existing callers can omit it; retained older bundles keep their old action
schema and behavior. The host still rejects stale displayed revisions, including
those caused by unrelated changes during a save; the widget never retries
mutations automatically. Inspect the saved value before retrying a failed save.

If an edited item is removed, its editor remains as a copyable recovery draft
with saving disabled. Dismiss it after copying any text to keep. Failed additions
retain the input and ask the user to check the list before adding again, because
a reported failure may follow a committed write.

The approved typography and density remain: `textScale` is 0.75–1.5 (default
0.9), multiplied by host text size. Small pinned views may show only one or two
rows; the list scrolls. Coral remains on the progress fill and checked circles;
text, control boundaries and focus outlines use readable theme foregrounds.

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

The root font size is `16px × textScale`, where `textScale` is Companion's text
size: Ctrl+plus/minus reader zoom (80–200%) times the theme unit (0.5–3), so
0.4–6. It changes live in inline, pinned and pop-out views without reloading or
resetting drafts. This is
host behavior, so already published bundles follow it too. Size text in
`rem`/`em` so headings and labels keep their proportions. A widget's own
typography prop should multiply `rem` sizes (for example
`calc(1.5rem * var(--my-scale))`) so both settings compose.
Hardcoded `px` text, `px`-based layout, and text drawn in canvas or fixed-size
SVG do not follow the setting; nor does the host's 12px padding. Text scaling
never changes CSS pixel geometry, `window.innerWidth` or `devicePixelRatio`:
capture density and native supersampling are applied separately, not twice.

An inline bubble measures its content and reserves between 100 theme units and
420 text-scaled units (never less than 420 theme units); content taller than that
scrolls inside the widget. Text that wraps more at a larger size can grow faster
than the bound, so something that fit at 100% may scroll when enlarged. A pinned
widget receives its reserved viewport.
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

### Standalone native UI

The [standalone Qt host](../native/window/README.md) embeds Chromium through Qt
WebEngine in Window, Sidebar and Dock. It draws and handles input directly;
inline views do not use the PNG/input-forwarding loop described below. Filtered
2× rendering is the default; the native host guide documents overrides, build
dependencies, focus behavior and known rendering limits. Widget tools, retained
bundles, state, actions and the separate Chromium pop-out remain shared.

Native embedding runs inside the Companion UI host and uses the
[native profile/module](../native/widget-renderer/README.md). It does not inherit
the capture browser's whole-process Bubblewrap network namespace. Do not apply
the capture-path isolation or frame-rate claims to this renderer.

### Portable capture and pop-out

The stock Quickshell panel uses the installed Chromium and Bubblewrap on Linux, with
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

For native UI behavior, use the build and `npm run test:window` workflow in the
[native host guide](../native/window/README.md). The commands below describe the
portable capture/browser suite and shared panel tests; they do not by themselves
validate native embedding. Review readiness and exclusions are recorded in the
feature ledger, separately from a test suite's passing result.

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
