import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Basic as Basic

// The selected conversation owns this override. Profile defaults and the
// model actually running remain distinct, especially while a turn is active.
Item {
  id: root
  property var session: null
  property var catalog: ({models: []})
  property bool catalogLoaded: false
  property bool loading: false
  property string error: ""
  property bool online: false
  required property color foreground
  required property color muted
  required property color selection
  required property string fontFamily
  property real unit: 1
  readonly property color popupColor: Qt.rgba(selection.r, selection.g, selection.b, 1)
  signal refreshRequested()
  signal modelRequested(string id, string model)
  readonly property string sessionId: session ? session.id : ""
  property string popupSessionId: ""
  property var popupOptions: []
  property bool choosingFromPopup: false
  onSessionIdChanged: {
    popupSessionId = ""
    chooser.popup.close()
  }
  readonly property string profile: session && session.profile === "quickQuestion" ? "quickQuestion" : "coding"
  readonly property string defaultModel: catalog[profile] || "profile settings"
  readonly property var options: {
    const entries = [{label: "Use " + (profile === "quickQuestion" ? "quick-question" : "coding") + " default · " + defaultModel, value: ""}]
    for (const model of catalog.models || []) entries.push({label: model, value: model})
    if (session && session.modelOverride && !entries.some(entry => entry.value === session.modelOverride)) {
      const availability = root.catalogLoaded ? " (unavailable)" : ""
      entries.push({label: session.modelOverride + availability, value: session.modelOverride})
    }
    return entries
  }
  height: (error ? 88 : 64) * unit
  Text {
    id: scope
    width: parent.width
    text: "This session · next turn model"
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
    elide: Text.ElideRight
  }
  // Draw the panel theme directly: platform styles can derive a light gradient
  // from the palette, making the field inconsistent with the surrounding UI.
  // Keep ComboBox's built-in popup placement, keyboard input and accessibility.
  Basic.ComboBox {
    id: chooser
    objectName: "sessionModelPicker"
    y: 20 * root.unit
    width: Math.max(0, parent.width - refresh.width - 8 * root.unit)
    height: 32 * root.unit
    // Refreshing must not interrupt a choice from the retained catalog. The
    // server revalidates submitted identifiers against current Pi availability.
    enabled: root.online && root.session !== null && (!root.loading || root.catalogLoaded)
    model: popup.visible ? root.popupOptions : root.options
    textRole: "label"
    valueRole: "value"
    currentIndex: Math.max(0, (popup.visible ? root.popupOptions : root.options).findIndex(entry => entry.value === (root.session && root.session.modelOverride || "")))
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
    popup.background: Rectangle {
      // Menus need an opaque surface even when the panel theme is translucent.
      color: root.popupColor
      border.color: root.muted
      border.width: root.unit
      radius: 4 * root.unit
    }
    onActivated: index => {
      const destination = root.choosingFromPopup ? root.popupSessionId : root.sessionId
      const choices = root.choosingFromPopup ? root.popupOptions : root.options
      if (destination && destination === root.sessionId && choices[index]) {
        root.modelRequested(destination, choices[index].value)
      }
    }
    Accessible.name: "Model for this conversation's next turn"
    ToolTip.visible: hovered
    ToolTip.text: root.session ? "Current / last turn: " + (root.session.model || "starting") + "\nThinking follows the profile; off for models without reasoning." : ""
  }
  Connections {
    target: chooser.popup
    function onAboutToShow() {
      // Pin both destination and rows while the user chooses. A voice tab
      // change or delayed catalog response cannot retarget the open menu.
      root.popupSessionId = root.sessionId
      root.popupOptions = root.options.slice()
      root.choosingFromPopup = true
    }
    function onClosed() { Qt.callLater(function() { root.choosingFromPopup = false }) }
  }
  PanelAction {
    id: refresh
    objectName: "refreshSessionModels"
    anchors.right: parent.right
    y: chooser.y
    text: root.loading ? "…" : "↻"
    enabled: root.online && !root.loading
    foreground: root.foreground
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    onTriggered: root.refreshRequested()
    Accessible.name: "Refresh available Pi models"
  }
  Text {
    y: 58 * root.unit
    width: parent.width
    visible: root.error !== ""
    text: root.error
    color: root.muted
    elide: Text.ElideRight
    font.family: root.fontFamily
    font.pixelSize: 10 * root.unit
    ToolTip.visible: errorHover.hovered
    ToolTip.text: root.error
    HoverHandler { id: errorHover }
  }
}
