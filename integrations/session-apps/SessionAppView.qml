import QtQuick

// The conversation's own session application, filling the session content.
//
// The authored bundle runs in the existing restricted widget renderer
// (../panel/NativeWidgetView.qml): its own off-the-record WidgetProfile, the
// sandboxed iframe and CSP served by the listener, and a broker that maps
// exactly GET /, GET /state, POST /action and POST /query onto this
// application's capability URL. It gets no QWebChannel, no history, draft,
// chat sending, window commands or other conversations.
//
// Input: `application` (SessionApplicationDescriptor from the session
// snapshot). The listener keeps the same view capability across code
// replacement; this view reloads it when the descriptor's code version
// changes (the listener's host page also reloads itself on a new version).
// Closing the conversation revokes the capability.
Item {
  id: root
  property var application: null
  property bool running: true
  property color foreground: "white"
  property color background: "black"
  property color accent: "white"
  property color muted: "gray"
  property real textScale: 1
  readonly property string viewUrl: application && application.viewUrl ? application.viewUrl : ""
  readonly property int version: application ? application.version : 0
  // Replaced code keeps the same capability URL. Reload the restricted page
  // for a new code version, so the view never keeps running replaced code
  // (its requests would be refused with the old version anyway).
  property int loadedVersion: 0
  onVersionChanged: {
    if (embedded.item && loadedVersion !== 0 && version !== loadedVersion) embedded.item.reload()
    loadedVersion = version
  }
  readonly property string error: embedded.item ? embedded.item.error : embedded.status === Loader.Error ? "The application renderer could not load" : ""
  readonly property bool rendered: embedded.item !== null && embedded.item.rendered
  readonly property int nativeRenderScale: typeof CompanionWidgetRendering !== "undefined" ? CompanionWidgetRendering.renderScale : 1
  signal interactionStarted()

  function cssColor(value) {
    // QColor serializes translucent colors as #AARRGGBB, whereas CSS reads
    // eight-digit hex as #RRGGBBAA. Preserve both tint and opacity explicitly.
    return "rgba(" + Math.round(value.r * 255) + "," + Math.round(value.g * 255)
      + "," + Math.round(value.b * 255) + "," + value.a + ")"
  }

  Loader {
    id: embedded
    objectName: "sessionAppBrowserLoader"
    // Same supersampling as embedded widgets: Chromium renders a larger
    // viewport that Qt maps back into this area.
    width: Math.max(0, root.width) * root.nativeRenderScale
    height: Math.max(0, root.height) * root.nativeRenderScale
    scale: 1 / root.nativeRenderScale
    transformOrigin: Item.TopLeft
    active: root.viewUrl !== ""
    source: active ? Qt.resolvedUrl("../panel/NativeWidgetView.qml") : ""
    onLoaded: {
      item.objectName = "sessionAppBrowser"
      item.viewUrl = Qt.binding(function() { return root.viewUrl })
      item.running = Qt.binding(function() { return root.running })
      item.theme = Qt.binding(function() {
        return {foreground: root.cssColor(root.foreground), background: root.cssColor(root.background),
          accent: root.cssColor(root.accent), muted: root.cssColor(root.muted), scale: root.textScale}
      })
    }
  }

  Connections {
    target: embedded.item
    function onInteractionStarted() { root.interactionStarted() }
  }
}
