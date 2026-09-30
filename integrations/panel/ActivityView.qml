import QtQuick
import QtQuick.Controls

// Activity sections scroll above a fixed composer. Typed text stays reachable
// even while browsing history or collapsing the listening and intent panels.
Item {
  id: root
  required property bool online
  required property bool paused
  property string pauseReason: ""
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  property bool animationsEnabled: true
  property var history: []
  property var intents: []
  property var transcriptionCleanup: null
  property var activityHistoryModel: null
  property bool activityHistoryAvailable: false
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
  readonly property bool inputFocused: root.visible && utterance.activeFocus
  function focusInput() { utterance.forceActiveFocus(Qt.ShortcutFocusReason) }
  function releaseInputFocus() { utterance.focus = false }
  property string pendingText: ""
  property string inputError: ""
  signal utteranceRequested(string text)

  function submitText() {
    if (root.pendingText !== "" || !utterance.text.trim()) return
    if (!root.online || !root.textInputAvailable) {
      root.inputError = !root.online ? "Companion is disconnected; your draft is retained." : "Restart the Companion listener to enable text input."
      return
    }
    if (utterance.text.length > 4000) {
      root.inputError = "Keep the message within 4000 characters."
      return
    }
    root.inputError = ""
    root.pendingText = utterance.text
    root.utteranceRequested(root.pendingText)
  }

  function utteranceSubmitted(text, error) {
    if (root.pendingText !== text) return
    root.pendingText = ""
    root.inputError = error
    if (!error && utterance.text === text) utterance.clear()
  }

  property string shortcutLabel: ""
  signal intentEnabledRequested(string name, bool enabled, string mode)
  signal transcriptionCleanupRequested(bool enabled)
  signal historyActionRequested(string action, string id, var value)

  // Page scroll position measured from the top of Listening. Tests and
  // callers use these rather than the history list's shifting content origin.
  readonly property real contentY: activityScroll.pageY
  readonly property real contentHeight: activityScroll.contentHeight
  readonly property real viewportHeight: activityScroll.height
  function scrollTo(pageY) { activityScroll.scrollToPageY(pageY) }
  function scrollToItem(item) { activityScroll.scrollToItem(item) }
  // Owned here rather than by the heading inside the list header, so the list
  // model and card animations can follow it.
  property bool historyExpanded: true
  clip: true

  Column {
    id: inputArea
    anchors.bottom: parent.bottom
    objectName: "activityTextArea"
    width: parent.width
    spacing: 8 * root.unit

    Text {
      text: "Type an utterance"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 13 * root.textScale
      font.weight: Font.DemiBold
    }
    ScrollView {
      id: inputScroll
      width: parent.width
      height: Math.max(86 * root.unit, 70 * root.textScale)
      clip: true
      ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
      TextArea {
        id: utterance
        objectName: "activityTextInput"
        width: inputScroll.availableWidth
        height: Math.max(implicitHeight, inputScroll.availableHeight)
        placeholderText: "Type what you would say…"
        placeholderTextColor: root.muted
        color: root.foreground
        selectionColor: root.selection
        selectedTextColor: root.foreground
        font.family: root.fontFamily
        font.pixelSize: 13 * root.textScale
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        clip: true
        padding: 12 * root.unit
        Accessible.name: "Utterance"
        background: Rectangle {
          radius: 8 * root.unit
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
          border.color: utterance.activeFocus ? root.accent : root.selection
        }
        Keys.onPressed: event => {
          if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
            event.accepted = true
            root.submitText()
          }
        }
      }
    }
    Row {
      width: parent.width
      spacing: 12 * root.unit
      PanelAction {
        objectName: "activityTextSend"
        text: root.pendingText !== "" ? "Sending…" : "Send"
        enabled: root.online && root.textInputAvailable && root.pendingText === "" && utterance.text.trim() !== ""
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: root.textScale
        onTriggered: root.submitText()
      }
      Text {
        width: Math.max(0, parent.width - 100 * root.unit)
        text: !root.online ? "Disconnected · draft kept" : !root.textInputAvailable ? "Restart Companion to enable text input." : "Enter to send · Shift+Enter for a new line"
        anchors.verticalCenter: parent.verticalCenter
        wrapMode: Text.Wrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.textScale
      }
    }
    Text {
      width: parent.width
      visible: text !== ""
      text: root.inputError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 11 * root.textScale
    }
  }

  // One scrolling list for the whole page: the sections above History are its
  // header and the keyboard help is its footer. See ActivityHistoryView.
  ActivityHistoryView {
    id: activityScroll
    objectName: "activityScroll"
    width: root.width
    height: Math.max(0, inputArea.y - 16 * root.unit)
    historyModel: root.activityHistoryModel
    available: root.activityHistoryAvailable
    expanded: root.historyExpanded
    historyDeletionAvailable: root.historyDeletionAvailable
    intents: root.intents
    online: root.online
    foreground: root.foreground
    muted: root.muted
    accent: root.accent
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    textScale: root.textScale
    animationsEnabled: root.animationsEnabled && root.historyExpanded
    onActionRequested: (action, id, value) => root.historyActionRequested(action, id, value)

    header: Column {
      width: activityScroll.width
      spacing: 28 * root.unit
      // Separates the History heading from the first row; the list's own
      // spacing applies only between rows. Constant, so the sections above do
      // not shift when the first card replaces the empty-state row.
      bottomPadding: 12 * root.unit
      Component.onCompleted: activityScroll.anchorItems = [listeningSection].concat(intentControls.sections, [historySection])

      CollapsibleSection {
        id: listeningSection
        objectName: "listeningArea"
        width: parent.width
        title: "Listening"
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: root.textScale

        Rectangle {
          width: parent.width
          // Leave a little extra room for the paused-state explanation.
          height: (root.paused ? 200 : 180) * root.unit
          radius: 16 * root.unit
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.025)
          border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
          clip: true

          StatusView {
            anchors.fill: parent
            anchors.margins: 12 * root.unit
            online: root.online
            paused: root.paused
            pauseReason: root.pauseReason
            speaking: root.speaking
            processing: root.processing
            history: root.history
            foreground: root.foreground
            muted: root.muted
            accent: root.accent
            fontFamily: root.fontFamily
            unit: root.unit
            textScale: root.textScale
            animationsEnabled: root.animationsEnabled && root.visible && listeningSection.expanded
          }
        }
      }

      IntentControls {
        id: intentControls
        objectName: "intentControls"
        width: parent.width
        intents: root.intents
        online: root.online
        paused: root.paused
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: root.textScale
        transcriptionCleanup: root.transcriptionCleanup
        onIntentEnabledRequested: (name, enabled, mode) => root.intentEnabledRequested(name, enabled, mode)
        onTranscriptionCleanupRequested: enabled => root.transcriptionCleanupRequested(enabled)
      }

      CollapsibleSection {
        id: historySection
        objectName: "historySection"
        width: parent.width
        title: "History"
        detail: activityScroll.historyCount + " · this run"
        expanded: root.historyExpanded
        onExpandedChanged: root.historyExpanded = expanded
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: root.textScale
        // The empty-state message and cards are rows of the list itself.
      }
    }

    footer: Column {
      objectName: "activityKeyboardHelp"
      visible: root.shortcutLabel !== ""
      width: activityScroll.width
      height: visible ? implicitHeight : 0
      // The usual gap between sections; a folded History already ends with
      // the header's bottom padding.
      topPadding: (root.historyExpanded ? 28 : 16) * root.unit
      spacing: 12 * root.unit

      Rectangle {
        width: parent.width
        height: root.unit
        color: Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.18)
      }
      Text {
        text: "Keyboard shortcuts"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.textScale
        font.weight: Font.DemiBold
      }
      Text {
        width: parent.width
        text: root.shortcutLabel
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.textScale
        lineHeight: 1.5
      }
    }
  }
}
