import QtQuick

// Portable lightbox body. The adapter provides a separate window on the same
// display as the conversation. Zoom is relative to fit; pan stays bounded.
FocusScope {
  id: root
  required property color background
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property url source: ""
  property string title: "Screenshot"
  property real zoom: 1
  readonly property real fitScale: picture.sourceSize.width > 0 && picture.sourceSize.height > 0
    ? Math.min(1, viewport.width / picture.sourceSize.width, viewport.height / picture.sourceSize.height) : 1
  readonly property bool imageReady: picture.status === Image.Ready
  readonly property real imageWidth: picture.width
  readonly property real imageHeight: picture.height
  signal dismissed()

  function fit() {
    root.zoom = 1
    viewport.contentX = 0
    viewport.contentY = 0
  }
  function zoomBy(factor) {
    const oldWidth = viewport.contentWidth
    const oldHeight = viewport.contentHeight
    const centerX = (viewport.contentX + viewport.width / 2) / Math.max(1, oldWidth)
    const centerY = (viewport.contentY + viewport.height / 2) / Math.max(1, oldHeight)
    root.zoom = Math.max(1, Math.min(16, root.zoom * factor))
    viewport.contentX = Math.max(0, Math.min(viewport.contentWidth - viewport.width,
      centerX * viewport.contentWidth - viewport.width / 2))
    viewport.contentY = Math.max(0, Math.min(viewport.contentHeight - viewport.height,
      centerY * viewport.contentHeight - viewport.height / 2))
  }
  onSourceChanged: fit()
  onWidthChanged: fit()
  onHeightChanged: fit()
  onVisibleChanged: if (visible) { fit(); forceActiveFocus() }
  Component.onCompleted: forceActiveFocus()
  Keys.onEscapePressed: root.dismissed()
  Keys.onPressed: event => {
    if (event.key === Qt.Key_Plus || event.key === Qt.Key_Equal) {
      root.zoomBy(1.25); event.accepted = true
    } else if (event.key === Qt.Key_Minus) {
      root.zoomBy(0.8); event.accepted = true
    } else if (event.key === Qt.Key_0) {
      root.fit(); event.accepted = true
    }
  }

  Rectangle {
    anchors.fill: parent
    color: Qt.rgba(root.background.r, root.background.g, root.background.b, 0.96)
  }
  MouseArea {
    objectName: "viewerBackdrop"
    anchors.fill: parent
    onClicked: root.dismissed()
  }
  Rectangle {
    anchors.fill: viewport
    anchors.margins: -10 * root.unit
    radius: 12 * root.unit
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.025)
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
  }
  Text {
    x: 32 * root.unit
    y: 26 * root.unit
    width: Math.max(40 * root.unit, parent.width - controls.width - 88 * root.unit)
    text: root.title
    textFormat: Text.PlainText
    elide: Text.ElideRight
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: 16 * root.unit
  }
  Row {
    id: controls
    anchors.right: parent.right
    anchors.rightMargin: 24 * root.unit
    y: 20 * root.unit
    spacing: 8 * root.unit
    PanelAction {
      objectName: "zoomOut"
      text: "−"
      enabled: root.imageReady && root.zoom > 1
      foreground: root.foreground; selection: root.selection; fontFamily: root.fontFamily; unit: root.unit
      onTriggered: root.zoomBy(0.8)
    }
    Text {
      width: 48 * root.unit
      anchors.verticalCenter: parent.verticalCenter
      text: Math.round(root.fitScale * root.zoom * 100) + "%"
      horizontalAlignment: Text.AlignHCenter
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }
    PanelAction {
      objectName: "zoomIn"
      text: "+"
      enabled: root.imageReady && root.zoom < 16
      foreground: root.foreground; selection: root.selection; fontFamily: root.fontFamily; unit: root.unit
      onTriggered: root.zoomBy(1.25)
    }
    PanelAction {
      objectName: "fitScreenshot"
      text: "Fit"
      foreground: root.foreground; selection: root.selection; fontFamily: root.fontFamily; unit: root.unit
      onTriggered: root.fit()
    }
    PanelAction {
      objectName: "closeScreenshot"
      text: "×"
      foreground: root.foreground; selection: root.selection; fontFamily: root.fontFamily; unit: root.unit
      onTriggered: root.dismissed()
      Accessible.name: "Close screenshot"
    }
  }
  Flickable {
    id: viewport
    objectName: "screenshotViewport"
    anchors.fill: parent
    anchors.topMargin: 80 * root.unit
    anchors.bottomMargin: 56 * root.unit
    anchors.leftMargin: 32 * root.unit
    anchors.rightMargin: 32 * root.unit
    clip: true
    contentWidth: Math.max(width, picture.width)
    contentHeight: Math.max(height, picture.height)
    boundsBehavior: Flickable.StopAtBounds
    interactive: root.zoom > 1
    Image {
      id: picture
      objectName: "viewerImage"
      x: Math.max(0, (viewport.width - width) / 2)
      y: Math.max(0, (viewport.height - height) / 2)
      width: sourceSize.width * root.fitScale * root.zoom
      height: sourceSize.height * root.fitScale * root.zoom
      source: root.source
      asynchronous: true
      fillMode: Image.PreserveAspectFit
      MouseArea {
        anchors.fill: parent
        cursorShape: root.zoom > 1 ? Qt.OpenHandCursor : Qt.ArrowCursor
        onClicked: root.forceActiveFocus()
        onDoubleClicked: root.zoom > 1 ? root.fit() : root.zoomBy(2)
        onWheel: event => {
          root.zoomBy(event.angleDelta.y > 0 ? 1.25 : 0.8)
          event.accepted = true
        }
      }
    }
  }
  Text {
    anchors.centerIn: viewport
    visible: !root.imageReady
    text: picture.status === Image.Error ? "This screenshot is no longer available." : "Loading screenshot…"
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 14 * root.unit
  }
  Text {
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 20 * root.unit
    anchors.horizontalCenter: parent.horizontalCenter
    text: "Scroll to zoom · drag to pan · Esc to close"
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 11 * root.unit
  }
}
