# Panel checks

The portable panel components can be exercised without Omarchy, a microphone,
or an active desktop. With Qt 6's declarative development tools installed:

```sh
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

These checks cover overlapping speech/processing state, pause, disconnect and
reconnect, the close button, and monitor geometry changes without hotplug. Phrase
tests cover the rise, processing/result colors and label positions, the shared
fade, fast completion, interrupted animations, literal transcript text, and
opening without replaying old results. `npm test` also exercises monitor selection,
including mixed layouts, mirrored monitors, and a single built-in display.

`npm run test:quick-tap` includes combined panel/history shortcut cases in a
disposable nested compositor: focus preservation, history alongside the panel,
and history cancellation when toggling the panel. See [the fixture instructions](../live/quick-tap.md) for GTK/Chromium
options and validation limits. Its outer window may briefly take desktop focus;
warn the user before running it. All generated input targets the nested compositor.

For a desktop check, install this worktree's adapter, then use **Super+Alt+C**.
Verify the panel appears on the external monitor, below the bar, without changing
keyboard focus or window sizes. Toggle rapidly during its slide and close it
with the button. While open, unplugging the external display should move it to
the remaining display. These diagnostic calls report and close the actual panel:

```sh
omarchy-shell companion status
omarchy-shell companion closePanel
```

The status reply includes `panelOpened`, `panelVisible`, and `panelMonitor`.
Check that clicks below the compact open body reach the application underneath
without moving keyboard focus, and that closing leaves no visible control.
`panelVisible` stays true during the short closing animation; mouse input is
released immediately when `panelOpened` becomes false. Opening speech history
leaves the panel open, including after cancelling or delivering the selection.
Toggling the panel still cancels history without delivering text.
