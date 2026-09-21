import QtQuick
import QtWebEngine
import Companion.Widgets 1.0

// Loaded only by a host that initialized WebEngine and the private scheme.
// This is a real scene-graph browser view, not an image or input relay.
WebEngineView {
  id: browser
  objectName: "nativeWidgetBrowser"
  property string viewUrl: ""
  property var theme: ({})
  property bool running: true
  property bool rendered: false
  property string loadError: ""
  readonly property string error: loadError || guardedProfile.error
  property real measuredHeight: 240
  property string appliedTheme: ""
  property bool checking: false
  property int generation: 0
  property var lifetime: ({active: true})
  signal interactionStarted()

  visible: running
  backgroundColor: theme.background || "transparent"
  focus: true
  profile: WidgetProfile { id: guardedProfile; viewUrl: browser.viewUrl }
  url: guardedProfile.documentUrl

  onViewUrlChanged: {
    generation++
    rendered = false
    loadError = ""
    appliedTheme = ""
    // The profile aborts old requests; reloading is required even though its
    // synthetic document URL stays constant across capabilities.
    if (url.toString() !== "" && url.toString() === guardedProfile.documentUrl.toString()) {
      Qt.callLater(function() { if (browser.viewUrl !== "") browser.reload() })
    }
  }
  onActiveFocusChanged: if (activeFocus) interactionStarted()
  onRunningChanged: if (running) inspect.restart()
  Component.onDestruction: lifetime.active = false

  settings.javascriptCanOpenWindows: false
  settings.javascriptCanAccessClipboard: false
  settings.javascriptCanPaste: false
  settings.localContentCanAccessFileUrls: false
  settings.localContentCanAccessRemoteUrls: false
  settings.dnsPrefetchEnabled: false
  settings.webRTCPublicInterfacesOnly: true
  settings.fullScreenSupportEnabled: false
  settings.screenCaptureEnabled: false
  settings.navigateOnDropEnabled: false
  settings.autoLoadIconsForPage: false
  settings.playbackRequiresUserGesture: true
  settings.pdfViewerEnabled: false
  settings.errorPageEnabled: false
  settings.focusOnNavigationEnabled: false

  // WebRTC is not an HTTP request and must not become a networking escape
  // around the profile interceptor. Install before any author code, in every
  // frame, without exposing a QWebChannel or other native objects to the page.
  userScripts.collection: [{
    name: "Companion display-only browser APIs",
    injectionPoint: WebEngineScript.DocumentCreation,
    worldId: WebEngineScript.MainWorld,
    runsOnSubFrames: true,
    sourceCode: "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'WebTransport']) Object.defineProperty(globalThis, name, {value: undefined, writable: false, configurable: false});"
  }]

  onNavigationRequested: request => {
    if (request.isMainFrame && request.url.toString() !== guardedProfile.documentUrl.toString()) request.reject()
  }
  onNewWindowRequested: request => { /* No window is accepted from widget content. */ }
  onPermissionRequested: permission => permission.deny()
  onFileDialogRequested: request => request.reject()
  onJavaScriptDialogRequested: request => request.reject()
  onFullScreenRequested: request => request.reject()
  onContextMenuRequested: request => request.accepted = true
  onLoadingChanged: request => {
    if (request.status === WebEngineView.LoadStartedStatus) rendered = false
    if (request.status === WebEngineView.LoadFailedStatus) loadError = "Could not open embedded widget"
  }
  onRenderProcessTerminated: (status, exitCode) => {
    rendered = false
    loadError = "The embedded widget renderer stopped"
  }

  // This small metadata poll fits the surrounding bubble and applies theme
  // changes. Chromium independently draws/animates and handles native input;
  // no frame capture or pointer/keyboard transport runs on this path.
  Timer {
    id: inspect
    interval: 200
    repeat: true
    running: browser.running && browser.viewUrl !== ""
    onTriggered: {
      if (browser.checking) return
      browser.checking = true
      const lifetime = browser.lifetime
      const generation = browser.generation
      const theme = JSON.stringify(browser.theme)
      const update = theme !== browser.appliedTheme
        ? "window.widgetHost.setTheme(" + theme + ");" : ""
      browser.runJavaScript("(() => { if (!window.widgetReady) return null; " + update
        + " return {height: window.widgetContentHeight || 240}; })()", function(result) {
        if (!lifetime.active) return
        browser.checking = false
        if (generation !== browser.generation || !result) return
        browser.rendered = true
        browser.appliedTheme = theme
        browser.measuredHeight = Math.max(0, Math.min(2200, Number(result.height) || 240))
      })
    }
  }
}
