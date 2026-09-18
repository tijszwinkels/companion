import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 600
  height: 900
  Component { id: stateComponent; Panel.AgentSessionState {} }
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: expanded ? 600 : 420
      height: expanded ? 900 : 400
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
    return {id: id, kind: kind, text: text, toolName: kind === "tool" ? "read" : "",
      input: kind === "tool" ? '{"path":"README.md"}' : "", state: "done", screenshot: kind === "user"}
  }
  function session(messages) {
    return {id: "question-1", title: "What is this?", status: "running", model: "fixture", error: "", messages: messages}
  }

  TestCase {
    name: "CompanionAgentSessions"
    when: windowShown

    function test_new_session_opens_once_streams_and_reconnects_without_reopening() {
      const state = createTemporaryObject(stateComponent, parent)
      let revealed = 0
      state.revealRequested.connect(function() { revealed++ })
      state.update(session([message("user", "user", "Question")]))
      compare(revealed, 1)
      compare(state.selectedId, "question-1")
      compare(state.conversationId, "question-1")
      state.showingPrevious = true
      compare(state.conversationId, "", "History is not a voice message destination")
      state.showingPrevious = false
      compare(state.conversationId, "question-1")
      state.update(session([message("reply", "assistant", "First token")]))
      compare(state.sessions[0].messages.length, 2)
      state.update(session([message("reply", "assistant", "First token and more")]))
      compare(state.sessions[0].messages.length, 2)
      compare(state.sessions[0].messages[1].text, "First token and more")
      state.replace(state.sessions)
      compare(revealed, 1)
      state.selectedId = ""
      state.update(session([]))
      compare(state.selectedId, "")
      compare(revealed, 1)
      state.remove("question-1")
      compare(state.sessions.length, 0)
    }

    function test_markdown_is_rendered_only_for_assistant_answers() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([message("user", "user", "**literal**"), message("reply", "assistant", "**bold**")])]
      panel.selectedSessionId = "question-1"
      tryVerify(function() { return findChild(panel, "bubble-reply") !== null })
      const answer = findChild(findChild(panel, "bubble-reply"), "messageText")
      compare(answer.textFormat, TextEdit.MarkdownText)
      compare(answer.getText(0, answer.length).trim(), "bold")
      const question = findChild(findChild(panel, "bubble-user"), "messageText")
      compare(question.textFormat, TextEdit.PlainText)
      compare(question.getText(0, question.length), "**literal**")
    }

    function test_tool_disclosure_survives_streaming_updates() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([message("tool", "tool", "partial output")])]
      panel.selectedSessionId = "question-1"
      tryVerify(function() { return findChild(panel, "bubble-tool") !== null })
      const bubble = findChild(panel, "bubble-tool")
      compare(bubble.expanded, false)
      mouseClick(bubble, 24, 14)
      compare(bubble.expanded, true)
      panel.sessions = [session([message("tool", "tool", "complete output")])]
      compare(findChild(panel, "bubble-tool"), bubble)
      compare(bubble.expanded, true)
      compare(bubble.body, "complete output")
    }

    function test_content_expands_once_and_activity_stays_compact() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([message("reply", "assistant", "A line of the answer.\n\n".repeat(60))])]
      panel.selectedSessionId = "question-1"
      tryCompare(panel, "expanded", true)
      compare(panel.width, 600)
      compare(panel.height, 900)
      panel.sessions = [session([message("reply", "assistant", "Short answer")])]
      compare(panel.expanded, true)
      panel.selectedSessionId = ""
      compare(panel.expanded, false)
      compare(panel.height, 400)
      panel.selectedSessionId = "question-1"
      compare(panel.expanded, true)
    }

    function test_session_controls_target_the_selected_question() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([message("user", "user", "Question")])]
      panel.selectedSessionId = "question-1"
      let stopped = ""
      let dismissed = ""
      panel.stopSessionRequested.connect(function(id) { stopped = id })
      panel.dismissSessionRequested.connect(function(id) { dismissed = id })
      verify(waitForRendering(panel))
      mouseClick(findChild(panel, "stopSession"), 20, 14)
      compare(stopped, "question-1")
      mouseClick(findChild(panel, "dismissSession"))
      compare(dismissed, "question-1")
    }

    function test_composer_enter_sends_shift_enter_adds_a_line_and_ack_preserves_edits() {
      const panel = createTemporaryObject(panelComponent, parent)
      const completed = session([message("reply", "assistant", "Answer")])
      completed.status = "completed"
      panel.sessions = [completed]
      panel.selectedSessionId = "question-1"
      let submitted = null
      panel.sendSessionRequested.connect(function(id, text) { submitted = {id: id, text: text} })
      verify(waitForRendering(panel))
      const composer = findChild(panel, "sessionComposer")
      mouseClick(composer, 20, 15)
      composer.forceActiveFocus()
      compare(panel.composerFocusId, "question-1")
      composer.text = "Explain further"
      composer.cursorPosition = composer.length
      keyClick(Qt.Key_Return, Qt.ShiftModifier)
      compare(submitted, null)
      verify(composer.text.indexOf("\n") >= 0)
      keyClick(Qt.Key_Return)
      compare(submitted.id, "question-1")
      compare(submitted.text, composer.text)
      verify(composer.text !== "", "Keep the draft until confirmation")
      composer.text = "Another edit before acknowledgement"
      panel.submitted(submitted.id, submitted.text, "")
      compare(composer.text, "Another edit before acknowledgement")
      keyClick(Qt.Key_Return)
      panel.submitted(submitted.id, submitted.text, "Request failed")
      compare(composer.text, "Another edit before acknowledgement")
      compare(findChild(panel, "sessionView").inputError, "Request failed")
      keyClick(Qt.Key_Return)
      panel.submitted(submitted.id, submitted.text, "")
      compare(composer.text, "")
      panel.visible = false
      compare(panel.composerFocusId, "")
    }

    function test_composer_drafts_belong_to_their_tabs() {
      const panel = createTemporaryObject(panelComponent, parent)
      const first = session([])
      const second = Object.assign({}, session([]), {id: "question-2"})
      panel.sessions = [first, second]
      panel.selectedSessionId = first.id
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Draft one"
      panel.selectedSessionId = second.id
      compare(composer.text, "")
      composer.text = "Draft two"
      panel.selectedSessionId = first.id
      compare(composer.text, "Draft one")
      panel.selectedSessionId = second.id
      compare(composer.text, "Draft two")
    }
  }
}
