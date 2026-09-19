import QtQuick

// Portable focus-toggle lifecycle. The adapter holds a dismissible panel focus
// grab across tab navigation, and restores the captured application on release.
// actualFocus describes the native window; Activity has focus without a composer.
QtObject {
  id: root
  property bool available: false
  property bool mapped: false
  property bool actualFocus: false
  property bool requested: false
  property string sessionId: ""
  property string phase: "idle"
  property string previousWindow: ""
  property int settleDuration: 75
  readonly property bool grabRequested: available && requested
  readonly property string keyboardMode: !available || phase === "releasing" ? "none" : "on-demand"

  signal focusRequested()
  signal releaseRequested()
  signal restoreRequested(string address)

  function reset() {
    settling.stop()
    const hadFocus = root.actualFocus || root.requested || root.phase !== "idle"
    root.requested = false
    root.phase = "idle"
    root.previousWindow = ""
    if (hadFocus) root.releaseRequested()
  }

  function toggle(address, inputFocused = root.actualFocus) {
    if (!root.available) return
    settling.stop()
    if (inputFocused || root.requested) {
      // Click-focused composers also support toggle-off. In that case the
      // adapter supplies the last ordinary application as the return target.
      if (!root.previousWindow) root.previousWindow = address
      root.phase = "releasing"
      root.requested = false
      root.releaseRequested()
      settling.restart()
    } else {
      root.previousWindow = address
      root.phase = "acquiring"
      root.requested = true
      if (root.mapped) {
        root.focusRequested()
        if (root.actualFocus) root.phase = "idle"
      }
    }
  }

  onAvailableChanged: if (!available) reset()
  // An empty session id is Activity, which keeps an acquired grab. A pending
  // release still resets, so changing tabs cannot revive cancelled focus.
  onSessionIdChanged: if (!requested || !actualFocus || !available) reset()
  onActualFocusChanged: {
    if (actualFocus && phase === "acquiring") root.phase = "idle"
    else if (!actualFocus && phase === "idle") {
      // An outside click or another explicit focus change belongs to that
      // destination. Drop our grab without bouncing back to the captured app.
      root.requested = false
      root.previousWindow = ""
    }
  }
  onMappedChanged: {
    if (mapped && phase === "acquiring") root.focusRequested()
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
