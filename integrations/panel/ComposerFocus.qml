import QtQuick

// Portable focus-toggle lifecycle. The adapter holds a dismissible focus grab
// while requested, and restores the captured application on explicit release.
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

  function toggle(address) {
    if (!root.available) return
    settling.stop()
    if (root.actualFocus || root.requested) {
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
      if (root.mapped) root.focusRequested()
    }
  }

  onAvailableChanged: if (!available) reset()
  // Changing between conversations keeps an explicitly acquired grab and its
  // return destination. Losing the conversation or an in-progress release
  // still resets, so tab navigation cannot revive a cancelled focus request.
  onSessionIdChanged: if (!requested || !actualFocus || !available || !sessionId) reset()
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
