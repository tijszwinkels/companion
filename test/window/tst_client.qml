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
  SignalSpy { id: inputs; target: client; signalName: "inputFinished" }
  SignalSpy { id: choices; target: client; signalName: "choiceFinished" }
  SignalSpy { id: reveals; target: client; signalName: "revealRequested" }

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
    inputs.clear(); choices.clear(); reveals.clear()
  }
  function test_ordered_choice_and_visible_owner() {
    snapshot([session("a")])
    client.panelVisible = true
    client.keyboardFocused = true
    client.composerFocusId = "a"
    wait(0)
    backend.requests = []
    client.choose("a", "revision", 1)
    compare(backend.requests[0], {action: "panel-state", id: "a", composerFocused: true, keyboardFocused: true})
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
