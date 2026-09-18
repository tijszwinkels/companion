# Omarchy adapter

This optional adapter contains the entire shell integration: the bar button,
themed utterance picker, Activity side panel, and Hyprland shortcuts. Companion itself has no dependency
on this plugin. The [local protocol](../../src/desktop/README.md) can support other
desktop adapters without changing the sensor pipeline or processors.

The resident service also watches MPRIS player state through Quickshell's existing
media service. Any player reporting Playing auto-pauses microphone listening;
when none remain Playing, listening resumes unless manually paused. It sends only
a boolean over the socket, including on reconnect. There is no audio capture,
polling, or extra process for playback detection. Unsupported players are ignored.
The bar and Activity tab distinguish **Paused for media** from manual pause.

From a Hyprland desktop terminal in this checkout:

```sh
npm run omarchy:install
npm start
```

Stop an older Companion listener before starting another. The installer copies
the plugin to `~/.config/omarchy/plugins/companion.desktop`, adds it to the right
side of the bar, and sources its shortcut from the personal Hyprland bindings.
It backs up the two modified config files, preserves existing entries, and refuses
a conflicting shortcut. When the Lua shortcuts change, it reloads Hyprland's
configuration and checks for errors. QML-only updates rescan the plugin without
reloading Hyprland or rewriting the unchanged Lua file.
It neither installs packages nor edits files shipped by Omarchy. Run it again
after changing plugin files in this worktree to update the installed copy.
The installer uses a separate source revision directory for changed QML so Qt's
component cache cannot silently retain an older service. No shell restart is
needed to update this adapter.

- Hold **Super+Alt+V**, move with **Up/Down**, and release to paste the selected
  utterance into the application that was active at press time.
- Tap the chord to recover the latest utterance. Insertion starts after V,
  Super, and Alt are all released, in any order; no minimum hold is required.
- **Escape** cancels. Empty history does nothing. Changing the target window
  before delivery skips the paste.
- Recovering an utterance already being typed is rejected to avoid duplication.
  Other keyboard output waits its turn and checks focus again before typing.
- **Super+Alt+P** pauses or resumes listening, including when the panel is closed.
  It uses the same pause control as the top-bar menu and toggles once per press.
- **Super+Alt+D** focuses the selected conversation's input, opening the panel
  if hidden. Press it again to return to the previous application. Select a
  conversation first; Activity and Previous sessions have no composer to focus.
- With the panel focused, **Alt+1** through **Alt+9** select the corresponding
  Q1–Q9 tabs and retain drafts. **Alt+0** selects Activity and releases keyboard
  focus. **Ctrl+C** copies selected message text; each
  message also reveals a **Copy** button on hover for copying its entire contents.
- Click the microphone in the top bar for separate **Listening** and **Sound
  effects** switches. Turn listening off to pause, or mute the bleeps while
  keeping Companion active. Pausing closes the
  recorder, cancels unfinished work, and discards partial speech. The microphone
  is grey while listening without speech, red when speech is detected, green
  while processing, and neutral when paused. Speech takes priority over an
  earlier utterance still processing. The dimmed icon means Companion is not running.
  Pause and sound controls remain responsive during manual recovery.
- An ascending two-note cue confirms successful delivery; a descending cue
  means ignored. A single note means accepted for processing. `--no-sounds`
  starts with them muted; the menu can enable them for the current session.
  Muting also stops playing and queued cues. Preview mode is silent and does not type.

**Super+Alt+C** toggles the compact panel in the bottom-right corner. The close
button also hides it. When closed, the panel disappears completely. Only the
open panel body captures mouse input; the desktop beneath it remains usable.
The vertical **Activity** tab has a stationary microphone whose colors
follow the bar. Each newly transcribed phrase rises above the mic in green, with
**PROCESSING** at its top left. After processing completes, the intent appears
at the top right: blue for `SEND_TEXT_TO_APPLICATION`, purple for
`ENTER_TEXT_TO_APPLICATION`, and muted for `IGNORE`. The phrase and label hold
for 1.4 seconds, then fade together over one second, leaving **Listening**.
Failed, skipped, cancelled, or interrupted processing shows the outcome in red
alongside any detected intent. Preview prefixes the intent with **PREVIEW** to
make clear that no keyboard input was sent.

Closing the panel or disconnecting stops its phrase animation. Opening it adopts
a phrase still being processed but does not replay completed history. A newer
phrase replaces an older result. Pausing shows **Paused** while any pending
phrase finishes; a disconnected Companion shows **Not running** and reconnects
through the existing service.

