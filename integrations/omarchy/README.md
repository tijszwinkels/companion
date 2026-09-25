# Omarchy adapter

This optional adapter contains the entire shell integration: the bar button,
themed utterance picker, Activity side panel, and Hyprland shortcuts. Companion itself has no dependency
on this plugin. The [local protocol](../../src/desktop/README.md) can support other
desktop adapters without changing the sensor pipeline or processors.

The [standalone Qt host](../../native/window/README.md) displays conversations and
embedded Chromium widgets without changing the installed Quickshell. This adapter
automatically hands off the panel, shortcuts and theme when that host is running.

An experimental [native Chromium widget renderer](../../native/widget-renderer/README.md)
uses a private WebEngine-enabled Quickshell build. Installing this adapter or
restarting the listener alone does not switch the running shell to that host.

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
- **Super+Alt+D** focuses the visible conversation or Activity input, opening the
  panel if hidden. From Previous sessions it selects Activity. Press it again to
  return to the previous application.
- With the panel focused, **Alt+1** through **Alt+9** select the corresponding
  Q1–Q9 tabs and retain drafts. **Super+Alt+0** (or **Alt+0**) selects Activity;
  **Super+Alt+Tab** cycles Activity → conversations → Activity. Activity retains
  panel focus for these local shortcuts, with no hidden composer.
  Super+Alt+Tab keeps its original group-window action outside Companion; no
  desktop-wide numbered shortcuts are registered.
- Drag a conversation tab, or use **Alt+Shift+Up/Down** while the panel is
  focused, to move it. Activity and Previous stay fixed. Q1–Q9, Alt-number and
  **“Go to session one”** (also digits 1–9) use this same order. Spoken navigation
  works from any visible panel page, has its own shortcut toggle, and rejects
  stale/invalid targets without sending text to an agent. Order survives UI
  reconnects for this listener run; new/reopened tabs append.
- Drag the divider beside the tab rail to widen it. The larger tab heights,
  icons and text remain unchanged; captions use the extra width. The rail stays
  between 80 and 280 theme units and leaves at least 320 units for the body where
  the host is wide enough. Narrowing temporarily clamps the width. The preferred
  width lasts for this UI process, including native presentation changes.
- The bottom conversation model picker applies to **this session's next turn**.
  It lists Pi's available configured models and can restore that conversation's
  coding/quick-question default. Overrides survive closing and reopening, while
  running turns and other sessions keep their models. Thinking follows the
  conversation profile, or `off` for models without reasoning. The picker does
  not edit profile or Pi configuration. A Claude Code conversation's picker
  lists Claude models only and switches its next turn in the same Claude
  history; its effort stays as it started and has no picker.
- While the panel has keyboard focus, **Super+minus** widens it and
  **Super+equals** narrows it by 100 logical pixels. These are Omarchy's existing
  physical horizontal-resize keys (`code:20`/`code:21`); their original window
  actions still run outside Companion. Shift/Alt/Ctrl variants are unchanged.
  **Ctrl+C** copies selected message text; each
  message also reveals a **Copy** button on hover for copying its entire contents.
- Click the microphone in the top bar for separate **Listening** and **Sound
  effects** switches. Turn listening off to pause, or mute the bleeps while
  keeping Companion active. Pausing closes the
  recorder, cancels unfinished work, and discards partial speech. The microphone
  is grey while listening without speech, red when speech is detected, green
  while processing, and neutral when paused. Speech takes priority over an
  earlier utterance still processing. The dimmed icon means Companion is not running.
  Pause and sound controls remain responsive during manual recovery.
- Application delivery uses an ascending two-note cue; a new agent session uses
  a three-note rise, and a continuation/choice uses a higher descending pair.
  Ignored input uses a low descending pair; a successful agent turn has its own
  completion cue. A single note means accepted for processing. `--no-sounds`
  starts with them muted; the menu can enable them for the current session.
  Muting also stops playing and queued cues. Preview mode is silent and does not type.

**Super+Alt+C** toggles the full-height panel along the right edge. The close
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

Activity shows floating voice-prefix labels and separate clickable **Intent**
(accent) and **Shortcut** (amber) cards derived from the live router. Each route
can be disabled independently. Off or context-unavailable cards turn grey and
explain their state; cards retain their prefix text, while floating labels show
available shortcuts. A disabled prefix stays reserved rather than falling
through to another route. Hover a card for its identifier. `IGNORE` is the
always-on fallback. Switches persist in `~/companion/disabled-intents.json`.
Paused/offline labels are dimmed; older backends show a restart hint.

The Activity page starts with the listening area. Its shortcut labels, intention cards,
and keyboard help occupy one measured vertical column. The page scrolls on small
displays above the fixed bottom input; keyboard help reserves its wrapped height instead of overlapping
the switches. Intention cards use “intent” and “shortcut” for their routing modes
and show their spoken prefixes, including when switched off. Standalone commands
have no trailing ellipsis. Listening, History, Voice shortcuts, and Intentions
can each be collapsed by clicking the section header; their state lasts for the
current UI lifetime.

