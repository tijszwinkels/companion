import QtQuick
import QtQuick.Controls
import "../panel" as Panel

Item {
  id: root
  required property var host
  required property var transport
  property bool nativeWidgets: true
  property var theme: ({background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7",
    muted: "#737b9c", selection: "#292e42", tooltipBackground: "#1a1b26",
    tooltipForeground: "#a9b1d6", tooltipBorder: "#737b9c", fontFamily: "monospace", unit: 1})
  property string previousWindow: ""
  property bool focusPending: false
  property int utteranceSequence: 0
  property string screenshotSource: ""
  property alias client: client
  property alias panel: panel
  readonly property bool inputFocused: host.opened && panel.inputFocused
  readonly property string composerId: host.opened ? panel.composerFocusId : ""
  readonly property bool keyboardFocused: host.opened && host.active
  readonly property bool renderDiagnostics: typeof CompanionRenderDiagnostics !== "undefined" && CompanionRenderDiagnostics
  width: parent ? parent.width : 620
  height: parent ? parent.height : 780
  Keys.onEscapePressed: {
    if (root.screenshotSource !== "") root.screenshotSource = ""
    else if (root.inputFocused) root.releaseFocus(true)
    else root.host.hide()
  }

  function publish() {
    host.publish({opened: host.opened, active: root.keyboardFocused,
      composerFocusId: root.composerId, inputFocused: root.inputFocused, sessionId: client.sessions.conversationId,
      presentation: host.presentation, sidebarAvailable: host.sidebarAvailable,
      online: client.online, width: root.width, height: root.height})
  }

  function releaseFocus(restore) {
    focusDeadline.stop()
    root.focusPending = false
    host.releaseFocus()
    panel.releaseComposerFocus()
    if (restore && root.previousWindow) {
      // The bridge validates this compositor-supplied address again. It owns
      // focus restoration and sends keyboard insertion only after that boundary.
      host.notify({type: "restore-focus", address: root.previousWindow})
    }
    root.previousWindow = ""
  }

  function focusComposer(address) {
    if (root.inputFocused || root.focusPending) {
      root.releaseFocus(true)
      return
    }
    if (!client.online) {
      host.show(true)
      client.error = "Companion is disconnected."
      client.errorAction = "focus-agent"
      return
    }
    if (client.sessions.showingPrevious) client.sessions.select("")
    root.previousWindow = /^0x[0-9a-f]+$/i.test(address || "") ? address : ""
    root.focusPending = true
    focusDeadline.restart()
    host.show(true)
    root.acquireFocus()
  }

  function acquireFocus() {
    // Media is paused only after the requested window actually acquired focus.
    if (root.focusPending && root.keyboardFocused) {
      focusDeadline.stop()
      root.focusPending = false
      panel.focusComposer()
      if (root.inputFocused) host.notify({type: "pause-media"})
    }
  }

  function command(message) {
    if (message.action === "claim") {
      client.reportPanel()
    } else if (message.action === "toggle") {
      if (host.opened) host.hide()
      else host.show(false)
    } else if (message.action === "show") {
      host.show(message.activate === true)
    } else if (message.action === "hide") {
      host.hide()
    } else if (message.action === "focus") {
      root.focusComposer(message.address || "")
    } else if (message.action === "next-tab") {
      if (root.keyboardFocused) panel.nextTab()
    } else if (message.action === "resize") {
      if (root.keyboardFocused && typeof message.delta === "number") host.resizeBy(message.delta)
    } else if (message.action === "presentation") {
      host.setPresentation(message.mode)
    } else if (message.action === "theme") {
      // Theme values originate in the desktop adapter, never widget content.
      const next = Object.assign({}, root.theme)
      for (const key of Object.keys(next)) {
        const value = message.values ? message.values[key] : undefined
        if (key === "unit") {
          if (typeof value === "number" && value >= 0.5 && value <= 3) next[key] = value
        } else if (typeof value === "string" && value.length < 256) next[key] = value
      }
      root.theme = next
    } else if (message.action === "release-for-insertion") {
      root.previousWindow = message.address || ""
      root.releaseFocus(true)
    } else if (message.action === "utterance-failed") {
      if (message.id === client.pendingUtteranceId && message.text === client.pendingUtterance) client.finishUtterance(message.error)
    } else if (message.action === "utterance-after-release") {
      if (message.id !== client.pendingUtteranceId || message.text !== client.pendingUtterance || client.pendingUtterance === "") return
      if (!root.keyboardFocused && client.sessions.conversationId === "" && !client.sessions.showingPrevious) {
        utteranceDeadline.stop()
        client.sendUtterance(message.target)
      } else client.finishUtterance("Focus changed before sending; your draft is retained.")
    } else if (message.action === "paste-after-release") {
      if (!root.keyboardFocused && /^0x[0-9a-f]+$/i.test(message.target || "")) {
        client.reportPanel()
        client.send({action: "paste", id: message.id, target: message.target, composer: ""})
      }
    }
  }

  onComposerIdChanged: Qt.callLater(root.publish)
  onInputFocusedChanged: {
    // A native surface move briefly loses focus. Allow that move to settle,
    // but still release our media pause if the compositor denies reactivation.
    if (!root.inputFocused) mediaRelease.restart()
    else mediaRelease.stop()
    Qt.callLater(root.publish)
  }
  onKeyboardFocusedChanged: {
    root.acquireFocus()
    if (!root.keyboardFocused && !root.focusPending && !host.switching) root.previousWindow = ""
    Qt.callLater(root.publish)
  }
  onWidthChanged: Qt.callLater(root.publish)
  onHeightChanged: Qt.callLater(root.publish)

  Connections {
    target: root.host
    function onCommand(message) { root.command(message) }
    function onStateChanged() {
      if (!root.host.opened && !root.host.switching) {
        root.releaseFocus(false)
        root.screenshotSource = ""
      }
      Qt.callLater(root.publish)
    }
    function onBridgeChanged() { client.reportPanel(); root.publish() }
    function onSurfaceChanged() { Qt.callLater(root.publish) }
    function onFocusCleared() { root.releaseFocus(false) }
  }

  Timer {
    id: utteranceDeadline
    interval: 3000
    onTriggered: client.finishUtterance("Application focus was not restored; your draft is retained.")
  }

  Timer {
    id: mediaRelease
    interval: 250
    onTriggered: if (!root.inputFocused) root.host.notify({type: "resume-media"})
  }

  Timer {
    id: focusDeadline
    interval: 1500
    onTriggered: {
      root.releaseFocus(false)
      client.error = "Could not focus Companion. Click the input to continue."
      client.errorAction = "focus-agent"
    }
  }

  Client {
    id: client
    transport: root.transport
    panelVisible: root.host.opened
    keyboardFocused: root.keyboardFocused
    composerFocusId: root.composerId
    onRevealRequested: root.host.show(false)
    onUtteranceFinished: (text, error) => { utteranceDeadline.stop(); panel.utteranceSubmitted(text, error) }
    onInputFinished: (id, text, error) => panel.submitted(id, text, error)
    onToolPageReceived: message => panel.toolPageReceived(message)
    onChoiceFinished: (id, revision, index, error) => panel.choiceSubmitted(id, revision, index, error)
    browserHost: panel.browserAvailable
    // The panel answers once, when the page loaded or failed, or after a
    // bounded wait. A hidden window is never shown or activated for an agent,
    // and a page the user cannot see is not opened: it answers panel-hidden.
    onBrowserOpenRequested: message => {
      if (!root.host.opened) {
        client.answerBrowserOpen(message.requestId, {outcome: "panel-hidden",
          reason: "The Companion panel is hidden."})
        return
      }
      panel.openBrowserFromAgent(message, function(result) {
        client.answerBrowserOpen(message.requestId, result)
      })
    }
    onDraftRequested: message => {
      const result = panel.applyDraft(message)
      client.answerDraft(message.requestId, result)
      const changed = result.outcome === "inserted" || result.outcome === "appended"
      if (changed && message.focus === true) client.sessions.reveal(message.id)
    }
    onOnlineChanged: root.publish()
  }

  Rectangle { anchors.fill: parent; color: root.theme.background }

  Row {
    id: modes
    anchors.top: parent.top
    anchors.right: parent.right
    anchors.margins: 6 * root.theme.unit
    spacing: 6 * root.theme.unit
    Repeater {
      model: [{mode: "window", label: "Window"}, {mode: "sidebar", label: "Sidebar"}, {mode: "dock", label: "Dock"}]
      delegate: Panel.PanelAction {
        required property var modelData
        text: modelData.label
        enabled: modelData.mode === "window" || root.host.sidebarAvailable
        foreground: root.host.presentation === modelData.mode ? root.theme.accent : root.theme.foreground
        selection: root.theme.selection
        fontFamily: root.theme.fontFamily
        unit: root.theme.unit
        onTriggered: root.host.setPresentation(modelData.mode)
      }
    }
  }

  Row {
    id: renderingControls
    objectName: "widgetRenderingControls"
    visible: root.renderDiagnostics && typeof CompanionWidgetRendering !== "undefined"
    anchors.top: modes.bottom
    anchors.right: parent.right
    anchors.margins: 6 * root.theme.unit
    spacing: 6 * root.theme.unit
    Repeater {
      model: [{mode: "normal", label: "Normal"}, {mode: "supersampled", label: "2×"}, {mode: "filtered", label: "2× filtered"}]
      delegate: Panel.PanelAction {
        required property var modelData
        objectName: "widgetRendering-" + modelData.mode
        text: modelData.label
        foreground: typeof CompanionWidgetRendering !== "undefined" && CompanionWidgetRendering.mode === modelData.mode ? root.theme.accent : root.theme.foreground
        selection: root.theme.selection
        fontFamily: root.theme.fontFamily
        unit: root.theme.unit
        onTriggered: CompanionWidgetRendering.mode = modelData.mode
      }
    }
  }

  Text {
    id: hostError
    anchors.top: renderingControls.visible ? renderingControls.bottom : modes.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: 8 * root.theme.unit
    text: root.host.error
    visible: text !== ""
    color: root.theme.foreground
    wrapMode: Text.Wrap
    font.pixelSize: 12 * root.theme.unit
  }

  Panel.PanelContent {
    id: panel
    objectName: "nativePanel"
    anchors.top: hostError.visible ? hostError.bottom : renderingControls.visible ? renderingControls.bottom : modes.bottom
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: 2 * root.theme.unit
    nativeWidgets: root.nativeWidgets
    browserAvailable: root.nativeWidgets
    online: client.online
    paused: client.paused
    pauseReason: client.pauseReason
    speaking: client.speaking
    processing: client.processing
    history: client.history
    intents: client.intents
    transcriptionCleanup: client.transcriptionCleanup
    agentActions: client.agentActions
    activityHistoryModel: client.activity.model
    activityHistoryAvailable: client.activity.available
    historyDeletionAvailable: client.historyDeletionAvailable
    textInputAvailable: client.textInputAvailable
    onUtteranceRequested: text => {
      client.pendingUtterance = text
      client.pendingUtteranceId = Date.now().toString() + "-" + (++root.utteranceSequence)
      if (!root.host.bridgeConnected) {
        client.finishUtterance("Sending text requires the Omarchy bridge to restore application focus.")
        return
      }
      utteranceDeadline.restart()
      root.host.notify({type: "activity-text", id: client.pendingUtteranceId, text: text})
    }
    sessions: client.sessions.sessions
    sessionControls: client.sessions
    previousSessions: client.sessions.previousSessions
    unreadSessionIds: client.sessions.unreadIds
    selectedSessionId: client.sessions.selectedId
    showingPrevious: client.sessions.showingPrevious
    controlError: root.client.error
    background: root.theme.background
    foreground: root.theme.foreground
    muted: root.theme.muted
    accent: root.theme.accent
    selection: root.theme.selection
    tooltipBackground: root.theme.tooltipBackground
    tooltipForeground: root.theme.tooltipForeground
    tooltipBorder: root.theme.tooltipBorder
    fontFamily: root.theme.fontFamily
    unit: root.theme.unit
    animationsEnabled: root.host.opened
    focusShortcut: "⌥⌘D"
    shortcutLabel: "Super + Alt + C · panel / D · input focus\nAlt + 1–9 · conversations / Ctrl + plus/minus · text size"
    onCloseRequested: root.host.hide()
    onSessionSelected: id => client.sessions.select(id)
    onPreviousRequested: client.sessions.showingPrevious = true
    onReopenSessionRequested: id => client.send({action: "reopen-agent", id: id})
    onDismissSessionRequested: id => client.send({action: "close-agent", id: id})
    onStopSessionRequested: id => client.send({action: "stop-agent", id: id})
    onSendSessionRequested: (id, text) => client.sendInput(id, text)
    onToolPageRequested: request => { client.reportPanel(); client.send(request) }
    onChoiceRequested: (id, revision, index) => client.choose(id, revision, index)
    onStopRunRequested: (id, runId) => {
      client.reportPanel()
      client.send({action: "stop-agent-run", id: id, runId: runId})
    }
    onIntentEnabledRequested: (name, enabled, mode) => client.send({action: "set-intent-enabled", name: name, enabled: enabled, mode: mode})
    onTranscriptionCleanupRequested: enabled => client.send({action: "set-transcription-cleanup", enabled: enabled})
    onHistoryActionRequested: (action, id, value) => {
      if (action === "paste") {
        if (root.host.bridgeConnected) root.host.notify({type: "history-paste", id: id})
        else { client.error = "Inserting into another application requires the Omarchy bridge."; client.errorAction = "paste" }
      } else client.send(Object.assign({action: action, id: id}, value))
    }
    onScreenshotRequested: (source, title) => root.screenshotSource = source
  }

  Panel.ScreenshotViewer {
    anchors.fill: parent
    visible: root.screenshotSource !== ""
    source: root.screenshotSource
    background: root.theme.background
    foreground: root.theme.foreground
    muted: root.theme.muted
    accent: root.theme.accent
    selection: root.theme.selection
    fontFamily: root.theme.fontFamily
    unit: root.theme.unit
    onDismissed: root.screenshotSource = ""
  }
  Component.onCompleted: root.publish()
}
