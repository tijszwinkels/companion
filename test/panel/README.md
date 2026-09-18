# Panel checks

The portable panel components can be exercised without Omarchy, a microphone,
or an active desktop. With Qt 6's declarative development tools installed:

```sh
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

These checks cover overlapping speech/processing state, pause, disconnect and
reconnect, the close button, and monitor geometry changes without hotplug.
Surface tests exercise bottom/right anchoring through animated expansion and
shrinkage, rapid slide reversal, and bounds on small displays. Phrase
tests cover the rise, processing/result colors and label positions, the shared
fade, fast completion, interrupted animations, literal transcript text, and
opening without replaying old results. `npm test` also exercises monitor selection,
including mixed layouts, mirrored monitors, and a single built-in display.

Session checks cover incremental bubbles, opening a new tab only once, reconnect
snapshots, Markdown versus literal user/tool text, persistent tool disclosure,
content-driven expansion, Stop/Close controls, per-tab drafts, Enter/Shift+Enter,
and retaining edits across submission acknowledgements or errors. Library checks
cover right-click close, stable hover over the animated cross, history selection,
explicit restoration of known IDs, retained drafts, visible control errors,
screenshot thumbnails, initial fit, zoom/pan, and Escape/button/backdrop dismissal.
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
Verify the panel appears at the bottom right of the external monitor, without changing
keyboard focus or window sizes. Toggle rapidly during its slide and close it
with the button. While open, unplugging the external display should move it to
the remaining display. These diagnostic calls report and close the actual panel:

```sh
omarchy-shell companion status
omarchy-shell companion closePanel
```

The status reply includes `panelOpened`, `panelVisible`, and `panelMonitor`.
Check that clicks above the compact open body reach the application underneath
without moving keyboard focus, and that closing leaves no visible control.
`panelVisible` stays true during the short closing animation; mouse input is
released immediately when `panelOpened` becomes false. Opening speech history
leaves the panel open, including after cancelling or delivering the selection.
Toggling the panel still cancels history without delivering text.

For a session desktop check, say **“quick question …”**, verify its tab opens,
and click its composer after the answer finishes. Check typing, **“insert …”**,
and **“enter …”**, then move focus away during a slow dictation and verify it is
skipped or that Enter is suppressed. Check that a completed answer retains its
context on a follow-up, closing/reopening preserves drafts, and a long answer
expands the panel without reserving workspace area. Session tabs use OnDemand
keyboard focus; Activity still uses None. Give the user the advance reload and
focus-change warning before running any of these desktop checks.