The default is the rightmost external monitor (by its logical right edge), with
built-in eDP/LVDS/DSI displays as the fallback. A single monitor always works.
Monitor changes are observed while the panel is open. The panel body is 420 by
400 logical pixels at the default theme scale, capped to the available screen
space. Quick questions open a new tab with a user bubble, streamed Markdown
answers, and expandable tool bubbles. Once its content exceeds the compact
body, a session uses 600 logical pixels of width and all available height.
The bottom edge stays fixed while the panel grows upward. The visible card
animates inside a stable native surface, avoiding per-frame Wayland window
resizes; only the visible card captures input.
A compact Activity visualization sits above each conversation and Previous
sessions, outside the scrolling content. Its arrow collapses it to a one-line
status or expands the microphone and phrase animation. The choice follows you
between tabs until the plugin is restarted; hidden animations stop immediately.
Returning to Activity restores the compact body. Each session has Stop and
Close session controls, plus a composer for follow-ups (Enter sends; Shift+Enter
inserts a newline). A follow-up resumes its Pi conversation. Closing the panel
keeps its questions running and retains its drafts. Right-click a question tab or
use the animated **×** at its top-right corner to stop and archive it. **Previous
sessions** at the bottom of the tab rail shows saved titles, dates, and status in
the pane to its right. Click an entry to reopen it without a model call. Drafts
survive close/reopen during the same UI lifetime; the saved transcript and PNG
survive Companion restarts. Errors from Close/Reopen remain visible in the panel.

Click an attached screenshot to open a separate viewer on the panel's display.
It uses the Omarchy menu palette and font, initially fits the whole image, and
provides scroll/button zoom, drag-to-pan, and Fit. Escape, the close button, and
the backdrop dismiss it. This viewer temporarily requests keyboard focus for
Escape and zoom shortcuts. Closing the panel or changing pages dismisses it too.
It respects the bar's reserved space and overlays windows without resizing them.
Activity does not accept keyboard focus. Session tabs use layer-shell OnDemand
focus to allow typing into the composer, following the compositor's normal focus
policy. The focus shortcut holds a dismissible Hyprland focus grab, so moving the
pointer outside the panel does not take keyboard focus away. Toggling again
returns to the captured application; an outside click releases the grab.
The adapter reports actual composer focus to preserve the delivery guard
when Hyprland still reports an underlying ordinary window. Opening history leaves
the panel open. Toggling the
panel cancels any held history selection without pasting. Rapid toggles reverse
the 180 ms slide animation.

The reusable QtQuick body lives in [`../panel`](../panel). It accepts state and
theme values and emits a close request. The Omarchy adapter alone owns the
Wayland windows, monitor choice, shortcut, and theme bindings. Future desktop
adapters can reuse that body or consume the same desktop state protocol. See
[quick questions](../../README.md#quick-questions) for Pi setup and session limits.

The global shortcut uses Hyprland's resident
[press/release protocol](https://quickshell.org/docs/v0.2.0/types/Quickshell.Hyprland/GlobalShortcut/)
so fast taps do not race separate helper processes. The picker follows Omarchy's
clipboard menu colors and fonts. Its rows are frozen during selection. Focus
stays in the destination application; temporary arrow/Escape bindings exist
only while the picker is visible and are removed when it closes.

The Lua adapter completes recovery only on the last shortcut-key release.
Hyprland combines modifiers from physical and virtual keyboards, so starting
`wtype` while Super/Alt remain held can turn transcript letters into shortcuts.
The service ignores the earlier `history` release from V and accepts only
`finish`. The backend's existing overlay-unmap delay is not a modifier guard.

Run `npm run test:quick-tap` from a desktop terminal for the isolated compositor
regression. It starts a nested Hyprland with its own configuration, runtime
directory, socket, synthetic history, and disposable GTK fields. It does not
install the plugin or use the running Companion's socket/database. Requires
Hyprland, Quickshell, wtype, and Python with GTK 4. See
[quick-tap validation](../../test/live/quick-tap.md) for the optional Chromium
fixture, the failure reproduced before the fix, and remaining limitations.

To remove the adapter, remove its `dofile` block from `~/.config/hypr/bindings.lua`,
remove `companion.desktop` entries from the bar layout and `plugins` list in
`~/.config/omarchy/shell.json`, and remove its plugin directory. Then run
`hyprctl reload`, `hyprctl configerrors`, and `omarchy-shell shell rescanPlugins`.
The utterance database is independent of the adapter and is retained.
