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

Super +/− uses Omarchy's ordinary Hyprland resize action in Window mode, for both
floating and tiled windows. Qt follows the resulting compositor geometry. Only
Sidebar/Dock route these keys to Companion's own width control. Asking Qt to
resize an ordinary surface directly can change its content size while Hyprland
keeps the outer window at the previous size. The shortcut regression executes
the shipped Lua with inert compositor objects; live geometry still needs a
coordinated check after updating the installed adapter's bindings.

## Build without activating

Build dependencies: CMake, a C++17 compiler, Qt 6.8+ Quick, QuickControls2,
WebEngineQuick, Network, QuickTest, and LayerShellQt 6.6+ development files.
QuickTest is only needed when `BUILD_TESTING` is enabled. Runtime packages on
Arch are `qt6-base`, `qt6-declarative`, `qt6-webengine`, `layer-shell-qt`.

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
injects ordinary offscreen surfaces for Sidebar/Dock; it does **not** prove the
Wayland layer protocol, reserved workspace geometry, focus restoration, monitor
hotplug or GPU/WebGL performance. These require a coordinated desktop check.

The translucent-theme regression covers the live crash reported on 2026-09-21
while closing a weather widget. Its core stopped at Chromium's native
background alpha check with ARGB `0x14a9b1d6` (alpha 20/255). The same color caused
an offscreen SIGTRAP before the fix, without using the weather widget. Native
views now use a fully transparent clear color; CSS draws the themed background.
Qt colors are converted to explicit CSS RGBA so `#AARRGGBB` is not mistaken for
CSS `#RRGGBBAA`. Tests cover initial creation, theme updates, pin/unpin and repeated
close/reopen, including the CSS tint/opacity. The synthetic crash child disables
core files. This evidence does not establish live compositor/GPU behavior.

For a coordinated scaling investigation, stop the existing UI process and start it with
`npm run ui -- --presentation window --render-diagnostics`. Lines beginning with
`COMPANION_RENDER` report changed window dimensions, screen/window pixel ratios,
the Qt graphics API enum, theme colors/font/spacing, and Chromium viewport dimensions and
pixel ratio. Timestamps allow comparison with a visible change after startup or
a monitor move. This opt-in trace contains no conversation text, widget props or
capability URLs. It measures reported rendering state, not the compositor's final
buffer or perceived sharpness. It does not change scaling or restart the listener.

With `--render-diagnostics`, the window also shows **Normal**, **2×** and
**2× filtered (test)** buttons. They switch the existing embedded views in place,
so the same widget can be compared on a real monitor. The default is Normal;
the choice lasts only for this UI process. It does not change the ordinary Qt
text or the separate Chromium pop-out. The trace includes the chosen mode,
internal view dimensions, displayed dimensions and browser pixel ratio.

Both 2× modes double the view dimensions and Chromium page zoom, then apply an
inverse Qt transform to preserve the visible layout. This renders four times as
many pixels. Filtered mode additionally uses a smooth Qt texture layer, which
costs memory and compositing work and has shown clipping in offscreen tests.
It is an experimental comparison, not a confirmed sharpness fix. Return to
Normal if the result glitches. No renderer/profile reload is needed to switch;
widget state, browser inputs and conversation drafts remain in place.

To choose an initial mode, add `--widget-rendering supersampled` or
`--widget-rendering filtered`. An existing process rejects this startup option;
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
reopen checks. This is separate from the still-unconfirmed live text blur.

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
