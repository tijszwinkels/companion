# Standalone Companion window

This host runs the existing Qt Quick conversation interface with embedded Qt
WebEngine. It uses the distribution's Qt and LayerShellQt packages; it does not
build, install or replace Quickshell. The listener, agent tools, widget library
and durable conversations keep their existing protocol and storage.

The host provides Window, Sidebar and Dock controls. Window initially requests
620 × 780 logical pixels and remembers its size. The prepared Omarchy rule makes
it float without taking initial focus; the user can tile it normally. Sidebar
overlays the right edge. Dock reserves its width for the workspace. Both require
Wayland and LayerShellQt. One persistent QML body moves between the two native
surfaces, retaining drafts, selected tabs, zoom and browser documents. Closing
the window hides it; the resident host can be summoned again.

The shared panel also provides per-conversation next-turn model selection, tab
dragging and Alt+Shift+Up/Down reordering, and a draggable rail divider. These
controls remain in the same QML body across Window/Sidebar/Dock. Open-tab order
is owned by the listener and survives reconnects; rail width lasts for the UI
process. “Go to session one” through sixteen (also numerals 1–16) follows
that visible order and only selects the UI/order captured before transcription.
At most 16 conversation tabs can be open. See the
[desktop contract](../../src/desktop/README.md#model-selection-ordering-and-spoken-navigation)
for scope, persistence and stale-request handling.

Super+Alt+D uses Hyprland's dismissible focus-grab protocol for Sidebar and Dock.
The normal Qt activation request works for ordinary windows, but Hyprland does
not apply it to layer surfaces. The grab keeps typing in the requested composer
while the pointer remains over another application; an outside click dismisses
it. Toggling focus, hiding, changing presentation, losing the surface or timing
out releases it. Window mode retains Qt's existing activation path. Compositors
without this optional protocol retain click-to-focus and the existing timed
failure message; no exclusive keyboard grab is substituted.
An owned native popup may temporarily replace the layer grab. On dismissal,
Companion reacquires only when keyboard focus returns to that same visible
layer and stays there for 50 ms. That settling interval avoids reclaiming the
brief parent activation during an outside popup dismissal; a focus change
outside Companion ends the request instead.

Super +/− uses Omarchy's ordinary Hyprland resize action in Window mode, for both
floating and tiled windows. Qt follows the resulting compositor geometry. Only
Sidebar/Dock route these keys to Companion's own width control. Asking Qt to
resize an ordinary surface directly can change its content size while Hyprland
keeps the outer window at the previous size. The shortcut regression executes
the shipped Lua with inert compositor objects; live geometry still needs a
coordinated check after updating the installed adapter's bindings.

## Panel browser

The header's **Browser** control shows a minimal web browser in place of the
chat, inside the same persistent body, so it survives Window/Sidebar/Dock moves
and returns to the same conversation, draft and pins. Its controls are hidden
behind a slim status strip (hover, click or Ctrl+L). It uses its own named,
persistent WebEngine profile, separate from the restricted widget profile, and
refuses pop-ups, downloads, permissions and non-web schemes with a visible
notice. Only this standalone host enables it; the portable Quickshell panel
never loads it. See [the panel browser guide](../../docs/panel-browser.md) for
behaviour, storage, limits and tests.

## Build without activating

Build dependencies: CMake, a C++17 compiler, Qt 6.8+ Quick, QuickControls2,
WebEngineQuick, Network, QuickTest, and LayerShellQt 6.6+ development files.
Sidebar builds also require Qt WaylandClient, its protocol scanner and the Qt
Gui private development headers (matching the Qt version being built against).
Rebuild the native UI after a Qt upgrade: the Sidebar/Dock build is tied to those
private headers and the matching runtime libraries.
QuickTest is only needed when `BUILD_TESTING` is enabled. Runtime packages on
Arch are `qt6-base`, `qt6-declarative`, `qt6-webengine`, `qt6-wayland`, `layer-shell-qt`.

```sh
npm run ui:build
npm run test:window
```

For a window-only build use `npm run ui:build -- -DCOMPANION_SIDEBAR=OFF`.
Pass `-DCMAKE_PREFIX_PATH=/path/to/staged/usr` to use a locally extracted
LayerShellQt package without installing it. Neither build nor tests launch a
desktop window, restart the listener, modify configuration or compile ASR.

`test:window` uses temporary state and offscreen Qt. It covers the real host's
private socket, fragmented backend snapshots, reconnects, single-instance
commands, bounded input, ordered choice/input acknowledgements, unread/reopen
state, and draft/browser retention during surface changes. The reparenting test
also exercises real Qt key/mouse events for reordering, divider resizing and
model-menu selection, retaining the native browser and draft through moves and
reconnects. These use synthetic socket state and model catalogs; no provider
request, personal configuration or live conversation is used. The reparenting test
injects ordinary offscreen surfaces for Sidebar/Dock; it does **not** prove the
Wayland layer protocol, reserved workspace geometry, focus restoration, monitor
hotplug or GPU/WebGL performance. These require a coordinated desktop check.

The opt-in `test/window/layer-focus.ts` regression uses real native layer
surfaces in an isolated Hyprland instance, a synthetic backend and disposable
GTK application. It checks Dock/Sidebar focus, actual typed input, focus toggle,
inside composer/tab clicks, outside-click dismissal, media notifications and
hide/reopen. The pointer stays resident so clients bind it before events arrive.
A synthetic native WebEngine select also checks pointer/keyboard input and
retained focus after its popup handoff. The headless select reported `:open=false`
both with the grab and with it explicitly released; persistent popup-menu mouse
selection therefore remains unverified. Wayland tracing did establish popup
creation, replacement of the layer grab, dismissal and return to the parent.
It requires the
normal native build, system Python with GTK4/PyGObject, wtype, a C compiler and
Wayland development tools. This command opens a nested test desktop; arrange
that test window before running it on an interactive desktop:

```sh
python test/live/nested-hyprland.py test/window/layer-focus.ts
```

Set `COMPANION_TEST_UI` to a baseline native executable to compare builds. On
2026-09-22 the baseline failed to focus Dock; the fixed build passed both layer
modes, including actual input and outside-click dismissal. That execution used
a separate headless Sway parent and stock nested Hyprland, with no connection to
the user's compositor. Sway's advertised xdg-shell version was raised from 5 to
6 only in that disposable parent to satisfy Aquamarine's version requirement;
the child Hyprland and its focus-grab implementation were unchanged. This does
not establish live monitor/hotplug, GPU or physical-keyboard behavior. Ordinary
window activation in that synthetic environment lacked a usable activation
token, so it is not claimed as new window-mode coverage.

The vendored focus protocol is unmodified from
[hyprland-protocols cc9a8fd](https://github.com/hyprwm/hyprland-protocols/blob/cc9a8fd253bdc00f48a967ecf4828211ef08751f/protocols/hyprland-focus-grab-v1.xml).
Its BSD license is retained in the XML and installed with the binary. The
test-only pointer protocol retains its MIT license from
[wlr-protocols b010a03](https://github.com/swaywm/wlr-protocols/blob/b010a03648b88d143236de193bddbfea0c08bc84/unstable/wlr-virtual-pointer-unstable-v1.xml).

The translucent-theme regression covers the live crash reported on 2026-09-21
while closing a weather widget. Its core stopped at Chromium's native
background alpha check with ARGB `0x14a9b1d6` (alpha 20/255). The same color caused
an offscreen SIGTRAP before the fix, without using the weather widget. Native
views now use a fully transparent clear color; CSS draws the themed background.
Qt colors are converted to explicit CSS RGBA so `#AARRGGBB` is not mistaken for
CSS `#RRGGBBAA`. Tests cover initial creation, theme updates, pin/unpin and repeated
close/reopen, including the CSS tint/opacity. The synthetic crash child disables
core files. This evidence does not establish live compositor/GPU behavior.

The callback-lifetime regression covers the 2026-09-22 SIGSEGV in
`QJSEngine::create`, called with a null engine from WebEngine's JavaScript result
conversion. Qt 6.11.2's view-level `runJavaScript` callback dereferences
`qmlEngine(this)` before invoking our QML callback; the callback's own lifetime
guard therefore cannot protect that conversion. Metadata polling now uses
`mainFrame.runJavaScript` with the same main-world script, whose Qt callback
checks for a surviving QML engine first. No browser permission or rendering-mode
change is involved. If the context has already disappeared, Qt warns and drops
the result; that inert view stops polling until it is recreated. This prevents
the crash but does not add recovery for an independently failed renderer.

The offscreen regression delays a real Chromium result, then removes either the
browser or its creation context. The context-removal case segfaults with the old
polling call and passes with the guarded frame call. It uses synthetic HTML and
disables core files. This establishes the callback failure mechanism, not which
particular desktop action removed the context in the live crash.

For a coordinated scaling investigation, stop the existing UI process and start it with
`npm run ui -- --presentation window --render-diagnostics`. Lines beginning with
`COMPANION_RENDER` report changed window dimensions, screen/window pixel ratios,
the Qt graphics API enum, theme colors/font/spacing, and Chromium viewport dimensions and
pixel ratio. Timestamps allow comparison with a visible change after startup or
a monitor move. This opt-in trace contains no conversation text, widget props or
capability URLs. It measures reported rendering state, not the compositor's final
buffer or perceived sharpness. It does not change scaling or restart the listener.

Embedded widgets use **2× filtered** by default, with or without diagnostics,
following a successful user comparison on the external monitor.
With `--render-diagnostics`, the window also shows **Normal**, **2×** and
**2× filtered** buttons. They switch the existing embedded views in place,
so the same widget can be compared on a real monitor. A changed selection
lasts only for this UI process. It does not change the ordinary Qt
text or the separate Chromium pop-out. The trace includes the chosen mode,
internal view dimensions, displayed dimensions and browser pixel ratio.

Both 2× modes double the view dimensions and Chromium page zoom, then apply an
inverse Qt transform to preserve the visible layout. This renders four times as
many pixels. Filtered mode additionally uses a smooth Qt texture layer, which
costs memory and compositing work and has shown clipping in offscreen tests.
Live GPU cost and behavior across other displays/backends remain unmeasured.
Return to Normal if the result glitches. No renderer/profile reload is needed to switch;
widget state, browser inputs and conversation drafts remain in place.

To override the default, add `--widget-rendering normal` or
`--widget-rendering supersampled`. An existing process rejects this startup option;
use its diagnostic buttons or stop that UI process first. For the locally
staged LayerShellQt build, the existing launch command enables all three buttons:

```sh
QT_PLUGIN_PATH="$PWD/native/window/build/staged/usr/lib/qt6/plugins" \
  npm run ui -- --presentation window --render-diagnostics \
  2>&1 | tee /tmp/companion-render-live.log
```

The mode regression uses actual WebEngine views and synthetic input offscreen
at 125% display density. It checks matching CSS/display widths, doubled browser
density, live mode changes, retained inputs/drafts/document, checkbox/typing/add,
presentation changes, theme/zoom, full-height return and close/reopen. These
checks do not establish live GPU sharpness, performance or the absence of
backend-specific clipping.

The rapid close/reopen part of this regression exposed a profile teardown
failure: WebEngine can dispatch queued scheme requests while its base profile
is being destroyed, after the derived profile's URL members have gone away.
The native profile now removes and destroys its request handler before that
teardown begins. Repeating the test against the previous handler reproduces
the failure; the fixed handler also passes the existing native interaction and
reopen checks. This is separate from the original live text blur, whose exact
cause remains unconfirmed.

## Coordinated desktop activation

Keep the branch's listener running. Install this revision's Omarchy adapter
using the existing `npm run omarchy:install` workflow, then launch `npm run ui`.
Installation changes the plugin and prepared window/shortcut rules; do not run it
as part of an unattended build or test. No alternate Quickshell host is needed.

The adapter detects `$XDG_RUNTIME_DIR/companion/ui.sock` and yields conversation
ownership to the Qt host. Existing global shortcuts, history picker, bar controls,
media pause/resume and focus restoration remain in the installed Omarchy shell.
Resolved theme values are sent over this private socket. The Qt host remains
usable with a default palette without the bridge, but global desktop actions
then require the bridge to be enabled. Stopping the Qt process restores the
adapter's original panel path on the next shortcut; it does not reopen a panel
unexpectedly. Do not run this UI alongside an older adapter without the handoff.

```sh
native/window/build/companion-ui --presentation window
native/window/build/companion-ui --presentation sidebar
native/window/build/companion-ui --presentation dock
native/window/build/companion-ui --command toggle
native/window/build/companion-ui --hidden
```

Second invocations address the existing process. The host's private lock prevents
concurrent startup from removing a live socket. `--socket` and `--control-socket`
allow isolated fixtures. They are local desktop transports and are never exposed
to widget JavaScript. Commands are not replayed on reconnect; an unconfirmed
message retains its draft and asks the user to check the transcript.

Each invocation requests one operation: `--presentation` changes the mode of an
existing UI without showing a hidden window. To show it in a chosen mode, run
`--presentation window` and then `--command show` separately. Combining the two
options, or spelling a mode other than `window`, `sidebar` or `dock`, exits with
an error before contacting or starting the UI. A valid Sidebar/Dock request still
requires Wayland and LayerShellQt; the running UI displays an availability error
when those are missing. Its CLI acknowledgement confirms receipt, not successful
compositor activation.

## Packaging

CMake installs the executable, QML body, native widget module and desktop entry:

```sh
DESTDIR=/absolute/staging/path cmake --install native/window/build --prefix /usr
```

`packaging/arch/PKGBUILD` builds a separate `companion-ui` package from a source
archive. Create the archive from the reviewed release commit, place it next to
the recipe, set its real checksum and run `makepkg`. Publish builds for each
supported architecture against the supported distribution packages. Installing
the UI package does not activate it or alter Omarchy configuration. The listener
and opt-in adapter installation are still separate; this is a frontend package,
not yet a complete Companion release installer.

The native widget boundary is the same as the existing
[embedded renderer](../widget-renderer/README.md#display-content-boundary).
Network/file access is blocked for widget content. The host does not add shell,
file, transport or compositor APIs to HTML. Its trusted C++/QML objects belong
only to the desktop interface.

Independent widget isolation review remains blocked at the previously recorded
provider termination. Author tests of this new host do not clear that review or
establish readiness to merge or distribute the full feature.
