import QtQuick
import QtWebEngine
import QtWebChannel
import Companion.Widgets 1.0

// The trusted HTML list of open conversations inside the panel's rail
// (dist/rail.html). It replaces only the list of conversation tabs: the
// native Activity tab, Previous sessions, compact-rail Expand/Return and the
// divider stay around it, so Activity and settings remain reachable even if
// this page fails (the native tab list then returns).
//
// Same trust shape as TrustedChatView: Companion's own page from the fixed
// bundle (ShellProfile), one validating QWebChannel object, no capability
// URLs. Requests name a conversation ID, which must be one of the open
// conversations; each goes through the panel's existing signal, so pop-out,
// focus and return keep their existing rules and refusals.
//
// Not ported: drag reordering (Alt+Shift+Up/Down and the native list with
// --session-surface classic still reorder) and tab tooltips.
Item {
  id: root
  // The PanelContent that owns this rail.
  property var panel: null
  property bool pageReady: false
  property bool loadFailed: false
  readonly property bool failed: loadFailed || readyTimedOut || shellProfile.error !== ""
  // Bounded start-up handshake. The page counts as operational only after
  // its script connected and called ready(). A page that loads but never
  // gets there (missing or broken script) is treated as failed after this
  // long, so the native presentation stays (or becomes) the visible one.
  property int readyTimeoutMilliseconds: 10000
  property bool operational: false
  property bool readyTimedOut: false
  Timer {
    id: readyDeadline
    interval: root.readyTimeoutMilliseconds
    running: !root.operational && !root.readyTimedOut && shellProfile.documentUrl.toString() !== ""
    onTriggered: root.readyTimedOut = true
  }

  property int sequence: 0
  property string bundleDirectory: {
    const url = Qt.resolvedUrl("dist").toString()
    return url.startsWith("file://") ? decodeURIComponent(url.slice(7)) : ""
  }

  function cssColor(value) {
    return "rgba(" + Math.round(value.r * 255) + "," + Math.round(value.g * 255)
      + "," + Math.round(value.b * 255) + "," + value.a + ")"
  }

  function currentState() {
    const panel = root.panel
    const sessions = panel ? panel.sessions : []
    return {
      sessions: sessions.map((session, index) => ({
        id: session.id,
        number: index + 1,
        title: session.title || "",
        selected: !panel.showingPrevious && panel.selectedSessionId === session.id,
        running: session.status === "starting" || session.status === "running",
        unread: panel.unreadSessionIds[session.id] === true,
        poppedOut: panel.poppedSessionIds[session.id] === true,
        wakes: (session.wakes || []).filter(wake => wake.state === "scheduled" || wake.state === "waiting").length
      })),
      online: panel ? panel.online : false,
      popoutAvailable: panel ? panel.popoutAvailable : false,
      theme: panel ? {foreground: root.cssColor(panel.foreground), accent: root.cssColor(panel.accent),
        muted: root.cssColor(panel.muted), selection: root.cssColor(panel.selection),
        fontFamily: panel.fontFamily, unit: panel.tabUnit} : {}
    }
  }

  function publish() {
    if (!root.pageReady) return
    const state = root.currentState()
    root.sequence++
    state.seq = root.sequence
    bridge.message(JSON.stringify(state))
  }

  readonly property string watch: root.panel ? JSON.stringify([root.panel.sessions.map(entry => [entry.id, entry.title, entry.status, (entry.wakes || []).length]),
    root.panel.selectedSessionId, root.panel.showingPrevious, root.panel.unreadSessionIds, root.panel.poppedSessionIds,
    root.panel.online, root.panel.popoutAvailable, String(root.panel.foreground), String(root.panel.selection), root.panel.tabUnit]) : ""
  onWatchChanged: Qt.callLater(root.publish)

  QtObject {
    id: bridge
    WebChannel.id: "companion"
    signal message(string json)

    function open(id) {
      return root.panel !== null && typeof id === "string" && root.panel.sessions.some(entry => entry.id === id)
    }

    function ready() {
      if (root.readyTimedOut) return false
      root.pageReady = true
      root.operational = true
      root.publish()
      return true
    }

    function select(id) {
      if (!open(id)) return false
      // A popped-out conversation's tab focuses its window (panel rule).
      root.panel.sessionSelected(id)
      return true
    }

    function popOut(id) {
      if (!open(id) || !root.panel.popoutAvailable || root.panel.poppedSessionIds[id] === true) return false
      root.panel.popoutRequested(id)
      return true
    }

    function returnToPanel(id) {
      if (!open(id) || root.panel.poppedSessionIds[id] !== true) return false
      root.panel.returnRequested(id)
      return true
    }

    function close(id) {
      if (!open(id) || !root.panel.online) return false
      root.panel.dismissSessionRequested(id)
      return true
    }
  }

  WebChannel {
    id: channel
    registeredObjects: [bridge]
  }

  WebEngineView {
    id: browser
    objectName: "trustedRailBrowser"
    anchors.fill: parent
    backgroundColor: "transparent"
    webChannel: channel
    profile: ShellProfile {
      id: shellProfile
      surface: "rail"
      bundleDirectory: root.bundleDirectory
    }
    url: shellProfile.documentUrl

    settings.javascriptCanOpenWindows: false
    settings.javascriptCanAccessClipboard: false
    settings.javascriptCanPaste: false
    settings.localContentCanAccessFileUrls: false
    settings.localContentCanAccessRemoteUrls: false
    settings.dnsPrefetchEnabled: false
    settings.fullScreenSupportEnabled: false
    settings.screenCaptureEnabled: false
    settings.navigateOnDropEnabled: false
    settings.autoLoadIconsForPage: false
    settings.pdfViewerEnabled: false
    settings.errorPageEnabled: false
    settings.focusOnNavigationEnabled: false

    onNavigationRequested: request => {
      if (request.isMainFrame && request.url.toString() !== shellProfile.documentUrl.toString()) request.reject()
    }
    onNewWindowRequested: request => { /* No windows from the rail. */ }
    onPermissionRequested: permission => permission.deny()
    onFileDialogRequested: request => request.reject()
    onJavaScriptDialogRequested: request => request.reject()
    onFullScreenRequested: request => request.reject()
    onContextMenuRequested: request => request.accepted = true
    onLoadingChanged: request => {
      if (request.status === WebEngineView.LoadStartedStatus) root.pageReady = false
      if (request.status === WebEngineView.LoadFailedStatus) root.loadFailed = true
    }
    onRenderProcessTerminated: (status, exitCode) => {
      root.pageReady = false
      root.loadFailed = true
    }
  }
}
