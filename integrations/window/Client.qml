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
  // Voice projection: controls of the voice-target conversation only.
  property var agentActions: ({})
  // Controls of each conversation this connection shows, keyed by session ID,
  // from `agent-view-actions`. Null until the listener sends one on the
  // current connection (older listeners never do): views then fall back to
  // showing controls only for the `agentActions` conversation.
  property var viewAgentActions: null
  // Manual recording: whether the listener offers it, and the current
  // recording {recordingId, sessionId, state} or null.
  property bool recordingAvailable: false
  property var recording: null
  // Conversation id of a Record request awaiting the listener's answer.
  property string pendingRecording: ""
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
  signal appChatPermissionReceived(var message)
  signal choiceFinished(string id, string revision, int index, string error)
  // Manual recording replies and events for the panel that started it. The
  // host answers each append with answerRecordingAppend().
  signal recordingStartFinished(string id, string recordingId, string error)
  signal recordingStopFinished(string error)
  signal recordingAppendRequested(var message)
  signal recordingFinished(var message)
  signal recordingLost()
  // An agent asked this panel to place unsent text in a composer. The host
  // applies it and must answer with answerDraft(); nothing is ever submitted.
  signal draftRequested(var message)
  // A draft change from the listener that this UI did not write itself.
  signal draftChanged(string id, string text, string source)
  // An agent's draft asked to be shown: select its conversation.
  signal draftFocusRequested(string id)

  // This UI's copy of the listener's drafts (conversation id -> text), for
  // views that show a conversation. Updated by its own writes at once and by
  // the listener's changes. Never sent anywhere else.
  property var serverDrafts: ({})
  // Own edits sent and not yet confirmed by the listener's change:
  // edit ID -> {id, text}, and per conversation how many are in flight.
  // While any is in flight, other editors' changes for that conversation are
  // not shown: ours were sent before we saw theirs, so the listener receives
  // ours after theirs and ours win. Once none is in flight the display
  // follows the listener's latest change (its order, never a refusal).
  property var ownDraftEdits: ({})
  property var draftEditsInFlight: ({})
  property int draftEditCounter: 0
  // The latest edit of each conversation this UI wrote and has not seen
  // confirmed (conversation id -> {editId, text}). Only the confirmation of
  // that latest edit settles it: an older edit with equal text does not.
  property var latestDraftEdits: ({})
  // The listener's last known text per conversation, including changes not
  // shown because own edits were in flight; Discard returns to it.
  property var listenerDrafts: ({})
  // The provenance of that text ("" for the person's own): an agent's name
  // while the draft is still its unedited proposal. Shown again with the
  // text whenever this UI returns to the listener's draft (R4-2).
  property var listenerSources: ({})
  // Unconfirmed text appeared or changed (unsavedDrafts/latestDraftEdits),
  // possibly for a conversation that no longer exists (a late edit); the
  // window controller then offers it in the closed-conversation notice.
  signal unconfirmedDraftsChanged()
  // Conversations whose shown text is NOT saved in the listener, with the
  // reason (conversation id -> reason): typed while disconnected, refused,
  // or sent before a disconnect without a confirmation. The text stays on
  // screen and is never written again by itself (another editor may have
  // changed the draft meanwhile); the person saves or discards it. Replaced
  // as a whole object on every change, so views can bind to it.
  property var unsavedDrafts: ({})

  function markUnsaved(id, reason) {
    const next = Object.assign({}, root.unsavedDrafts)
    if (reason) next[id] = reason
    else delete next[id]
    root.unsavedDrafts = next
    root.unconfirmedDraftsChanged()
  }

  // A view's edit, for the conversation it was typed for. The last write the
  // listener receives wins; there is no base revision to be refused for.
  function writeDraft(id, text, recording) {
    if (typeof id !== "string" || id === "" || typeof text !== "string") return
    root.draftEditCounter++
    const editId = "edit-" + root.draftEditCounter
    if (text === "") delete root.serverDrafts[id]
    else root.serverDrafts[id] = text
    root.latestDraftEdits[id] = {editId: editId, text: text}
    root.unconfirmedDraftsChanged()
    // `requestId` correlates a refusal with this edit.
    const request = {action: "draft-set", id: id, text: text, editId: editId, requestId: editId}
    // Recorded words may pass the editing bound; the listener checks that
    // this panel really records into that conversation.
    if (recording === true) request.recording = true
    if (root.send(request)) {
      root.ownDraftEdits[editId] = {id: id, text: text}
      root.draftEditsInFlight[id] = (root.draftEditsInFlight[id] || 0) + 1
    } else {
      root.markUnsaved(id, "Companion is not connected; your text is not saved yet.")
    }
  }

  // The person saves the shown (unsaved) text: an ordinary new edit.
  function saveDraft(id) {
    if (root.unsavedDrafts[id] === undefined) return
    root.markUnsaved(id, "")
    root.writeDraft(id, root.serverDrafts[id] || "", false)
  }

  // The person discards the unsaved text: the listener's version is shown.
  function discardUnsavedDraft(id) {
    if (root.unsavedDrafts[id] === undefined) return
    root.markUnsaved(id, "")
    delete root.latestDraftEdits[id]
    const text = root.listenerDrafts[id] || ""
    if (text === "") delete root.serverDrafts[id]
    else root.serverDrafts[id] = text
    root.draftChanged(id, text, root.listenerSources[id] || "")
  }

  // An own edit is settled: confirmed by its change, or refused.
  function settleDraftEdit(editId) {
    const edit = root.ownDraftEdits[editId]
    if (!edit) return null
    delete root.ownDraftEdits[editId]
    const remaining = (root.draftEditsInFlight[edit.id] || 1) - 1
    if (remaining > 0) root.draftEditsInFlight[edit.id] = remaining
    else delete root.draftEditsInFlight[edit.id]
    return edit
  }

  // True when the panel has the built-in browser (standalone native window).
  // Only then does the listener route companion_browser_open here.
  property bool browserHost: false
  // An agent asked this panel to show a web page for its conversation. The
  // host must answer exactly once with answerBrowserOpen().
  signal browserOpenRequested(var message)
  onBrowserHostChanged: Qt.callLater(reportPanel)

  // Pop-out windows (native host only). With popoutHost, panel-state also
  // carries `popoutHost`, `rail` and `popouts`, and the existing fields keep
  // describing the main surface: `id`/`composerFocused`/`keyboardFocused` the
  // main panel only, `visible` any native Companion surface. Without it the
  // report is exactly the legacy one.
  property bool popoutHost: false
  // Conversation visible in the main surface: empty while it is hidden,
  // shows Activity/Previous/the browser, or its selection is popped out.
  property string mainViewId: sessions.viewedId
  // "full" or "compact" (main surface shrunk to its rail).
  property string rail: "full"
  // Visible pop-out windows: [{id, active, composerFocused}].
  property var popouts: []
  // Main surface or at least one pop-out window is on screen.
  property bool anyViewVisible: panelVisible
  // While true, reports wait (briefly, while a quiet window opening settles)
  // and the latest state is sent once when it becomes false.
  property bool reportsHeld: false
  property bool reportPending: false
  onReportsHeldChanged: if (!reportsHeld && reportPending) reportPanel()
  // companion_session_present: show the caller's conversation in a window or
  // in the sidebar. The host must answer exactly once with answerPresent().
  signal presentRequested(var message)
  // "Go to session N" (agent-select) for a pop-out host. The host focuses an
  // existing window or selects the sidebar tab.
  signal navigationRequested(string id)
  onPopoutHostChanged: Qt.callLater(reportPanel)
  onMainViewIdChanged: Qt.callLater(reportPanel)
  onRailChanged: Qt.callLater(reportPanel)
  onPopoutsChanged: Qt.callLater(reportPanel)
  onAnyViewVisibleChanged: Qt.callLater(reportPanel)

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

  // One atomic report of every native view. Repeated identical reports are
  // harmless: the listener changes nothing for them.
  function reportPanel() {
    if (root.reportsHeld) {
      root.reportPending = true
      return
    }
    root.reportPending = false
    const id = root.popoutHost ? root.mainViewId : sessions.viewedId
    const report = {action: "panel-state", id: id,
      composerFocused: id !== "" && root.composerFocusId === id,
      keyboardFocused: root.keyboardFocused,
      visible: root.popoutHost ? root.anyViewVisible : root.panelVisible,
      navigationToken: sessions.navigationToken,
      draftHost: true, browserHost: root.browserHost, incrementalSessions: true}
    // A send from this conversation's text box awaits its reply: agent drafts
    // for it are refused meanwhile (the listener checks this). Absent: none.
    if (root.pendingInput) report.pendingSend = root.pendingInput.id
    if (root.popoutHost) {
      report.popoutHost = true
      report.rail = root.rail
      report.popouts = root.popouts.map(entry => ({id: entry.id, active: entry.active,
        composerFocused: entry.composerFocused}))
    }
    root.send(report)
  }

  function answerPresent(requestId, result) {
    const answer = {action: "agent-present-result", requestId: requestId, outcome: result.outcome}
    if (result.reason) answer.reason = String(result.reason).slice(0, 300)
    if (result.outcome === "shown" || result.outcome === "returned") answer.focused = result.focused === true
    root.send(answer)
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

  function startRecording(id, draftLength) {
    if (root.pendingRecording !== "") {
      root.recordingStartFinished(id, "", "Wait for the previous recording request to be confirmed.")
      return
    }
    root.pendingRecording = id
    // The listener records only into the conversation this panel reports.
    root.reportPanel()
    if (!root.send({action: "start-recording", id: id, draftLength: draftLength})) {
      root.finishRecordingStart("", "Companion is disconnected.")
    }
  }

  function finishRecordingStart(recordingId, error) {
    const id = root.pendingRecording
    root.pendingRecording = ""
    if (id !== "") root.recordingStartFinished(id, recordingId, error)
  }

  function stopRecording(id) {
    if (!root.send({action: "stop-recording", id: id})) root.recordingStopFinished("Companion is disconnected.")
  }

  // Recorded words applied to a conversation's text box are acknowledged
  // only once the listener accepted that exact edit (draft change with its
  // edit ID): `appended` then, `unavailable` if the listener refused it. If
  // the connection drops first, no answer is sent and the listener reports
  // the chunk as unconfirmed. Edit ID -> {requestId, length}.
  property var recordingAcks: ({})

  function answerRecordingAppendWhenSaved(requestId, result, id, applied) {
    // Applied by the listener itself: nothing to wait for.
    if (applied === true || result.outcome !== "appended") {
      root.answerRecordingAppend(requestId, result)
      return
    }
    const latest = root.latestDraftEdits[id]
    if (!latest || !root.ownDraftEdits[latest.editId]) {
      // Nothing in flight for it: either already confirmed text (no change)
      // or the write could not be sent (then the listener never answers).
      if (root.unsavedDrafts[id] === undefined) root.answerRecordingAppend(requestId, result)
      return
    }
    root.recordingAcks[latest.editId] = {requestId: requestId, length: result.length}
  }

  function settleRecordingAck(editId, saved, reason) {
    const ack = root.recordingAcks[editId]
    if (!ack) return
    delete root.recordingAcks[editId]
    if (saved) root.answerRecordingAppend(ack.requestId, {outcome: "appended", length: ack.length})
    else root.answerRecordingAppend(ack.requestId, {outcome: "unavailable", reason: reason})
  }

  function answerRecordingAppend(requestId, result) {
    const answer = {action: "recording-append-result", requestId: requestId, outcome: result.outcome}
    if (result.outcome === "appended") answer.length = result.length
    else answer.reason = String(result.reason || "").slice(0, 300)
    root.send(answer)
  }

  function finishInput(error) {
    const pending = root.pendingInput
    root.pendingInput = null
    if (pending) Qt.callLater(root.reportPanel)
    if (pending) root.inputFinished(pending.id, pending.text, error)
    if (pending && !error) root.settleSentDraft(pending.id, pending.text)
  }

  // A message was sent. Only the listener clears the draft, and only while it
  // still is exactly the sent text (clear-if-equal); this UI never writes an
  // empty draft for a send, so a different draft (another editor's, or one
  // seen after a reconnect) stays. If this UI still shows the sent text, the
  // text no longer needs saving: show the listener's current draft instead.
  // Newer typing, or own edits still awaiting their answer, stay as they are.
  function settleSentDraft(id, text) {
    if ((root.serverDrafts[id] || "") !== text) return
    if ((root.draftEditsInFlight[id] || 0) > 0) return
    root.markUnsaved(id, "")
    delete root.latestDraftEdits[id]
    const current = root.listenerDrafts[id] || ""
    if (current === "") delete root.serverDrafts[id]
    else root.serverDrafts[id] = current
    root.draftChanged(id, current, root.listenerSources[id] || "")
  }

  // A conversation disappeared (closed elsewhere, or missing after a
  // reconnect). Text this UI showed for it that the listener has not
  // confirmed (not saved, or its latest edit still unanswered) is returned
  // once, for the closed-conversation notice, and forgotten here; a later
  // answer to that edit no longer marks it. Confirmed text stays the
  // listener's (it keeps drafts of closed conversations).
  function takeUnconfirmedDraft(id) {
    if (root.unsavedDrafts[id] === undefined && root.latestDraftEdits[id] === undefined) return ""
    const text = root.serverDrafts[id] || ""
    root.markUnsaved(id, "")
    delete root.latestDraftEdits[id]
    const current = root.listenerDrafts[id] || ""
    if (current === "") delete root.serverDrafts[id]
    else root.serverDrafts[id] = current
    return text
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
    // Tell the listener before the send itself, so an agent draft it handles
    // after this point already sees the pending send.
    root.reportPanel()
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
    root.finishRecordingStart("", "Connection lost before the recording started.")
    root.recordingLost()
    root.recordingAvailable = false
    root.recording = null
    root.speaking = false
    root.processing = 0
    root.history = []
    root.historyDeletionAvailable = false
    root.intents = []
    root.transcriptionCleanup = null
    root.captureStorage = null
    root.agentActions = ({})
    // The next connection's listener sends its own projection, if any.
    root.viewAgentActions = null
    activity.disconnected()
  }

  function receive(message) {
    if (message.type === "agent-select" && root.popoutHost) {
      // Same checks as the portable state (token, order, membership), but a
      // visible pop-out counts as a visible Companion surface.
      if (root.anyViewVisible && message.token === sessions.navigationToken
        && message.orderRevision === sessions.orderRevision
        && sessions.sessions.some(entry => entry.id === message.id)) {
        root.navigationRequested(message.id)
      }
      return
    }
    // The listener refused a draft write (e.g. longer than may be edited):
    // the text stays on screen, and the person is told it is not saved.
    // The listener refused a draft write (e.g. longer than may be edited):
    // the text stays on screen as not saved (unsavedDrafts), and
    // the person is told.
    if (message.action === "draft-set" && (message.type === "error"
        || (message.type === "result" && message.result && message.result.accepted === false))) {
      const refused = root.settleDraftEdit(message.requestId)
      root.settleRecordingAck(message.requestId, false, message.type === "error" ? message.message : message.result.reason)
      const reason = "Your text is not saved: " + (message.type === "error" ? message.message : message.result.reason)
      // The conversation's latest edit was refused: its shown text is unsaved.
      if (refused && root.latestDraftEdits[refused.id] && root.latestDraftEdits[refused.id].editId === message.requestId) {
        root.markUnsaved(refused.id, reason)
      }
      root.error = reason
      root.errorAction = "draft-set"
      return
    }
    sessions.controlReceived(message)
    if (message.type === "state" && message.protocol === 1) {
      root.paused = message.paused === true
      root.pauseReason = message.pauseReason || ""
      root.speaking = message.speaking === true
      root.processing = message.processing || 0
      root.history = message.history || []
      root.historyDeletionAvailable = message.historyDeletionAvailable === true
      root.textInputAvailable = message.textInputAvailable === true
      root.recordingAvailable = message.recordingAvailable === true
      const recording = message.recording || null
      if (JSON.stringify(recording) !== JSON.stringify(root.recording)) root.recording = recording
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
    } else if (message.type === "agent-view-actions") {
      // The whole projection is replaced: a conversation missing from it is
      // no longer shown by this connection and must not keep old controls.
      const byId = {}
      for (const actions of message.actions || []) {
        if (actions && typeof actions.sessionId === "string" && actions.sessionId !== "") {
          byId[actions.sessionId] = actions
        }
      }
      root.viewAgentActions = byId
    } else if (message.type === "agent-history") {
      sessions.previousSessions = message.sessions || []
    } else if (message.type === "agent-restored") {
      sessions.restore(message.session, message.reveal)
    } else if (message.type === "draft-snapshot") {
      // Reading on (re)connect: the listener's whole map. A conversation it
      // does not list has no draft there (cleared elsewhere meanwhile).
      const drafts = {}
      const sources = {}
      for (const entry of message.drafts || []) {
        if (entry && typeof entry.id === "string" && typeof entry.text === "string") {
          drafts[entry.id] = entry.text
          sources[entry.id] = typeof entry.source === "string" ? entry.source : ""
        }
      }
      // Edits in flight before the reconnect are uncertain, and text typed
      // while disconnected was never sent. That text stays on screen as
      // unsaved, unless the listener already holds exactly it; it is not
      // written again by itself (the draft may have changed elsewhere
      // meanwhile). Everything else follows the listener, including drafts
      // that are now empty. Reading never writes.
      root.ownDraftEdits = ({})
      root.draftEditsInFlight = ({})
      // Recorded chunks not confirmed before the reconnect stay unanswered:
      // the listener already reported them as unconfirmed.
      root.recordingAcks = ({})
      root.listenerDrafts = Object.assign({}, drafts)
      root.listenerSources = Object.assign({}, sources)
      const previous = root.serverDrafts
      const pending = root.latestDraftEdits
      root.latestDraftEdits = ({})
      const kept = {}
      for (const id of Object.keys(pending)) {
        if ((drafts[id] || "") === pending[id].text) {
          root.markUnsaved(id, "")
          continue
        }
        kept[id] = pending[id].text
        root.markUnsaved(id, root.unsavedDrafts[id]
          || "Companion reconnected before this text was confirmed; it may not be saved.")
      }
      for (const id of Object.keys(root.unsavedDrafts)) {
        if (kept[id] === undefined && previous[id] !== undefined && (drafts[id] || "") !== previous[id]) kept[id] = previous[id]
      }
      for (const id of Object.keys(kept)) {
        if (kept[id] === "") delete drafts[id]
        else drafts[id] = kept[id]
      }
      root.serverDrafts = drafts
      const ids = Object.keys(Object.assign({}, previous, drafts))
      for (const id of ids) {
        if (kept[id] === undefined) root.draftChanged(id, drafts[id] || "", sources[id] || "")
      }
    } else if (message.type === "agent-draft-focus") {
      if (typeof message.id === "string") root.draftFocusRequested(message.id)
    } else if (message.type === "draft") {
      if (typeof message.id !== "string" || typeof message.text !== "string") return
      const id = message.id
      // Our own edit confirmed: that text is saved.
      if (message.text === "") delete root.listenerDrafts[id]
      else root.listenerDrafts[id] = message.text
      if (message.text === "" || !message.source) delete root.listenerSources[id]
      else root.listenerSources[id] = message.source
      const own = message.editId ? root.settleDraftEdit(message.editId) : null
      if (own) root.settleRecordingAck(message.editId, true, "")
      // Only the conversation's latest edit settles its pending text (an
      // older edit with equal text does not), and clears "not saved".
      const latest = root.latestDraftEdits[id]
      if (own && latest && latest.editId === message.editId) {
        delete root.latestDraftEdits[id]
        root.markUnsaved(id, "")
      }
      // Newer own edits still in flight: they arrive after this change, so
      // the display keeps the local text.
      if ((root.draftEditsInFlight[id] || 0) > 0) return
      // Unsaved text stays shown (and is what Save writes) until the person
      // saves or discards it; Discard then shows this latest listener text.
      if (root.unsavedDrafts[id] !== undefined) return
      // Otherwise the display follows the listener's latest change (own or
      // another editor's), so every editor converges on the same text.
      if (message.text === "") delete root.serverDrafts[id]
      else root.serverDrafts[id] = message.text
      root.draftChanged(id, message.text, message.source || "")
    } else if (message.type === "agent-draft") {
      root.draftRequested(message)
    } else if (message.type === "recording-append") {
      root.recordingAppendRequested(message)
    } else if (message.type === "recording-finished") {
      root.recordingFinished(message)
    } else if (message.type === "agent-browser-open") {
      root.browserOpenRequested(message)
    } else if (message.type === "agent-present") {
      if (root.popoutHost) root.presentRequested(message)
      else root.answerPresent(message.requestId, {outcome: "unsupported",
        reason: "This Companion panel cannot show conversations in their own windows."})
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
      if (message.action === "set-application-chat-read" || message.action === "set-application-chat-send") { root.appChatPermissionReceived(message); return }
      if (message.action === "agent-tool-page" || message.action === "agent-history-page") { root.toolPageReceived(message); return }
      const failure = message.type === "error" ? message.message : ""
      if (message.action === "send-agent") root.finishInput(failure)
      if (message.action === "submit-utterance") root.finishUtterance(failure)
      if (message.action === "choose-agent") root.finishChoice(failure)
      if (message.action === "start-recording") {
        const started = message.result && typeof message.result.recordingId === "string" ? message.result.recordingId : ""
        root.finishRecordingStart(failure ? "" : started, failure || (started ? "" : "Recording did not start."))
      }
      if (message.action === "stop-recording") root.recordingStopFinished(failure)
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