The bottom Activity input sends text through the same capture, intent/prefix
routing and history pipeline as speech, without ASR or a WAV recording. Enter
or Send submits; Shift+Enter adds a newline. It restores the previous application
before capturing and retains the draft on focus, connection or admission failure.
It also works with listening paused. Update the listener, UI and installed adapter
together for this capability; a listener restart alone cannot update the bridge.

History sits below Intentions. Completed utterances fade into cards, newest first,
with the original detected intent in a smaller corner label. It retains every
completed utterance from the current **Companion listener run**; panel closes and
socket reconnects preserve that run. The older Super+Alt+V picker remains a
separate 100-entry view spanning restarts. A listener restart begins a fresh
Activity history; saved database rows, recordings and feedback remain on disk.

Hover a card for **Copy**, **Insert**, **New coding session**, **Label correct**,
**Label incorrect**, and the delete **×**. Deletion removes its SQLite row,
dependent feedback/paste records and UUID-named PNG/WAV artifacts; active processing
or pasting prevents deletion. The card disappears after backend confirmation.
Copy keeps the text literal. Insert releases panel focus
to the active ordinary application, checks focus through the delivery queue, and
never presses Enter. New coding session uses the original saved screenshot and
utterance, with an error if that screenshot is unavailable. Correct labels tint
the card green; incorrect labels tint it red and disclose intent-choice chips.
Choosing a chip saves the intended intent separately from the original prediction.
Closing the choices leaves an incorrect label without inventing an intended one.
Colors follow acknowledged storage changes, including the spoken labeling commands.
The new history controls require a listener restart after upgrading the backend.

Inside the focused panel, **Ctrl+plus** (or **Ctrl+equals**) increases text size,
**Ctrl+minus** decreases it, and **Ctrl+0** resets it. Reader zoom ranges from
80% to 200% in 10% steps and follows you between Activity, conversations, and
Previous sessions. It lasts until the panel plugin restarts. Text reflows within
the existing panel width; shortcuts do not affect other applications.

Closing the panel or disconnecting stops its phrase animation. Opening it adopts
a phrase still being processed but does not replay completed history. A newer
phrase replaces an older result. Pausing shows **Paused** while any pending
phrase finishes; a disconnected Companion shows **Not running** and reconnects
through the existing service.

**Super+Alt+D** also pauses currently playing media when it focuses an Activity or conversation
input. This uses MPRIS Pause on players that support it. Companion resumes listening
when all players report that playback has stopped, unless you manually paused
listening. Leaving the input (by toggling focus back, clicking elsewhere, closing
the panel) resumes only players Companion paused for that
interaction. Players that were already paused, were stopped/closed, or resumed
independently are left alone. Ordinary textbox clicks do not initiate media
pausing, and switching directly between focused inputs keeps media paused.

For the Quickshell-hosted panel, the default is the rightmost external monitor (by its logical right edge), with
built-in eDP/LVDS/DSI displays as the fallback. A single monitor always works.
Monitor changes are observed while the panel is open. Every tab, including
Activity, starts at 600 logical pixels of width at the default theme scale and
uses all available height below the bar. Resizing is bounded between 360 logical
pixels and the monitor width (smaller monitors use their full width). The chosen
width survives tab switches and closing the panel, until the plugin restarts.
Quick questions open
a new tab with a user bubble, streamed Markdown answers, and expandable tool
bubbles. Switching tabs keeps the panel the same size. The visible card slides
inside a stable native surface; only the visible card captures input.

The resize installer check rejects custom actions when Hyprland reports the
physical keycode or a minus/equal symbol. Hyprland 0.56.2 can report Lua physical
bindings with an empty key and keycode zero, so those cannot be identified from
`hyprctl -j binds`; inspect personal Lua overrides before installing on such a
configuration. The packaged Omarchy horizontal actions are the supported defaults.
A compact Activity visualization sits above each conversation and Previous
sessions, outside the scrolling content. Its arrow collapses it to a one-line
status or expands the microphone and phrase animation. The choice follows you
between tabs until the plugin is restarted; hidden animations stop immediately.
Each session has Stop and
Close session controls, plus a composer for follow-ups (Enter sends; Shift+Enter
inserts a newline). A follow-up resumes its Pi or Claude Code conversation.
Closing the panel
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
Activity and session tabs use layer-shell OnDemand focus for local navigation
and typing into conversation composers. Opening the panel does not take focus
from the application. The focus shortcut holds a dismissible Hyprland focus grab, so moving the
pointer outside the panel does not take keyboard focus away. Toggling again
returns to the captured application; an outside click releases the grab.
The adapter reports actual composer focus to preserve the delivery guard
when Hyprland still reports an underlying ordinary window. Opening history leaves
the panel open. Toggling the
panel cancels any held history selection without pasting. Rapid toggles reverse
the 180 ms slide animation.

The reusable QtQuick body lives in [`../panel`](../panel). It accepts state and
theme values and emits a close request. For the Quickshell panel, the adapter owns
the Wayland windows and monitor choice. With the standalone host running, that
host owns the conversation surfaces and the adapter bridges shortcuts, theme,
media and focus restoration through `NativeBridge.qml`. Future desktop
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
