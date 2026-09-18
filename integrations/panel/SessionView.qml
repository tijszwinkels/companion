import QtQuick
import QtQuick.Controls
import QtQuick.Window

// Chat rendering is independent of Pi and Omarchy. Stable ListModel rows keep
// selection and expanded tool bubbles intact while text deltas update a row.
Item {
  id: root
  required property var session
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property bool online: true
  property real unit: 1
  property string displayedId: ""
  property bool followEnd: true
  property var drafts: ({})
  property var pendingSubmission: null
  property string inputError: ""
  readonly property bool running: session && (session.status === "starting" || session.status === "running")
  readonly property int messageCount: messages.count
  readonly property bool canSend: online && session !== null && !running && pendingSubmission === null
    && composer.text.trim().length > 0 && composer.text.length <= 4000
  readonly property string composerFocusId: online && visible && composer.activeFocus
    && root.Window.window && root.Window.window.active ? displayedId : ""
  signal overflowed()
  signal stopRequested(string id)
  signal dismissRequested(string id)
  signal sendRequested(string id, string text)
  signal screenshotRequested(url source, string title)

  function submit() {
    if (!root.canSend) return
    root.inputError = ""
    root.pendingSubmission = {id: root.session.id, text: composer.text}
    root.sendRequested(root.session.id, composer.text)
  }

  function submitted(id, text, error) {
    if (!root.pendingSubmission || root.pendingSubmission.id !== id || root.pendingSubmission.text !== text) return
    root.pendingSubmission = null
    root.inputError = error || ""
    if (!error) {
      if (root.drafts[id] === text) delete root.drafts[id]
      if (root.displayedId === id && composer.text === text) composer.text = ""
    }
  }

  function enterPressed(event) {
    event.accepted = true
    if (event.modifiers & Qt.ShiftModifier) {
      composer.insert(composer.cursorPosition, "\n")
    } else {
      root.submit()
    }
  }

  function scrollAndMeasure() {
    if (root.followEnd) {
      transcript.positionViewAtEnd()
    }
    if (root.visible && transcript.height > 0 && transcript.contentHeight > transcript.height + 4) {
      root.overflowed()
    }
  }

  function synchronize() {
    const id = root.session ? root.session.id : ""
    if (id !== root.displayedId) {
      if (root.displayedId) root.drafts[root.displayedId] = composer.text
      messages.clear()
      root.displayedId = id
      root.followEnd = true
      composer.text = root.drafts[id] || ""
      root.inputError = ""
    }

    const incoming = root.session ? root.session.messages : []
    for (let index = 0; index < incoming.length; index++) {
      const message = incoming[index]
      const row = {messageId: message.id, kind: message.kind, body: message.text,
        toolName: message.toolName, input: message.input, state: message.state,
        screenshot: message.screenshot, screenshotUrl: message.screenshotUrl || ""}
      if (index < messages.count) {
        messages.set(index, row)
      } else {
        messages.append(row)
      }
    }
    while (messages.count > incoming.length) {
      messages.remove(messages.count - 1)
    }
    Qt.callLater(root.scrollAndMeasure)
  }

  onSessionChanged: synchronize()
  onVisibleChanged: Qt.callLater(root.scrollAndMeasure)
  Component.onCompleted: synchronize()
  ListModel { id: messages }

  ListView {
    id: transcript
    objectName: "sessionTranscript"
    anchors.fill: parent
    anchors.bottomMargin: inputSection.height + 12 * root.unit
    clip: true
    spacing: 12 * root.unit
    model: messages
    boundsBehavior: Flickable.StopAtBounds
    onMovementEnded: root.followEnd = atYEnd
    onContentHeightChanged: Qt.callLater(root.scrollAndMeasure)
    onHeightChanged: Qt.callLater(root.scrollAndMeasure)
    ScrollBar.vertical: ScrollBar {
      visible: transcript.contentHeight > transcript.height
      contentItem: Rectangle { color: root.muted; radius: 2; implicitWidth: 4 }
    }

    delegate: Rectangle {
      id: bubble
      required property string messageId
      required property string kind
      required property string body
      required property string toolName
      required property string input
      required property string state
      required property bool screenshot
      required property string screenshotUrl
      property bool expanded: false
      objectName: "bubble-" + messageId
      width: transcript.width - 8 * root.unit
      height: contents.implicitHeight + 20 * root.unit
      radius: 6 * root.unit
      color: kind === "user" ? root.selection
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)

      Column {
        id: contents
        x: 10 * root.unit
        y: 10 * root.unit
        width: parent.width - 20 * root.unit
        spacing: 8 * root.unit

        Text {
          id: heading
          width: parent.width
          text: bubble.kind === "tool" ? (bubble.expanded ? "▾ " : "▸ ") + bubble.toolName
            + (bubble.state === "running" ? " · running" : bubble.state === "error" ? " · failed or stopped" : "")
            : bubble.kind === "user" ? "You" + (bubble.screenshot ? (bubble.screenshotUrl ? " · screenshot attached" : " · screenshot unavailable") : "") : "Pi"
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: bubble.state === "error" ? "#ef5350" : root.muted
          font.family: root.fontFamily
          font.pixelSize: 10 * root.unit

          MouseArea {
            anchors.fill: parent
            enabled: bubble.kind === "tool"
            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: bubble.expanded = !bubble.expanded
          }
          Accessible.role: bubble.kind === "tool" ? Accessible.Button : Accessible.StaticText
          Accessible.name: text
          Accessible.onPressAction: if (bubble.kind === "tool") bubble.expanded = !bubble.expanded
        }

        Rectangle {
          objectName: "screenshotThumbnail"
          visible: bubble.kind === "user" && bubble.screenshot && bubble.screenshotUrl !== ""
          width: parent.width
          height: visible ? 132 * root.unit : 0
          radius: 6 * root.unit
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: thumbnailHover.containsMouse ? root.accent : "transparent"
          Image {
            id: thumbnail
            anchors.fill: parent
            anchors.margins: 6 * root.unit
            source: parent.visible ? bubble.screenshotUrl : ""
            sourceSize.width: 600
            asynchronous: true
            fillMode: Image.PreserveAspectFit
          }
          Rectangle {
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: 8 * root.unit
            width: zoomLabel.width + 16 * root.unit
            height: 24 * root.unit
            radius: 12 * root.unit
            color: root.selection
            Text {
              id: zoomLabel
              anchors.centerIn: parent
              text: thumbnail.status === Image.Error ? "Screenshot unavailable" : "↗  Enlarge"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: 10 * root.unit
            }
          }
          MouseArea {
            id: thumbnailHover
            anchors.fill: parent
            hoverEnabled: true
            enabled: thumbnail.status === Image.Ready
            cursorShape: Qt.PointingHandCursor
            onClicked: root.screenshotRequested(bubble.screenshotUrl, root.session.title)
          }
          Accessible.role: Accessible.Button
          Accessible.name: "Enlarge attached screenshot"
          Accessible.onPressAction: if (thumbnail.status === Image.Ready) root.screenshotRequested(bubble.screenshotUrl, root.session.title)
        }

        TextEdit {
          objectName: "messageText"
          width: parent.width
          height: visible ? contentHeight : 0
          visible: bubble.kind !== "tool" || bubble.expanded
          text: bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
          textFormat: bubble.kind === "assistant" ? TextEdit.MarkdownText : TextEdit.PlainText
          readOnly: true
          selectByMouse: true
          activeFocusOnPress: false
          wrapMode: TextEdit.Wrap
          color: root.foreground
          selectionColor: root.selection
          selectedTextColor: root.foreground
          font.family: bubble.kind === "tool" ? "monospace" : root.fontFamily
          font.pixelSize: 13 * root.unit
          onLinkActivated: link => {
            // Opening a link is an explicit click; commands and file URLs do
            // not become executable UI actions through generated Markdown.
            if (/^https?:\/\//i.test(link)) Qt.openUrlExternally(link)
          }
        }
      }
    }

    footer: Text {
      width: transcript.width - 8 * root.unit
      text: root.session && root.session.error ? root.session.error : ""
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  Column {
    id: inputSection
    anchors.bottom: parent.bottom
    width: parent.width
    spacing: 8 * root.unit

    ScrollView {
      id: composerScroll
      width: parent.width
      height: 68 * root.unit
      contentWidth: availableWidth
      clip: true
      TextArea {
        id: composer
        objectName: "sessionComposer"
        width: composerScroll.availableWidth
        placeholderText: root.running ? "Write a follow-up while Pi answers…" : "Ask a follow-up…"
        placeholderTextColor: root.muted
        color: root.foreground
        selectionColor: root.selection
        selectedTextColor: root.foreground
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        selectByMouse: true
        padding: 8 * root.unit
        font.family: root.fontFamily
        font.pixelSize: 13 * root.unit
        background: Rectangle {
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: composer.activeFocus ? root.accent : root.muted
          radius: 4 * root.unit
        }
        onTextChanged: {
          if (root.displayedId) root.drafts[root.displayedId] = text
        }
        Keys.onReturnPressed: event => root.enterPressed(event)
        Keys.onEnterPressed: event => root.enterPressed(event)
        Accessible.name: "Message to the selected agent session"
      }
    }

    Text {
      width: parent.width
      visible: text !== ""
      text: composer.text.length > 4000 ? "Keep messages under 4000 characters." : root.inputError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Row {
      spacing: 8 * root.unit
      PanelAction {
        objectName: "sendSession"
        enabled: root.canSend
        text: "Send"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.submit()
      }
      PanelAction {
        objectName: "stopSession"
        visible: root.running
        enabled: root.online
        text: "Stop"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.stopRequested(root.session.id)
      }
      PanelAction {
        objectName: "dismissSession"
        enabled: root.online && root.session !== null
        text: "Close session"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.dismissRequested(root.session.id)
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: !root.online ? "Disconnected" : root.running ? "Answering…"
          : root.session && root.session.status === "cancelled" ? "Stopped"
          : root.session && root.session.status === "error" ? "Failed" : "Done"
        textFormat: Text.PlainText
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
      }
    }
  }
}
