import QtQuick
import QtQuick.Controls
import QtQuick.Window

// The host owns sizing, lifecycle and controls. A prepared WebEngine host uses
// direct rendering; portable hosts retain the captured-frame implementation.
FocusScope {
  id: root
  property var reference: null
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  property string fontFamily: "sans-serif"
  property real unit: 1
  property real textScale: 1
  property real pixelRatio: Screen.devicePixelRatio
  property bool nativeRendering: false
  readonly property int nativeRenderScale: typeof CompanionWidgetRendering !== "undefined" ? CompanionWidgetRendering.renderScale : 1
  property bool running: visible && enabled
  property bool fitContent: true
  property real preferredHeight: 240 * unit
  // Inline widgets fit their measured content between these bounds. The upper
  // bound grows with Companion's text size, so content that fit before the
  // reader enlarged text still fits afterwards instead of scrolling inside a
  // clipped bubble. It never falls below the 100% bound, because px-sized
  // content (canvas, fixed SVG) does not shrink when text becomes smaller.
  readonly property real minimumFitHeight: 100 * unit
  readonly property real maximumFitHeight: 420 * Math.max(unit, textScale)
  // Last content height reported by the page, in CSS (= QML logical) pixels;
  // 0 until this view has been measured.
  property real measuredContentHeight: 0
  property string error: ""
  property string popoutError: ""
  property bool popoutPending: false
  property string summary: ""
  property bool captured: false
  readonly property bool rendered: nativeRendering ? !!embedded.item && embedded.item.rendered : captured
  property bool layoutAgain: false
  property int frameNumber: 0
  property int retryDelay: 100
  property bool framePending: false
  property bool layoutPending: false
  property bool layoutRetryNeeded: false
  property int layoutRetryDelay: 250
  property var inputQueue: []
  property bool sendingInput: false
  property int viewGeneration: 0
  property var inputLifetime: ({active: true})
  readonly property bool hovered: hover.hovered
  readonly property string viewUrl: reference && /^http:\/\/127\.0\.0\.1:\d+\/view\/[0-9a-f]{64}$/.test(reference.viewUrl || "") ? reference.viewUrl : ""
  // Tests can inspect intended requests without opening a desktop browser.
  property var transport: null
  signal interactionStarted()

  clip: true
  implicitHeight: preferredHeight
  onViewUrlChanged: {
    error = ""; captured = false; framePending = false; layoutPending = false
    layoutAgain = false; layoutRetryNeeded = false; layoutRetryDelay = 250
    popoutError = ""; popoutPending = false
    measuredContentHeight = 0
    viewGeneration++
    refreshLayout(); refresh()
  }
  onReferenceChanged: refreshLayout()
  onWidthChanged: refreshLayout()
  onHeightChanged: if (nativeRendering) refreshLayout()
  onTextScaleChanged: refreshLayout()
  // Content whose height ignores text size keeps its measurement; apply the new
  // bound to it now rather than waiting for a layout change that may not come.
  onMaximumFitHeightChanged: fitMeasuredHeight()
  onPixelRatioChanged: { refreshLayout(); refresh() }
  // Visibility controls admission and rendering, not completion of accepted
  // gestures. Closing a conversation separately revokes its service capability.
  onRunningChanged: if (running) { refreshLayout(); refresh() }
  Component.onDestruction: {
    inputLifetime.active = false
    inputQueue = []
  }

  function request(path, body, done) {
    if (!viewUrl || !running) return
    const generation = viewGeneration
    requestAt(viewUrl, path, body, function(result, failure) {
      if (root.viewGeneration !== generation) return
      root.error = failure
      if (done) done(result)
    })
  }

  // Only accepted work reaches this transport. Its URL never follows reference
  // changes, and even test callbacks cannot access a destroyed QML surface.
  function requestAt(url, path, body, done) {
    const lifetime = inputLifetime
    const finish = function(result, failure) {
      if (lifetime.active) done(result, failure || "")
    }
    if (transport) { transport(path, body, finish, url); return }
    const xhr = new XMLHttpRequest()
    xhr.open(body === null ? "GET" : "POST", url + path)
    if (body !== null) xhr.setRequestHeader("Content-Type", "application/json")
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      let result = null
      let error = ""
      try {
        result = JSON.parse(xhr.responseText)
        if (xhr.status !== 200) throw new Error(result.error || "Widget unavailable")
      } catch (failure) {
        result = null
        error = String(failure.message || failure)
      }
      finish(result, error)
    }
    xhr.send(body === null ? "" : JSON.stringify(body))
  }

  function viewport() {
    function color(value) {
      const hex = value.toString()
      return encodeURIComponent(hex.length === 9 ? "#" + hex.slice(3) : hex)
    }
    return "?width=" + Math.round(Math.max(80, Math.min(1600, width)))
      + "&height=" + Math.round(Math.max(60, Math.min(2200, height)))
      + "&scale=" + Math.max(0.5, Math.min(3, textScale))
      + "&pixelRatio=" + Math.max(1, Math.min(3, pixelRatio))
      + "&foreground=" + color(foreground) + "&background=" + color(selection)
      + "&accent=" + color(accent) + "&muted=" + color(muted)
  }

  function cssColor(value) {
    // QColor serializes translucent colors as #AARRGGBB, whereas CSS reads
    // eight-digit hex as #RRGGBBAA. Preserve both tint and opacity explicitly.
    return "rgba(" + Math.round(value.r * 255) + "," + Math.round(value.g * 255)
      + "," + Math.round(value.b * 255) + "," + value.a + ")"
  }

  function fitMeasuredHeight() {
    if (!fitContent || measuredContentHeight <= 0) return
    preferredHeight = Math.max(minimumFitHeight, Math.min(maximumFitHeight, measuredContentHeight))
  }

  function refreshLayout() {
    if (nativeRendering) { nativeLayout.restart(); return }
    if (!fitContent || !running || !viewUrl || width < 80) return
    if (layoutPending) { layoutAgain = true; return }
    layoutRetryNeeded = false
    layoutPending = true
    request("/layout" + viewport(), null, function(result) {
      root.layoutPending = false
      if (result) {
        root.measuredContentHeight = result.height
        root.fitMeasuredHeight()
        root.layoutRetryDelay = 250
      } else {
        // Frame capture can recover before measurement does. Retry measurement
        // separately so its error and fallback height don't survive forever.
        root.layoutRetryDelay = Math.min(5000, root.layoutRetryDelay * 2)
        root.layoutRetryNeeded = true
      }
      if (root.layoutAgain) { root.layoutAgain = false; root.refreshLayout() }
    })
  }

  function refresh() {
    if (nativeRendering) return
    if (!running || !viewUrl || framePending || width < 80 || height < 60 || transport) return
    framePending = true
    picture.source = viewUrl + "/frame" + viewport() + "&frame=" + (++frameNumber)
  }

  function sendInput(event) {
    if (nativeRendering) return
    if (!running || !visible || !enabled || !viewUrl) return
    // Coalesce pointer motion, but preserve press/release and text ordering.
    const tail = inputQueue.length ? inputQueue[inputQueue.length - 1] : null
    const last = tail && tail.generation === viewGeneration ? tail.event : null
    if (event.type === "mouseMoved" && last && last.type === "mouseMoved") inputQueue.pop()
    if (event.type === "text" && last && last.type === "text" && last.text.length + event.text.length <= 4000) { last.text += event.text; return }
    if (inputQueue.length >= 64) { error = "Widget input is busy"; return }
    inputQueue.push({event: event, url: viewUrl, generation: viewGeneration})
    drainInput()
  }

  function drainInput() {
    if (sendingInput || !inputQueue.length) return
    // Keep the accepted queue ordered across hide and reference changes. An old
    // release still targets its old view; a revoked URL fails without reopening
    // anything. Never carry its clipboard result or error into a replacement.
    const accepted = inputQueue.shift()
    sendingInput = true
    requestAt(accepted.url, "/input", accepted.event, function(result, failure) {
      root.sendingInput = false
      if (root.viewGeneration === accepted.generation) {
        root.error = failure
        if (result && typeof result.result === "string") {
          clipboard.text = result.result
          clipboard.selectAll()
          clipboard.copy()
          clipboard.deselect()
        }
      }
      root.drainInput()
    })
  }

  function popout() {
    if (!running || !visible || !enabled || !viewUrl || popoutPending) return
    const generation = viewGeneration
    popoutPending = true
    popoutError = ""
    // Starting Chromium can take time. Keep one visible launch in flight and
    // retain its error separately from successful background layout/input work.
    requestAt(viewUrl, "/popout", {}, function(result, failure) {
      if (root.viewGeneration !== generation) return
      root.popoutPending = false
      root.popoutError = failure
    })
  }
  function unpin() {
    request("/present", {presentation: {placement: "inline"}, requestId: "unpin-" + Date.now()}, null)
  }
  function modifiers(value) {
    return (value & Qt.AltModifier ? 1 : 0) | (value & Qt.ControlModifier ? 2 : 0)
      | (value & Qt.MetaModifier ? 4 : 0) | (value & Qt.ShiftModifier ? 8 : 0)
  }
  function key(event, phase) {
    if (event.key === Qt.Key_Escape && phase === "keyDown") {
      popoutButton.forceActiveFocus(Qt.TabFocusReason)
      event.accepted = true
      return
    }
    if (event.matches(StandardKey.Copy)) {
      if (phase === "keyDown") sendInput({type: "copy"})
      event.accepted = true
      return
    }
    if (event.matches(StandardKey.Paste)) {
      if (phase === "keyDown") {
        clipboard.text = ""
        clipboard.paste()
        sendInput({type: "text", text: clipboard.text.slice(0, 4000)})
        clipboard.text = ""
      }
      event.accepted = true
      return
    }
    const keys = {}
    keys[Qt.Key_Return] = "Enter"; keys[Qt.Key_Enter] = "Enter"; keys[Qt.Key_Tab] = "Tab"
    keys[Qt.Key_Backspace] = "Backspace"; keys[Qt.Key_Delete] = "Delete"
    keys[Qt.Key_Left] = "ArrowLeft"; keys[Qt.Key_Right] = "ArrowRight"
    keys[Qt.Key_Up] = "ArrowUp"; keys[Qt.Key_Down] = "ArrowDown"
    keys[Qt.Key_Home] = "Home"; keys[Qt.Key_End] = "End"; keys[Qt.Key_Escape] = "Escape"
    if (event.key === Qt.Key_A && event.modifiers & Qt.ControlModifier) keys[Qt.Key_A] = "a"
    if (keys[event.key]) {
      sendInput({type: "key", key: keys[event.key], phase: phase, modifiers: modifiers(event.modifiers)})
      event.accepted = true
    } else if (event.text && !(event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier))) {
      if (phase === "keyDown") sendInput({type: "text", text: event.text})
      event.accepted = true
    } else event.accepted = false
  }
  Keys.onPressed: event => { if (!nativeRendering) key(event, "keyDown"); else event.accepted = false }
  Keys.onReleased: event => { if (!nativeRendering) key(event, "keyUp"); else event.accepted = false }
  Shortcut {
    sequence: "Escape"
    context: Qt.WindowShortcut
    enabled: root.nativeRendering && root.running && root.activeFocus
    onActivated: popoutButton.forceActiveFocus(Qt.TabFocusReason)
  }

  Image {
    id: picture
    objectName: "widgetFrame"
    anchors.fill: parent
    visible: !root.nativeRendering
    cache: false
    asynchronous: true
    retainWhileLoading: true
    fillMode: Image.Stretch
    onStatusChanged: if (status === Image.Ready || status === Image.Error) {
      root.framePending = false
      if (status === Image.Ready) {
        root.captured = true
        root.retryDelay = 100
        if (root.error.indexOf("Widget renderer unavailable") === 0) root.error = ""
      }
      if (status === Image.Error) {
        root.retryDelay = Math.min(5000, root.retryDelay * 2)
        root.error = "Widget renderer unavailable — the text summary is still saved."
      }
    }
  }
  Timer { interval: root.retryDelay; repeat: true; running: !root.nativeRendering && root.running && root.viewUrl !== ""; onTriggered: root.refresh() }
  Timer {
    interval: root.layoutRetryDelay
    running: root.layoutRetryNeeded && !root.nativeRendering && root.running && root.fitContent && root.viewUrl !== ""
    onTriggered: root.refreshLayout()
  }
  HoverHandler { id: hover }
  PointHandler {
    enabled: root.nativeRendering
    acceptedButtons: Qt.AllButtons
    onActiveChanged: if (active) root.interactionStarted()
  }
  MouseArea {
    id: pointer
    anchors.fill: parent
    enabled: !root.nativeRendering
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
    preventStealing: true
    hoverEnabled: true
    function pointerEvent(mouse, type) {
      const button = mouse.button === Qt.LeftButton ? "left" : mouse.button === Qt.MiddleButton ? "middle" : mouse.button === Qt.RightButton ? "right" : "none"
      root.sendInput({type: type, x: Math.max(0, Math.min(root.width, mouse.x)), y: Math.max(0, Math.min(root.height, mouse.y)), button: button,
        buttons: (mouse.buttons & Qt.LeftButton ? 1 : 0) | (mouse.buttons & Qt.RightButton ? 2 : 0) | (mouse.buttons & Qt.MiddleButton ? 4 : 0)})
    }
    onPressed: mouse => {
      root.forceActiveFocus(Qt.MouseFocusReason)
      root.interactionStarted()
      pointerEvent(mouse, "mousePressed")
    }
    onReleased: mouse => pointerEvent(mouse, "mouseReleased")
    onPositionChanged: mouse => pointerEvent(mouse, "mouseMoved")
    onCanceled: root.sendInput({type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0})
    onWheel: wheel => {
      root.sendInput({type: "mouseWheel", x: wheel.x, y: wheel.y, deltaY: -(wheel.pixelDelta.y || wheel.angleDelta.y)})
      wheel.accepted = true
    }
  }
  Loader {
    id: embedded
    // Chromium receives a larger viewport and matching page zoom, while Qt
    // maps it back into the same bubble. Keep the surrounding geometry and the
    // agent's reported CSS viewport independent of this diagnostic setting.
    width: Math.max(0, root.width) * root.nativeRenderScale
    height: Math.max(0, root.height) * root.nativeRenderScale
    scale: 1 / root.nativeRenderScale
    transformOrigin: Item.TopLeft
    active: root.nativeRendering && root.viewUrl !== ""
    source: active ? Qt.resolvedUrl("NativeWidgetView.qml") : ""
    onLoaded: {
      item.viewUrl = Qt.binding(function() { return root.viewUrl })
      item.running = Qt.binding(function() { return root.running })
      item.theme = Qt.binding(function() {
        return {foreground: root.cssColor(root.foreground), background: root.cssColor(root.selection),
          accent: root.cssColor(root.accent), muted: root.cssColor(root.muted), scale: root.textScale}
      })
    }
    onStatusChanged: if (status === Loader.Error) root.error = "Native widget renderer could not load"
  }
  Timer {
    id: nativeLayout
    interval: 120
    onTriggered: {
      if (!root.nativeRendering || !root.running || root.width < 1 || root.height < 1) return
      root.request("/viewport", {widthCssPixels: Math.round(root.width),
        heightCssPixels: Math.round(root.height), textScale: Math.max(0.5, Math.min(3, root.textScale))}, null)
    }
  }
  Connections {
    target: embedded.item
    function onMeasuredHeightChanged() {
      root.measuredContentHeight = embedded.item.measuredHeight
      root.fitMeasuredHeight()
    }
    function onErrorChanged() { root.error = embedded.item.error }
    function onInteractionStarted() { root.interactionStarted() }
  }
  TextEdit { id: clipboard; objectName: "widgetClipboard"; visible: false; textFormat: TextEdit.PlainText }
  Button {
    id: popoutButton
    objectName: "widgetPopout"
    anchors.top: parent.top
    anchors.right: parent.right
    anchors.margins: 6 * root.unit
    width: 34 * root.unit
    height: width
    text: root.popoutPending ? "…" : "↗"
    // Remain focusable while opening: Escape must still leave widget input.
    // popout() rejects additional activations until the accepted launch ends.
    enabled: root.running && root.viewUrl !== ""
    opacity: root.popoutPending || root.hovered || hovered || activeFocus ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: 140 } }
    onClicked: root.popout()
    Accessible.name: root.popoutPending ? "Opening widget in Chromium" : "Open widget in Chromium"
    background: Rectangle { color: root.selection; radius: 5 * root.unit; border.color: root.muted }
    contentItem: Text { text: popoutButton.text; color: root.foreground; font.pixelSize: 22 * root.unit; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
    ToolTip.visible: hovered
    ToolTip.text: root.popoutPending ? "Opening in Chromium…" : "Open in Chromium"
  }
  Text {
    objectName: "widgetStatus"
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    text: root.popoutPending ? "Opening in Chromium…" : root.popoutError || root.error
    visible: text !== ""
    color: root.foreground
    style: Text.Outline
    styleColor: "#782a2a"
    wrapMode: Text.Wrap
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
  }
  Accessible.description: summary
  Accessible.role: Accessible.Client
  Accessible.name: reference ? reference.name + " widget" : "Widget unavailable"
}
