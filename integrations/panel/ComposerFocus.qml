import QtQuick

// Portable focus-toggle lifecycle. The adapter translates keyboardMode into
// its window system's policy and restores the captured application on release.
QtObject {
  id: root
  property bool available: false
  property bool mapped: false
  property bool actualFocus: false
  property string sessionId: ""
  property string phase: "idle"
  property string previousWindow: ""
  property int settleDuration: 75
  readonly property string keyboardMode: !available || phase === "releasing" ? "none"
    : phase === "acquiring" ? "exclusive" : "on-demand"

  signal focusRequested()
  signal releaseRequested()
  signal restoreRequested(string address)

  function reset() {
    settling.stop()
    const hadFocus = root.actualFocus || root.phase !== "idle"
    root.phase = "idle"
    root.previousWindow = ""
    if (hadFocus) root.releaseRequested()
  }

  function toggle(address) {
    if (!root.available) return
    settling.stop()
    if (root.actualFocus || root.phase === "acquiring") {
      // Click-focused composers also support toggle-off. In that case the
      // adapter supplies the last ordinary application as the return target.
      if (!root.previousWindow) root.previousWindow = address
      root.phase = "releasing"
      root.releaseRequested()
      settling.restart()
    } else {
      root.previousWindow = address
      root.phase = "acquiring"
      root.focusRequested()
      if (root.mapped) settling.restart()
    }
  }

  onAvailableChanged: if (!available) reset()
  onSessionIdChanged: reset()
  onActualFocusChanged: if (!actualFocus && phase === "idle") previousWindow = ""
  onMappedChanged: {
    if (mapped && phase === "acquiring") settling.restart()
    else if (!mapped && phase !== "acquiring") reset()
  }

  property Timer settling: Timer {
    interval: root.settleDuration
    onTriggered: {
      if (root.phase === "releasing") {
        // Keep keyboardMode=None through the restore request so the native
        // surface has relinquished its keys before focusing another window.
        const address = root.previousWindow
        root.previousWindow = ""
        root.restoreRequested(address)
      }
      root.phase = "idle"
    }
  }
}
