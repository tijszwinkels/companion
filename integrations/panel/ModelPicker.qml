import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Basic as Basic

// The selected conversation owns this override. Profile defaults and the
// model actually running remain distinct, especially while a turn is active.
// A Claude Code conversation lists only the listener's Claude models: the
// choice replaces that conversation's own Claude model for its next turn and
// Claude Code keeps the same history. Its effort stays as it started, so the
// footer names it instead of offering an effort picker.
Item {
  id: root
  property var session: null
  property var catalog: ({models: []})
  property bool catalogLoaded: false
  property bool loading: false
  property string error: ""
  readonly property string statusText: error || catalog.warning || ""
  property bool online: false
  required property color background
  required property color foreground
  required property color muted
  required property color selection
  required property string fontFamily
  property real unit: 1
  // Omarchy's selection can be pale foreground at only 8% opacity. Flatten it
  // over the panel surface; dropping its alpha would turn the popup pale too.
  // Keep menus opaque so underlying conversation content cannot bleed through.
  readonly property color popupColor: Qt.tint(Qt.rgba(background.r, background.g, background.b, 1), selection)
  signal refreshRequested()
  signal modelRequested(string id, string model)
  readonly property string sessionId: session ? session.id : ""
  // Absent in Pi conversations and in messages from older listeners.
  readonly property bool claudeConversation: session !== null && session.harness === "claude-code"
  readonly property string claudeModel: claudeConversation && session.claudeCode ? session.claudeCode.model : ""
  // The listener's allowlist plus the configured default. The conversation's
  // current model is always shown, even before the catalogue arrives or when
  // it is not listed (for example a model started by an agent tool).
  readonly property var claudeOptions: {
    const claude = catalog.claudeCode || {}
    const listed = claude.models || []
    const entries = listed.map(model => ({label: model + (model === claude.model ? " · configured default" : ""), value: model}))
    if (claudeModel && !listed.includes(claudeModel)) entries.push({label: claudeModel, value: claudeModel})
    return entries
  }
  signal thinkingRequested(string id, string thinking)
  property bool showAllModels: false
  onSessionIdChanged: {
    chooser.popupSessionId = ""
    effort.popupSessionId = ""
    chooser.popup.close()
    effort.popup.close()
  }
  readonly property string profile: session && session.profile === "quickQuestion" ? "quickQuestion" : "coding"
  readonly property string defaultModel: catalog[profile] || "profile settings"
  readonly property var options: {
    const entries = [{label: "Use " + (profile === "quickQuestion" ? "quick-question" : "coding") + " default · " + defaultModel, value: ""}]
    const listed = showAllModels || catalog.pinned === undefined ? catalog.models : catalog.pinned
    for (const model of listed || []) entries.push({label: model, value: model})
    if (session && session.modelOverride && !entries.some(entry => entry.value === session.modelOverride)) {
      const availability = root.catalogLoaded && !(catalog.models || []).includes(session.modelOverride) ? " (unavailable)" : ""
      entries.push({label: session.modelOverride + availability, value: session.modelOverride})
    }
    return entries
  }
  readonly property string effectiveModel: session && session.modelOverride || defaultModel
  readonly property var supportedLevels: catalog.thinkingLevels && catalog.thinkingLevels[effectiveModel] || []
  readonly property string defaultThinking: catalog[profile + "Thinking"] || ""
  readonly property var thinkingOptions: {
    const entries = [{label: "Use profile default" + (defaultThinking ? " · " + adaptedThinking(defaultThinking) : ""), value: ""}].concat(supportedLevels.map(level => ({label: level, value: level})))
    if (supportedLevels.length === 0 && session && session.thinkingOverride) {
      entries.push({label: session.thinkingOverride, value: session.thinkingOverride})
    }
    return entries
  }
  readonly property bool stacked: width < 380 * unit
  readonly property real effortWidth: 172 * unit
  readonly property real controlsBottom: Math.max(chooser.y + chooser.height, effort.y + effort.height)
  height: controlsBottom + (statusText ? 62 : 38) * unit

  // Match Pi's ordered adjustment for display only; launch validation uses Pi's
  // own helper. Keep the requested override so switching back can restore it.
  function adaptedThinking(requested) {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    const start = levels.indexOf(requested)
    for (let index = start; index < levels.length; index++) {
      if (supportedLevels.includes(levels[index])) return levels[index]
    }
    for (let index = start - 1; index >= 0; index--) {
      if (supportedLevels.includes(levels[index])) return levels[index]
    }
    return requested
  }

  Text {
    text: root.claudeConversation ? "This session · next turn Claude model" : "This session · next turn model"
    width: chooser.width
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
    elide: Text.ElideRight
  }
  Text {
    x: effort.x
    y: effort.y - 20 * root.unit
    text: "Effort"
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
  }
  // Draw the panel theme directly: platform styles can derive a light gradient
  // from the palette, making the field inconsistent with the surrounding UI.
  // Keep ComboBox's built-in popup placement, keyboard input and accessibility.
  component SettingChooser: Basic.ComboBox {
    id: chooser
    property var entries: []
    property string selectedValue: ""
    property string popupSessionId: ""
    property var popupOptions: []
    property bool choosingFromPopup: false
    signal chosen(string id, string value)
    height: 32 * root.unit
    // Retain a usable catalogue while refreshing. The server validates choices.
    enabled: root.online && root.session !== null && (!root.loading || root.catalogLoaded)
    model: popup.visible ? popupOptions : entries
    textRole: "label"
    valueRole: "value"
    currentIndex: Math.max(0, (popup.visible ? popupOptions : entries).findIndex(entry => entry.value === selectedValue))
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
    leftPadding: 10 * root.unit
    rightPadding: 30 * root.unit
    palette.text: root.foreground
    palette.buttonText: root.foreground
    palette.button: root.selection
    palette.base: root.selection
    palette.window: root.popupColor
    palette.mid: root.muted
    palette.highlight: root.foreground
    palette.highlightedText: root.foreground
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
      font.pixelSize: 14 * root.unit
    }
    delegate: Basic.ItemDelegate {
      id: option
      required property var model
      required property int index
      width: ListView.view.width
      height: 36 * root.unit
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
        color: option.highlighted || option.hovered ? Qt.lighter(root.popupColor, 1.35) : root.popupColor
      }
    }
    // This control lives at the panel's bottom; open into the conversation.
    popup.y: -popup.height - 4 * root.unit
    popup.background: Rectangle {
      // Menus need an opaque surface even when the panel theme is translucent.
      color: root.popupColor
      border.color: root.muted
      border.width: root.unit
      radius: 4 * root.unit
    }
    onActivated: index => {
      const destination = chooser.choosingFromPopup ? chooser.popupSessionId : root.sessionId
      const choices = chooser.choosingFromPopup ? chooser.popupOptions : chooser.entries
      if (destination && destination === root.sessionId && choices[index]) {
        chooser.chosen(destination, choices[index].value)
      }
    }
    Connections {
      target: chooser.popup
      function onAboutToShow() {
        // Pin both destination and rows while the user chooses. A voice tab
        // change or delayed catalog response cannot retarget the open menu.
        chooser.popupSessionId = root.sessionId
        chooser.popupOptions = chooser.entries.slice()
        chooser.choosingFromPopup = true
      }
      function onClosed() { Qt.callLater(function() { chooser.choosingFromPopup = false }) }
    }
  }
  SettingChooser {
    id: chooser
    objectName: "sessionModelPicker"
    y: 20 * root.unit
    width: Math.max(0, root.width - (root.stacked ? 0 : root.effortWidth + 8 * root.unit))
    entries: root.claudeConversation ? root.claudeOptions : root.options
    selectedValue: root.claudeConversation ? root.claudeModel : root.session && root.session.modelOverride || ""
    onChosen: (id, value) => root.modelRequested(id, value)
    Accessible.name: "Model for this conversation's next turn"
    ToolTip.visible: hovered
    ToolTip.text: root.session ? "Current / last turn: " + (root.session.model || "starting") : ""
  }
  SettingChooser {
    id: effort
    objectName: "sessionThinkingPicker"
    visible: !root.claudeConversation
    x: root.stacked ? 0 : chooser.width + 8 * root.unit
    y: root.stacked ? chooser.y + chooser.height + 24 * root.unit : chooser.y
    width: root.stacked ? root.width : root.effortWidth
    entries: root.thinkingOptions
    selectedValue: root.session && root.session.thinkingOverride ? root.adaptedThinking(root.session.thinkingOverride) : ""
    enabled: root.online && root.session !== null && (root.supportedLevels.length > 0 || (root.catalog.thinkingLevels !== undefined && !!root.session.thinkingOverride)) && (!root.loading || root.catalogLoaded)
    onChosen: (id, value) => root.thinkingRequested(id, value)
    Accessible.name: "Effort for this conversation's next turn"
    ToolTip.visible: hovered
    ToolTip.text: root.session && root.session.thinkingOverride
      ? "Requested: " + root.session.thinkingOverride + " · supported by this model: " + root.adaptedThinking(root.session.thinkingOverride)
      : "Inherits the conversation profile; Pi adjusts to the selected model's supported levels."
  }
  // Claude Code has no effort picker: a model switch keeps the effort the
  // conversation started with (models without effort support ignore it).
  Text {
    id: claudeEffort
    objectName: "claudeSessionEffort"
    visible: root.claudeConversation
    x: effort.x
    y: effort.y
    width: effort.width
    height: effort.height
    text: root.session && root.session.claudeCode ? root.session.claudeCode.effort + " · fixed" : ""
    textFormat: Text.PlainText
    color: root.foreground
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
  }
  PanelAction {
    id: allModels
    objectName: "showAllSessionModels"
    visible: !root.claudeConversation
    y: root.controlsBottom + 6 * root.unit
    text: root.showAllModels ? "Pinned models only" : "Show all models"
    enabled: root.online && root.catalogLoaded && root.catalog.pinned !== undefined
    foreground: root.foreground
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    activeFocusOnTab: true
    onTriggered: root.showAllModels = !root.showAllModels
    Keys.onReturnPressed: event => { if (enabled) triggered(); event.accepted = true }
    Keys.onSpacePressed: event => { if (enabled) triggered(); event.accepted = true }
  }
  Text {
    objectName: "claudeSessionModelNote"
    visible: root.claudeConversation
    y: allModels.y
    width: Math.max(0, refresh.x - 8 * root.unit)
    height: allModels.height
    text: "Same Claude history; effort stays as it started."
    color: root.muted
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
  }
  PanelAction {
    id: refresh
    objectName: "refreshSessionModels"
    anchors.right: parent.right
    y: allModels.y
    text: root.loading ? "…" : "↻"
    enabled: root.online && !root.loading
    foreground: root.foreground
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    onTriggered: root.refreshRequested()
    Accessible.name: root.claudeConversation ? "Refresh available Claude models" : "Refresh available Pi models"
  }
  Text {
    y: allModels.y + allModels.height + 2 * root.unit
    width: parent.width
    visible: root.statusText !== ""
    text: root.statusText
    color: root.muted
    elide: Text.ElideRight
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
    ToolTip.visible: errorHover.hovered
    ToolTip.text: root.statusText
    HoverHandler { id: errorHover }
  }
}
