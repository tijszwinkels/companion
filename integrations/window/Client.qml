import QtQuick
import "../panel" as Panel

// The native host consumes the same protocol as the shell adapter. All UI state
// stays here across presentation changes; the backend remains authoritative.
Item {
  id: root
  required property var transport
  property bool online: false
  property bool paused: false
  property string pauseReason: ""
  property bool speaking: false
  property int processing: 0
  property var history: []
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
  property string pendingUtterance: ""
  property string pendingUtteranceId: ""
  property var intents: []
  // {enabled: bool}, or null when the listener has no transcription cleanup.
  property var transcriptionCleanup: null
  // Null when the listener does not report capture storage: unavailable.
  property var captureStorage: null
  property var agentActions: ({})
  property string error: ""
  property string errorAction: ""
  property var pendingInput: null
  property var pendingChoice: null
  property alias sessions: sessions
  property alias activity: activity
  property bool panelVisible: false
  property bool keyboardFocused: false
  property string composerFocusId: ""
  signal utteranceFinished(string text, string error)
  signal revealRequested()
  signal inputFinished(string id, string text, string error)
  signal toolPageReceived(var message)
  signal choiceFinished(string id, string revision, int index, string error)
  // An agent asked this panel to place unsent text in a composer. The host
  // applies it and must answer with answerDraft(); nothing is ever submitted.
  signal draftRequested(var message)
  // True when the panel has the built-in browser (standalone native window).
  // Only then does the listener route companion_browser_open here.
  property bool browserHost: false
  // An agent asked this panel to show a web page for its conversation. The
  // host must answer exactly once with answerBrowserOpen().
  signal browserOpenRequested(var message)
  onBrowserHostChanged: Qt.callLater(reportPanel)

  onPanelVisibleChanged: Qt.callLater(reportPanel)
  onKeyboardFocusedChanged: Qt.callLater(reportPanel)
  onComposerFocusIdChanged: Qt.callLater(reportPanel)
  onOnlineChanged: if (online) Qt.callLater(reportPanel)

  Panel.AgentSessionState {
    id: sessions
    panelVisible: root.panelVisible
    onRevealRequested: root.revealRequested()
    onConversationIdChanged: Qt.callLater(root.reportPanel)
    onNavigationTokenChanged: Qt.callLater(root.reportPanel)
    onControlRequested: request => {
      if (!root.send(request)) {
        const failure = {type: "error", action: request.action, message: "Companion is disconnected."}
        sessions.controlReceived(failure)
        root.error = failure.message
        root.errorAction = request.action
      }
    }
  }
  Panel.ActivityHistoryState {
    id: activity
    onPageRequested: request => root.send(request)
  }

  function send(request) {
    return root.online && transport.send(request)
  }

  function reportPanel() {
    const id = sessions.viewedId
    root.send({action: "panel-state", id: id,
      composerFocused: id !== "" && root.composerFocusId === id,
      keyboardFocused: root.keyboardFocused,
      visible: root.panelVisible, navigationToken: sessions.navigationToken,
      draftHost: true, browserHost: root.browserHost, incrementalSessions: true})
  }

  function answerBrowserOpen(requestId, result) {
    const answer = {action: "agent-browser-open-result", requestId: requestId,
      outcome: result.outcome, reason: String(result.reason || "").slice(0, 600)}
    if (typeof result.url === "string" && result.url) answer.url = result.url.slice(0, 4096)
    root.send(answer)
  }

  function answerDraft(requestId, result) {
    root.send({action: "agent-draft-result", requestId: requestId,
      outcome: result.outcome, reason: result.reason || ""})
  }

  function finishInput(error) {
    const pending = root.pendingInput
    root.pendingInput = null
    if (pending) root.inputFinished(pending.id, pending.text, error)
  }

  function finishChoice(error) {
    const pending = root.pendingChoice
    root.pendingChoice = null
    if (pending) root.choiceFinished(pending.id, pending.revision, pending.index, error)
  }

  function finishUtterance(error) {
    const text = root.pendingUtterance
    root.pendingUtterance = ""
    root.pendingUtteranceId = ""
    if (text !== "") root.utteranceFinished(text, error)
  }

  function sendUtterance(target) {
    if (root.pendingUtterance === "") return
    root.reportPanel()
    if (!root.send({action: "submit-utterance", text: root.pendingUtterance, target: target})) {
      root.finishUtterance("Companion is disconnected; your draft is retained.")
    }
  }

  function sendInput(id, text) {
    // Protocol replies identify the action, not its request. Keep one pending
    // input across all tabs so a late acknowledgement cannot clear another draft.
    if (root.pendingInput) {
      root.inputFinished(id, text, "Wait for the previous message to be confirmed.")
      return
    }
    root.pendingInput = {id: id, text: text}
    if (!root.send({action: "send-agent", id: id, text: text})) {
      root.finishInput("Companion is disconnected; your draft is retained.")
    }
  }

  function choose(id, revision, index) {
    if (root.pendingChoice) {
      root.choiceFinished(id, revision, index, "Wait for the previous choice to be confirmed.")
      return
    }
    root.pendingChoice = {id: id, revision: revision, index: index}
    root.reportPanel()
    if (!root.send({action: "choose-agent", id: id, revision: revision, index: index})) {
      root.finishChoice("Companion is disconnected.")
    }
  }

  function disconnected() {
    sessions.disconnectControls()
    root.online = false
    root.textInputAvailable = false
    root.finishUtterance("Connection lost before confirmation. Check History before resending; your draft is retained.")
    root.finishInput("Connection lost before confirmation. Check the conversation before resending; your draft is retained.")
    root.finishChoice("Connection lost before confirmation. Check the conversation before choosing again.")
    root.speaking = false
    root.processing = 0
    root.history = []
    root.historyDeletionAvailable = false
    root.intents = []
    root.transcriptionCleanup = null
    root.captureStorage = null
    root.agentActions = ({})
    activity.disconnected()
  }

  function receive(message) {
    sessions.controlReceived(message)
    if (message.type === "state" && message.protocol === 1) {
      root.paused = message.paused === true
      root.pauseReason = message.pauseReason || ""
      root.speaking = message.speaking === true
      root.processing = message.processing || 0
      root.history = message.history || []
      root.historyDeletionAvailable = message.historyDeletionAvailable === true
      root.textInputAvailable = message.textInputAvailable === true
      const intents = message.intents || []
      if (JSON.stringify(intents) !== JSON.stringify(root.intents)) root.intents = intents
      const cleanup = message.transcriptionCleanup || null
      if (JSON.stringify(cleanup) !== JSON.stringify(root.transcriptionCleanup)) root.transcriptionCleanup = cleanup
      const storage = message.captureStorage || null
      if (JSON.stringify(storage) !== JSON.stringify(root.captureStorage)) root.captureStorage = storage
      const actions = message.agentActions || {}
      if (JSON.stringify(actions) !== JSON.stringify(root.agentActions)) root.agentActions = actions
      sessions.applyState(message)
      sessions.controlsAvailable = message.sessionControlsAvailable === true
      root.online = message.ready === true
      if (root.online) activity.observe(message.activitySessionId, message.activityHistoryCount)
    } else if (message.type === "agent-session") {
      sessions.update(message.session)
    } else if (message.type === "agent-actions") {
      root.agentActions = message.actions || {}
    } else if (message.type === "agent-history") {
      sessions.previousSessions = message.sessions || []
    } else if (message.type === "agent-restored") {
      sessions.restore(message.session, message.reveal)
    } else if (message.type === "agent-draft") {
      root.draftRequested(message)
    } else if (message.type === "agent-browser-open") {
      root.browserOpenRequested(message)
    } else if (message.type === "agent-removed") {
      sessions.remove(message.id)
    } else if (message.type === "history-deleted") {
      root.history = root.history.filter(row => row.id !== message.id)
      // Apply the shared state's tombstone before a delayed history page can
      // restore the card, matching the shell client's deletion lifecycle.
      activity.remove(message.sessionId, message.removed)
    } else if (message.type === "activity-entry") {
      activity.update(message.sessionId, message.entry)
    } else if (message.type === "result" || message.type === "error") {
      if (message.action === "agent-tool-page" || message.action === "agent-history-page") { root.toolPageReceived(message); return }
      const failure = message.type === "error" ? message.message : ""
      if (message.action === "send-agent") root.finishInput(failure)
      if (message.action === "submit-utterance") root.finishUtterance(failure)
      if (message.action === "choose-agent") root.finishChoice(failure)
      if (message.action === "activity-history") {
        if (failure) activity.loading = false
        else activity.page(message.result)
      }
      if (failure || message.result === "skipped") {
        root.error = failure || "Paste skipped: focus changed"
        root.errorAction = message.action || ""
      } else if (root.errorAction === message.action) {
        root.error = ""
        root.errorAction = ""
      }
    }
  }

  Connections {
    target: root.transport
    function onReceived(message) { root.receive(message) }
    function onDisconnected() { root.disconnected() }
  }
}
