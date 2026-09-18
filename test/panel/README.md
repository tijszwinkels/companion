# Panel checks

The portable panel components can be exercised without Omarchy, a microphone,
or an active desktop. With Qt 6's declarative development tools installed:

```sh
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

These checks cover overlapping speech/processing state, pause, disconnect and
reconnect, and the close button. `npm test` also exercises monitor selection,
including mixed layouts, mirrored monitors, and a single built-in display.

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
`panelVisible` stays true during the short closing animation; mouse input is
released immediately when `panelOpened` becomes false. Opening speech history
closes the panel, and opening the panel cancels history without delivering text.
