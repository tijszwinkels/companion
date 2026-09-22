# Panel checks

The portable panel components can be exercised without Omarchy, a microphone,
or an active desktop. With Qt 6's declarative development tools installed:

```sh
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

Dynamic-choice tests cover pinned choices above the composer, actual clicks with
revision/index identity, retained freeform drafts, pending acknowledgements,
label-only and described options, permanent-shortcut collisions, paused/offline
voice highlighting, current-run Stop, tab changes, replacement, errors and eight
long choices in a small panel. The synthetic image is
`/tmp/companion-agent-choices-preview.png`. Backend, native-tool and lifecycle
coverage is described in [conversation choices](../../src/agents/README.md).

Session-indicator checks cover running-ring animation gating, whole emoji tokens,
unread completions while hidden/on other pages, read-on-view without focus,
duplicate updates, reconnects during queued turns, and close/restore cleanup.
The synthetic layout preview is `/tmp/companion-session-indicators.png`. These
offscreen checks do not exercise the installed Wayland surface or live agents.

Playback checks inject player objects into the adapter's state aggregator: an
already-playing player, state changes, multiple simultaneous players, removal,
and reappearance. They also check pause-only commands, unsupported players,
waiting for player acknowledgements, and focus acquisition versus release or
cancellation. Restore checks cover only previously playing players, quick release
before Pause replies, outside focus loss, duplicate callbacks, user stop/resume,
removed/replaced players and missing Play capability. Pending restoration waits
for Paused (the installed Quickshell suppresses Play while still Playing), is
cancelled by refocusing, and expires after five seconds without acknowledgement.
Status checks distinguish
media pause from manual pause.
Node checks exercise the real private socket, report validation/ownership,
disconnect recovery, explicit resume, disabled file/text modes, and cancellation
of queued/in-flight speech. These tests do not start or pause real media. Live
MPRIS reads confirmed that Chromium and cliamp expose PlaybackStatus; an installed
adapter's end-to-end response to real playback still needs a desktop check.

These checks cover overlapping speech/processing state, pause, disconnect and
reconnect, the close button, and monitor geometry changes without hotplug.
Surface tests exercise full-height sizing, rapid slide reversal, and bounds on
small displays. Phrase
tests cover the rise, processing/result colors and label positions, the shared
fade, fast completion, interrupted animations, literal transcript text, and
opening without replaying old results. `npm test` also exercises monitor selection,
including mixed layouts, mirrored monitors, and a single built-in display.
Focus checks cover holding keyboard ownership until explicit release, delayed restoration
after releasing keyboard ownership, rapid toggles, cancellation on tab/visibility
changes, waiting for a mapped surface, and preserving the actual composer's draft.
The staged installer checks first-install reloads, QML-only reinstall without a
Lua rewrite/reload, changed-shortcut reloads, copied components, retained config,
and rejection of a conflicting focus shortcut before any configuration writes.

Session checks cover incremental bubbles, opening a new tab only once, reconnect
snapshots, Markdown versus literal user/tool text, persistent tool disclosure,
Stop/Close controls, per-tab drafts, Enter/Shift+Enter,
and retaining edits across submission acknowledgements or errors. Library checks
cover right-click close, stable hover over the animated cross, history selection,
explicit restoration of known IDs, retained drafts, visible control errors,
screenshot thumbnails, initial fit, zoom/pan, and Escape/button/backdrop dismissal.
Markdown checks cover paragraph spacing, proportional prose versus smaller code,
escaped markup, safe links, streamed fences, nested lists, tables, long-code wrapping,
and actual Ctrl++/Ctrl+=/Ctrl+-/Ctrl+0 key events with draft preservation and zoom limits.
Activity/history checks exercise the same reader zoom across Activity, Previous
sessions and conversations, including narrow layouts at 200% and the ordering of
History below Intentions.
They also write `/tmp/companion-markdown-preview.png` for visual inspection.
Scrolling checks send real Qt wheel events over the message body, check the faster
step and both bounds, and preserve selection, composer focus and drafts during
scrolling. Stream updates preserve the reader's position until scrolling back to
the bottom. The old adapter moved 72 pixels per notch in the same offscreen test;
the new setting moves 216. Native touchpad gestures have not been exercised here.
Copy checks use only the offscreen platform's private clipboard: actual Ctrl+C
events with and without composer focus, native composer selection precedence,
whole-message hover copying, collapsed tool output, and preserving drafts and
selection. Numbered-tab checks exercise Alt+0 for Activity, Alt+1–9, current tab order after removal,
missing numbers, hidden-panel gating, and retained drafts. Focus checks also
cover keeping the grab and original return window across conversation and
Activity changes, with no hidden composer receiving ordinary text on Activity.
Local Super+Alt+0/Tab checks cover cycling, wraparound, empty conversations,
retained drafts and closed-panel gating.
Compact Activity checks cover live state and phrase/result propagation, fade,
collapse/expand, adopting pending work without replaying completed results,
hidden-animation cleanup, a header fixed during transcript scrolling, and
retaining drafts, focus, and the collapsed setting across tabs. Synthetic
previews are saved to `/tmp/companion-activity-{processing,result,collapsed}-preview.png`.
The compact header has offscreen coverage; its native desktop interaction has
not been exercised by automated input.
Intent-control checks click the real Activity chips, wait for backend-owned
state changes, and check off/context/paused/offline colors, shortcut visibility,
the fixed IGNORE fallback, and scrolling in small panels. The synthetic preview
is `/tmp/companion-intent-controls-preview.png`. Node tests cover prompt exclusion,
disabled-prefix consumption, late inference, cancellation, private socket control,
validation, serialized atomic preference writes and reload. These tests do not
inject input into the desktop or change the user's stored switches.
Activity layout checks include the production four-line keyboard-help text,
monospace and proportional fonts, narrow/short displays, and a larger theme scale.
They verify measured spacing between listening, controls and keyboard
help, text fitting its cards, and a clipped area for live phrases. Additional
previews are `/tmp/companion-activity-layout-{tall,small,processing,result}.png`.
The synthetic image fixture has no user content. The suite writes offscreen visual
previews to `/tmp/companion-{session,history,screenshot}-preview.png` for inspection. The Node suite
uses a real fixture subprocess for Pi RPC framing, images, streaming, retries,
cancellation, failures, and missing resume history. Storage checks cover private
atomic PNG/JSON writes, missing images, damaged snapshots, interrupted turns,
restart/archive/reopen/resume, failed saves, and concurrent Close/Follow-up. Private-socket tests exercise
follow-ups and composer focus transitions, including suppressing Enter when the
underlying ordinary window address has not changed.

Real Pi 0.85.1 smoke checks with `openai-codex/gpt-6-astra` at medium thinking
passed for a synthetic 64×64 image, incremental answer output, a read-tool call,
and a follow-up remembering the original image without resending it. These are
backend checks, not live panel or dictation validation. No tests in this feature
run connected to the user's compositor. The staged installer used inert desktop
commands and a temporary config directory.

`npm run test:quick-tap` includes combined panel/history shortcut cases in a
disposable nested compositor: focus preservation, history alongside the panel,
and history cancellation when toggling the panel. See [the fixture instructions](../live/quick-tap.md) for GTK/Chromium
options and validation limits. Its outer window may briefly take desktop focus;
warn the user before running it. All generated input targets the nested compositor.

For a desktop check, install this worktree's adapter, then use **Super+Alt+C**.
Verify the panel fills the available height along the right edge of the external monitor, without changing
keyboard focus or window sizes. Toggle rapidly during its slide and close it
with the button. While open, unplugging the external display should move it to
the remaining display. These diagnostic calls report and close the actual panel:

```sh
omarchy-shell companion status
omarchy-shell companion closePanel
```

The status reply includes `panelOpened`, `panelVisible`, and `panelMonitor`.
Check that clicks to the left of the open panel reach the application underneath
without moving keyboard focus, and that closing leaves no visible control.
`panelVisible` stays true during the short closing animation; mouse input is
released immediately when `panelOpened` becomes false. Opening speech history
leaves the panel open, including after cancelling or delivering the selection.
Toggling the panel still cancels history without delivering text.

For a session desktop check, say **“quick question …”**, verify its tab opens,
and click its composer after the answer finishes. Check typing, **“insert …”**,
and **“enter …”**, then move focus away during a slow dictation and verify it is
skipped or that Enter is suppressed. Check that a completed answer retains its
context on a follow-up, closing/reopening preserves drafts, and switching between
Activity and conversations keeps the same panel size without reserving workspace area.
Both accept OnDemand keyboard focus. Give the user the advance reload and
focus-change warning before running any of these desktop checks.
Use **Super+Alt+D** with a selected conversation to focus the input; use it again
to return to the previous application. Also check a hidden panel, a click-focused
composer, rapid toggles, and a previous application that has since closed.
`npm run test:panel-focus` exercises the native focus path in a disposable nested
Hyprland with `follow_mouse=1`. It uses a private Super+Alt+F10 binding and synthetic
windows: the composer must retain focus past 75 ms and while the pointer moves
outside, accept typed text, toggle back without losing its draft, and acquire
focus from a hidden panel. It also verifies the production restore
path after Alt+1/2 tab switches and draft edits; Ctrl+C is checked against the
nested compositor's private clipboard, leaving the desktop clipboard untouched.
A separate assertion verifies the production restore
command can select the captured application from another window. Warn the user
first: the outer nested window may briefly take desktop focus. All generated
input stays inside the private compositor; no real backend or conversation is used.
`COMPANION_FOCUS_REF=d6dd76c npm run test:panel-focus` reproduces the old timed-focus
failure using the same fixture. Both the failing baseline and passing fix have
been checked. Outside-click dismissal, click-focused composers, and monitor-specific
behavior still need the manual checks above.

The same native fixture then connects the production Service to synthetic
sessions on the nested runtime's private socket. It loads the production Lua
adapter and exercises Super+Alt+0/Tab and Alt+numbers from Activity and
conversations, then verifies that navigation cannot affect an unfocused or
hidden panel. Lua tests check the native group-next fallback when the panel is
absent. No real Companion data or model is used. The runner waits for a native
output before starting Qt to avoid its startup placeholder-screen race.

The native fixture also sends the physical Super+minus/equal chords: Activity
resizes without losing focus, and the original window resize works with an
unfocused or hidden panel. It seeds wtype's synthetic keymap to put those keys at
XKB codes 20/21, rather than relying on symbolic shortcut matching. Offscreen
surface tests cover bounds, theme scale, monitor-size changes, right anchoring,
and retaining width after closing and reopening.

Activity history tests cover bounded reconnect pages interleaved with newer
feedback, listener replacement, all hover action payloads, correction chips,
feedback colors, section collapse without losing rows, more than 100 entries,
and wrapped metadata at narrow widths. Synthetic previews are saved to
`/tmp/companion-activity-history-preview.png` and its `-narrow` variant.
Backend tests use real private sockets/SQLite and a recording agent backend;
they check completion gating, retention, direct labels, missing screenshots,
original observations, and panel-focus rejection before insertion.

The native focus runner finally replaces its synthetic session server with the
real DesktopRuntime and a private SQLite database. It exercises the adapter's
history action handler from focused Activity through native focus release and
the real keyboard delivery queue, checking exact inserted text and exactly one
successful paste record. Feedback and recorded-frame session creation are checked
with the same private runtime; the agent backend does not launch Pi. Mouse action
wiring is exercised separately by the offscreen card tests.

Contextual voice routing is covered offline by real private-socket tests:
focused-composer eligibility, the exact continuation prompt, both model-selecting start shortcuts,
direct messages to an unfocused visible chat, and cancellation/preview/stale
target handling. The pipeline test holds ASR open while the selected tab changes
to verify that the original interaction snapshot survives. On a later desktop
check, focus a composer and speak a follow-up without a prefix, then verify
`continue session …` targets that same visible chat from another application's
focus and `new session …` always creates a fresh coding tab. `quick question …`
opens a local Qwen conversation, whose profile survives queued turns and reopening.
These new voice paths
have not been exercised on the live compositor.

Lazy-tool checks exercise collapsed-by-default groups, active group growth,
explicit first-page requests, literal text, page replacement, Copy page and
selection, streaming revision invalidation, collapse/re-expand, errors,
disconnect/reconnect and close/reopen identity. Native Client replies are routed
through the same portable component without retaining page bodies in session
state. Backend fixtures verify 1,500 calls in one row, a <2 KB snapshot instead of

> 1.5 MB of raw tool output, lossless multi-megabyte input/results, exact 1M/800
> ordinary display budgets, legacy migration and private restart restoration,
> late Pi events, storage failures, and correlated private-socket ownership checks.
> These are synthetic offscreen/private-socket checks, not live desktop deployment.
