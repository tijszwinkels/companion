import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// Agent session tools: drafts, provenance labels and background tabs. All
// conversations are synthetic; no listener, model or desktop is involved.
Item {
  width: 600
  height: 900
  Component { id: stateComponent; Panel.AgentSessionState {} }
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 600
      height: 900
      online: true
      paused: false
      speaking: false
      processing: 0
      foreground: "#e0e6f0"
      muted: "#959faa"
      accent: "#82aaff"
      selection: "#283348"
      fontFamily: "sans-serif"
    }
  }

  function message(id, kind, text) {
    return {id: id, kind: kind, text: text, toolName: "", input: "", state: "done", screenshot: false}
  }
  function conversation(id, title) {
    return {id: id, title: title, status: "completed", model: "fixture", error: "",
      messages: [message(id + "-answer", "assistant", "Answer")]}
  }
  function draft(id, text, ifDraftExists) {
    return {requestId: "request-" + text, id: id, text: text, ifDraftExists: ifDraftExists || "reject",
      focus: false, source: {sessionId: "sender", title: "🔎 Research"}}
  }

  TestCase {
    name: "CompanionSessionDrafts"
    when: windowShown

    function openPanel() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [conversation("visible", "Visible"), conversation("hidden", "Hidden")]
      panel.selectedSessionId = "visible"
      verify(waitForRendering(panel))
      return panel
    }

    function test_draft_fills_an_empty_composer_labels_it_and_never_sends() {
      const panel = openPanel()
      let sent = 0
      panel.sendSessionRequested.connect(function() { sent++ })
      const composer = findChild(panel, "sessionComposer")
      const label = findChild(panel, "agentDraftSource")

      compare(panel.applyDraft(draft("visible", "Please check the logs")).outcome, "inserted")
      compare(composer.text, "Please check the logs")
      verify(label.visible)
      verify(label.text.indexOf("🔎 Research") >= 0)
      compare(sent, 0, "A draft must never submit a message")

      // Clearing the composer drops the attribution with the text.
      composer.text = ""
      verify(!label.visible)
    }

    function test_existing_user_text_is_retained_unless_append_is_requested() {
      const panel = openPanel()
      const composer = findChild(panel, "sessionComposer")
      composer.text = "My own words"

      const conflict = panel.applyDraft(draft("visible", "Agent words"))
      compare(conflict.outcome, "conflict")
      compare(composer.text, "My own words")
      verify(!findChild(panel, "agentDraftSource").visible)

      compare(panel.applyDraft(draft("visible", "Agent words", "append")).outcome, "appended")
      compare(composer.text, "My own words\n\nAgent words")

      const tooLong = panel.applyDraft(draft("visible", "x".repeat(4000), "append"))
      compare(tooLong.outcome, "conflict")
      compare(composer.text, "My own words\n\nAgent words")
    }

    function test_hidden_tab_draft_waits_without_changing_selection() {
      const panel = openPanel()
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Visible draft"

      compare(panel.applyDraft(draft("hidden", "For the other tab")).outcome, "inserted")
      compare(panel.selectedSessionId, "visible")
      compare(composer.text, "Visible draft")

      panel.selectedSessionId = "hidden"
      compare(composer.text, "For the other tab")
      verify(findChild(panel, "agentDraftSource").visible)
      panel.selectedSessionId = "visible"
      compare(composer.text, "Visible draft")

      // A second draft for the hidden tab now conflicts with the first.
      compare(panel.applyDraft(draft("hidden", "Another")).outcome, "conflict")
    }

    function test_unknown_tab_and_pending_send_are_explicit_non_changes() {
      const panel = openPanel()
      compare(panel.applyDraft(draft("closed", "Hello")).outcome, "unavailable")

      const composer = findChild(panel, "sessionComposer")
      composer.text = "Sending"
      findChild(panel, "sessionView").submit()
      composer.text = ""
      const pending = panel.applyDraft(draft("visible", "Racing draft"))
      compare(pending.outcome, "conflict")
      compare(composer.text, "")
    }

    function test_agent_messages_are_labelled_with_their_source() {
      const panel = createTemporaryObject(panelComponent, parent)
      const fromAgent = message("agent", "user", "Can you run the tests?")
      fromAgent.origin = {kind: "agent", sessionId: "sender", title: "🧪 Test plan", depth: 1}
      const fromUser = message("user", "user", "Mine")
      const entry = conversation("visible", "Visible")
      entry.messages = [fromUser, fromAgent]
      panel.sessions = [entry]
      panel.selectedSessionId = "visible"
      tryVerify(function() { return findChild(panel, "bubble-agent") !== null })
      compare(findChild(panel, "bubble-agent").fromAgent, true)
      compare(findChild(panel, "bubble-agent").originTitle, "🧪 Test plan")
      compare(findChild(panel, "bubble-user").fromAgent, false)
    }

    function test_background_tabs_and_quiet_reopening_do_not_steal_focus() {
      const state = createTemporaryObject(stateComponent, parent)
      let revealed = 0
      state.revealRequested.connect(function() { revealed++ })
      state.update(conversation("mine", "Mine"))
      compare(state.selectedId, "mine")
      compare(revealed, 1)

      const background = conversation("agent-opened", "Agent opened")
      background.openInBackground = true
      state.update(background)
      compare(state.sessions.length, 2)
      compare(state.selectedId, "mine")
      compare(revealed, 1)

      state.restore(conversation("reopened", "Reopened"), false)
      compare(state.sessions.length, 3)
      compare(state.selectedId, "mine")
      compare(revealed, 1)

      // Older listeners omit reveal; an explicit focus request selects it.
      state.restore(conversation("clicked", "Clicked"))
      compare(state.selectedId, "clicked")
      compare(revealed, 2)
      state.reveal("agent-opened")
      compare(state.selectedId, "agent-opened")
      compare(revealed, 3)
    }
  }
}
