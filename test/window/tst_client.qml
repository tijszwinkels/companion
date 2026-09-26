import QtQuick
import QtTest
import "../../integrations/window" as Native

TestCase {
  id: testCase
  name: "StandaloneClient"
  QtObject {
    id: backend
    property var requests: []
    property bool connected: true
    signal received(var message)
    signal disconnected()
    function send(message) { requests = requests.concat([message]); return connected }
  }
  Native.Client { id: client; transport: backend }
  SignalSpy { id: utterances; target: client; signalName: "utteranceFinished" }
  SignalSpy { id: inputs; target: client; signalName: "inputFinished" }
  SignalSpy { id: choices; target: client; signalName: "choiceFinished" }
  SignalSpy { id: reveals; target: client; signalName: "revealRequested" }
  SignalSpy { id: drafts; target: client; signalName: "draftRequested" }

  function session(id, turn) {
    return {id: id, title: id, status: "idle", completedTurnId: turn || "", messages: []}
  }
  function snapshot(entries) {
    backend.received({type: "state", protocol: 1, ready: true, sessions: entries,
      activitySessionId: "activity", activityHistoryCount: 0})
  }
  function init() {
    client.disconnected()
    client.activity.reset("")
    client.sessions.sessions = []
    client.sessions.knownIds = ({})
    client.sessions.unreadIds = ({})
    client.sessions.completedTurns = ({})
    client.sessions.selectedId = ""
    client.sessions.showingPrevious = false
    client.panelVisible = false
    client.keyboardFocused = false
    client.composerFocusId = ""
    backend.connected = true
    backend.requests = []
    inputs.clear(); choices.clear(); reveals.clear(); utterances.clear()
  }
  function test_activity_text_orders_focus_before_submission_and_does_not_replay() {
    snapshot([])
    client.pendingUtterance = "new session inspect this"
    client.keyboardFocused = false
    client.sendUtterance("0x123")
    compare(backend.requests[backend.requests.length - 2].action, "panel-state")
    compare(backend.requests[backend.requests.length - 2].keyboardFocused, false)
    compare(backend.requests[backend.requests.length - 1], {
      action: "submit-utterance", text: "new session inspect this", target: "0x123"})
    backend.received({type: "result", action: "submit-utterance", result: "queued"})
    compare(Array.from(utterances.signalArguments[0]), ["new session inspect this", ""])
    client.pendingUtterance = "another message"
    backend.disconnected()
    compare(utterances.count, 2)
    verify(utterances.signalArguments[1][1].indexOf("Check History") >= 0)
    backend.requests = []
    snapshot([])
    wait(0)
    verify(!backend.requests.some(request => request.action === "submit-utterance"))
  }
  function test_ordered_choice_and_visible_owner() {
    snapshot([session("a")])
    client.panelVisible = true
    client.keyboardFocused = true
    client.composerFocusId = "a"
    wait(0)
    backend.requests = []
    client.choose("a", "revision", 1)
    compare(backend.requests[0], {action: "panel-state", id: "a", composerFocused: true, keyboardFocused: true, visible: true, navigationToken: client.sessions.navigationToken, draftHost: true,
      incrementalSessions: true})
    compare(backend.requests[1], {action: "choose-agent", id: "a", revision: "revision", index: 1})
    backend.received({type: "result", action: "choose-agent"})
    compare(Array.from(choices.signalArguments[0]), ["a", "revision", 1, ""])
  }
  function test_delayed_ack_cannot_clear_successor_draft() {
    snapshot([session("a"), session("b")])
    client.sendInput("a", "first")
    client.sendInput("b", "second")
    compare(inputs.count, 1)
    compare(inputs.signalArguments[0][0], "b")
    verify(inputs.signalArguments[0][2].length > 0)
    compare(client.pendingInput.text, "first")
    backend.received({type: "result", action: "send-agent"})
    compare(Array.from(inputs.signalArguments[1]), ["a", "first", ""])
    compare(client.pendingInput, null)
  }
  function test_disconnect_does_not_replay_and_reconnect_does_not_reveal() {
    snapshot([session("a")])
    compare(reveals.count, 1)
    client.sendInput("a", "unconfirmed")
    backend.connected = false
    backend.disconnected()
    compare(inputs.count, 1)
    verify(inputs.signalArguments[0][2].indexOf("Check the conversation") >= 0)
    backend.requests = []
    backend.connected = true
    snapshot([session("a")])
    wait(0)
    compare(reveals.count, 1)
    verify(!backend.requests.some(request => request.action === "send-agent"))
  }
  function test_transcription_cleanup_state_follows_snapshots_and_clears_on_disconnect() {
    snapshot([])
    compare(client.transcriptionCleanup, null, "Older listeners send no cleanup state")
    backend.received({type: "state", protocol: 1, ready: true, sessions: [],
      activitySessionId: "activity", activityHistoryCount: 0, transcriptionCleanup: {enabled: true}})
    compare(client.transcriptionCleanup.enabled, true)
    backend.disconnected()
    compare(client.transcriptionCleanup, null)
  }
  function test_hidden_completion_and_saved_reopen() {
    snapshot([session("a"), session("b")])
    client.panelVisible = true
    client.sessions.select("a")
    backend.received({type: "agent-session", session: session("b", "turn")})
    verify(client.sessions.unreadIds.b)
    client.sessions.select("b")
    verify(!client.sessions.unreadIds.b)
    backend.received({type: "agent-removed", id: "b"})
    backend.received({type: "agent-history", sessions: [{id: "b", title: "Saved"}]})
    compare(client.sessions.previousSessions.length, 1)
    backend.received({type: "agent-restored", session: session("b", "turn")})
    compare(client.sessions.conversationId, "b")
    verify(!client.sessions.unreadIds.b)
  }
  function test_agent_draft_is_delegated_and_answered_without_revealing() {
    snapshot([session("a")])
    compare(client.sessions.conversationId, "a")
    backend.requests = []
    drafts.clear()
    reveals.clear()
    const request = {type: "agent-draft", requestId: "draft-1", id: "a", text: "Proposal",
      ifDraftExists: "reject", focus: false, source: {sessionId: "b", title: "Sender"}}
    backend.received(request)
    compare(drafts.count, 1)
    compare(drafts.signalArguments[0][0].text, "Proposal")
    compare(reveals.count, 0)
    client.answerDraft("draft-1", {outcome: "conflict", reason: ""})
    compare(backend.requests[0], {action: "agent-draft-result", requestId: "draft-1", outcome: "conflict", reason: ""})

    // An agent reopening a saved conversation quietly does not select it.
    backend.received({type: "agent-restored", session: session("c"), reveal: false})
    compare(client.sessions.sessions.length, 2)
    compare(client.sessions.conversationId, "a")
    compare(reveals.count, 0)
  }
  function test_session_less_state_retains_conversations_controls_and_navigation() {
    // Routine state after the incrementalSessions report omits conversations.
    backend.received({type: "state", protocol: 1, ready: true,
      sessions: [session("a"), session("b")], sessionOrderRevision: "order-1",
      previousSessions: [{id: "saved", title: "Saved"}], sessionControlsAvailable: true,
      activitySessionId: "activity", activityHistoryCount: 0})
    client.panelVisible = true
    client.sessions.select("b")
    client.sessions.modelCatalog = ({models: ["synthetic/model"]})
    backend.received({type: "agent-session", session: {id: "b", title: "b", status: "running",
      messages: [{id: "streamed", kind: "assistant", text: "Streamed", state: "running"}]}})
    backend.received({type: "agent-actions", actions: {sessionId: "b", choices: [], stopRunId: "run"}})
    const entries = client.sessions.sessions
    const token = client.sessions.navigationToken
    reveals.clear()

    for (let index = 0; index < 5; index++) {
      backend.received({type: "state", protocol: 1, ready: true, speaking: index % 2 === 0,
        processing: 1, history: [{id: "utterance-" + index}], sessionControlsAvailable: true,
        agentActions: {sessionId: "b", choices: [], stopRunId: "run"},
        activitySessionId: "activity", activityHistoryCount: index})
    }

    verify(client.sessions.sessions === entries, "The conversation array is not rebuilt")
    compare(client.sessions.sessions[1].messages[0].text, "Streamed")
    compare(client.sessions.orderRevision, "order-1")
    compare(client.sessions.previousSessions.length, 1)
    compare(client.sessions.conversationId, "b")
    compare(client.sessions.navigationToken, token, "Voice navigation stays valid")
    compare(client.sessions.controlsAvailable, true)
    compare(client.sessions.modelCatalog.models[0], "synthetic/model")
    compare(client.agentActions.stopRunId, "run")
    compare(client.history[0].id, "utterance-4", "Activity fields still update")
    compare(reveals.count, 0)

    // Ordered agent events keep applying between session-less states.
    backend.received({type: "agent-order", ids: ["b", "a"], revision: "order-2"})
    backend.received({type: "state", protocol: 1, ready: true, sessionControlsAvailable: true,
      activitySessionId: "activity", activityHistoryCount: 5})
    compare(client.sessions.sessions.map(entry => entry.id), ["b", "a"])
    compare(client.sessions.orderRevision, "order-2")
    backend.received({type: "agent-removed", id: "a"})
    backend.received({type: "state", protocol: 1, ready: true, sessionControlsAvailable: true,
      activitySessionId: "activity", activityHistoryCount: 5})
    compare(client.sessions.sessions.length, 1)

    // The first state after reconnecting is authoritative, including an
    // older listener that has no conversation fields at all.
    backend.disconnected()
    backend.received({type: "state", protocol: 1, ready: true,
      activitySessionId: "activity", activityHistoryCount: 0})
    compare(client.sessions.sessions.length, 0)
    compare(client.sessions.previousSessions.length, 0)
    compare(client.sessions.orderRevision, "")
  }
  function test_history_deletion_survives_delayed_pages_and_reconnect() {
    const entry = {id: "utterance", sequence: 1, revision: 1,
      utterance: "Synthetic history", intent: "IGNORE", outcome: "ignored",
      observedAt: 1, correct: null, actualIntent: null}
    backend.received({type: "state", protocol: 1, ready: true, sessions: [],
      history: [{id: "utterance"}, {id: "neighbour"}], historyDeletionAvailable: true,
      activitySessionId: "activity", activityHistoryCount: 1})
    compare(client.historyDeletionAvailable, true)
    backend.received({type: "activity-entry", sessionId: "activity", entry: entry})
    compare(client.activity.model.count, 1)
    backend.received({type: "history-deleted", sessionId: "activity", id: entry.id,
      removed: {id: entry.id, sequence: 1, revision: 2, deleted: true}})
    compare(client.history.length, 1)
    compare(client.history[0].id, "neighbour")
    compare(client.activity.model.count, 0)
    backend.received({type: "result", action: "activity-history", result: {
      sessionId: "activity", entries: [entry], next: null, through: 1}})
    compare(client.activity.model.count, 0, "A delayed page cannot restore the deleted card")
    backend.disconnected()
    compare(client.historyDeletionAvailable, false)
    snapshot([])
    compare(client.historyDeletionAvailable, false, "Older/preview listeners do not offer deletion")
    backend.received({type: "activity-entry", sessionId: "activity", entry: entry})
    compare(client.activity.model.count, 0, "Reconnect retains deletion tombstones")
  }
}
