import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Basic as Basic

// Backend and model for coding sessions started from now on, shown inside
// Activity's "Start a coding session" card. Both choosers follow the
// listener's saved defaults only: a choice is sent, and the shown value
// changes once the listener has validated and saved it. Existing
// conversations keep their own backend and model.
//
// Models come from the same catalogues as the conversation footer: Pi's
// discovered (pinned) models, or the Claude allowlist plus the configured
// Claude default. There is no free-text model.
Item {
  id: root
  // AgentSessionState: defaults, catalogues and the requests that change them.
  required property var sessionControls
  property bool online: false
  required property color foreground
  required property color muted
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  readonly property color errorColor: "#ef5350"

  // The shared state can be destroyed before this view (for example when a
  // panel closes); every binding below then reads as empty.
  readonly property bool attached: sessionControls !== null && sessionControls !== undefined
  readonly property var defaults: attached ? sessionControls.codingDefaults : null
  readonly property bool reachable: attached && online && sessionControls.controlsAvailable
  readonly property bool busy: attached && (sessionControls.codingDefaultsLoading || sessionControls.codingDefaultsSaving)
  readonly property bool claude: defaults !== null && defaults.harness === "claude-code"
  readonly property bool catalogLoaded: attached && (claude ? sessionControls.claudeModelsLoaded : sessionControls.modelsLoaded)
  readonly property string catalogError: !attached ? "" : claude ? sessionControls.claudeModelsError : sessionControls.modelsError
  readonly property string errorText: attached ? sessionControls.codingDefaultsError || catalogError : ""
  readonly property string statusText: !attached ? "" : errorText
    || (sessionControls.codingDefaultsSaving ? "Saving…" : "")
    || (defaults === null && sessionControls.codingDefaultsLoading ? "Loading…" : "")

  readonly property var harnessOptions: [
    {label: "Pi", value: "pi"},
    {label: "Claude Code", value: "claude-code"}
  ]
  // The saved default is always listed, even before its catalogue arrives
  // or when that catalogue no longer offers it.
  readonly property var modelOptions: {
    if (defaults === null) return []
    if (claude) {
      const listed = sessionControls.claudeModelCatalog.models || []
      const entries = listed.map(model => ({label: model, value: model}))
      if (!listed.includes(defaults.claudeModel))
        entries.push({label: defaults.claudeModel, value: defaults.claudeModel})
      return entries
    }
    const catalog = sessionControls.modelCatalog
    const listed = catalog.pinned !== undefined ? catalog.pinned : (catalog.models || [])
    const entries = listed.map(model => ({label: model, value: model}))
    if (!listed.includes(defaults.piModel)) {
      const unavailable = sessionControls.modelsLoaded && !(catalog.models || []).includes(defaults.piModel)
      entries.push({label: defaults.piModel + (unavailable ? " (unavailable)" : ""), value: defaults.piModel})
    }
    return entries
  }

  implicitHeight: contents.height

  // Read the defaults whenever they become visible, so hand edits and other
  // panels' changes appear; load only the catalogue the shown backend needs.
  readonly property bool active: visible && reachable
  onActiveChanged: if (active) Qt.callLater(refresh)
  onDefaultsChanged: if (active) Qt.callLater(ensureCatalog)
  Component.onCompleted: if (active) Qt.callLater(refresh)

  function refresh() {
    if (!root.active) return
    root.sessionControls.refreshCodingDefaults()
    root.ensureCatalog()
  }

  // Each catalogue is requested once per connection; its own refresh
  // control in a conversation footer reloads it.
  function ensureCatalog() {
    if (!root.active || root.defaults === null) return
    if (root.claude) root.sessionControls.ensureClaudeModels()
    else root.sessionControls.ensureModels()
  }

  // Panel-themed like the conversation footer's pickers. While its popup is
  // open the rows are pinned, so a catalogue arriving meanwhile cannot shift
  // the row under the pointer.
  component Chooser: Basic.ComboBox {
    id: chooser
    property var entries: []
    property string selectedValue: ""
    property var popupEntries: []
    signal chosen(string value)
    width: parent.width
    height: 30 * root.unit
    readonly property var rows: popup.visible ? popupEntries : entries
    model: rows
    textRole: "label"
    valueRole: "value"
    currentIndex: savedIndex()
    function savedIndex() { return Math.max(0, rows.findIndex(entry => entry.value === selectedValue)) }
    font.family: root.fontFamily
    font.pixelSize: 12 * root.textScale
    leftPadding: 10 * root.unit
    rightPadding: 28 * root.unit
    background: Rectangle {
      color: root.selection
      radius: 4 * root.unit
      border.width: root.unit
      border.color: chooser.visualFocus || chooser.hovered ? root.foreground : root.muted
    }
    contentItem: Text {
      text: chooser.displayText
      textFormat: Text.PlainText
      color: chooser.enabled ? root.foreground : root.muted
      font: chooser.font
      verticalAlignment: Text.AlignVCenter
      elide: Text.ElideRight
    }
    indicator: Text {
      x: chooser.width - width - 10 * root.unit
      y: (chooser.height - height) / 2
      text: "▾"
      color: chooser.enabled ? root.foreground : root.muted
      font.family: root.fontFamily
      font.pixelSize: 13 * root.textScale
    }
    delegate: Basic.ItemDelegate {
      id: option
      required property var model
      required property int index
      width: ListView.view.width
      height: 32 * root.unit
      padding: 10 * root.unit
      text: model[chooser.textRole]
      highlighted: chooser.highlightedIndex === index
      hoverEnabled: true
      contentItem: Text {
        text: option.text
        textFormat: Text.PlainText
        color: root.foreground
        font: chooser.font
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
      }
      background: Rectangle {
        color: option.highlighted || option.hovered ? Qt.lighter(root.selection, 1.35) : root.selection
      }
    }
    popup.background: Rectangle {
      color: root.selection
      border.color: root.muted
      border.width: root.unit
      radius: 4 * root.unit
    }
    onActivated: index => {
      const choice = (popupEntries.length ? popupEntries : entries)[index]
      // Activation moves currentIndex to the chosen row and replaces the
      // binding above. Restore it: the saved default stays shown until the
      // listener reports the change, and stays after a refusal.
      chooser.currentIndex = Qt.binding(() => chooser.savedIndex())
      if (choice && choice.value !== selectedValue) chooser.chosen(choice.value)
    }
    Connections {
      target: chooser.popup
      function onAboutToShow() { chooser.popupEntries = chooser.entries.slice() }
      function onClosed() { Qt.callLater(function() { chooser.popupEntries = [] }) }
    }
  }

  Column {
    id: contents
    width: root.width
    spacing: 6 * root.unit

    Text {
      objectName: "codingDefaultsHeading"
      width: parent.width
      topPadding: 4 * root.unit
      text: "New sessions start with"
      wrapMode: Text.Wrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.textScale
    }
    Chooser {
      id: harnessChooser
      objectName: "codingDefaultHarness"
      entries: root.harnessOptions
      selectedValue: root.defaults !== null ? root.defaults.harness : ""
      enabled: root.reachable && root.defaults !== null && !root.busy
      displayText: root.defaults !== null ? currentText : "Backend"
      onChosen: value => root.sessionControls.setCodingDefaults(value, "")
      Accessible.name: "Backend for new coding sessions"
    }
    Chooser {
      id: modelChooser
      objectName: "codingDefaultModel"
      entries: root.modelOptions
      selectedValue: root.defaults === null ? "" : root.claude ? root.defaults.claudeModel : root.defaults.piModel
      enabled: root.reachable && root.defaults !== null && !root.busy && root.catalogLoaded
      displayText: root.defaults !== null ? currentText : "Model"
      onChosen: value => root.sessionControls.setCodingDefaults(root.defaults.harness, value)
      Accessible.name: "Model for new " + (root.claude ? "Claude Code" : "Pi") + " sessions"
    }
    Text {
      objectName: "codingDefaultsNote"
      width: parent.width
      text: "Existing sessions keep their own backend and model."
      wrapMode: Text.WordWrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 10 * root.textScale
    }
    Text {
      objectName: "codingDefaultsStatus"
      width: parent.width
      visible: text !== ""
      text: root.statusText
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      color: root.errorText ? root.errorColor : root.muted
      font.family: root.fontFamily
      font.pixelSize: 10 * root.textScale
    }
  }
}
