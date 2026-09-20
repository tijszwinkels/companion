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
      compare(answer.textFormat, TextEdit.RichText)
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

    function test_running_conversation_accepts_queued_input_and_preserves_rejected_drafts() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([])]
      panel.selectedSessionId = "question-1"
      let submissions = []
      panel.sendSessionRequested.connect(function(id, text) { submissions.push({id: id, text: text}) })
      panel.focusComposer()
      const composer = findChild(panel, "sessionComposer")
      const send = findChild(panel, "sendSession")
      composer.text = "After this, explain the tests"
      compare(send.text, "Queue")
      verify(send.enabled)
      keyClick(Qt.Key_Return)
      compare(submissions.length, 1)
      keyClick(Qt.Key_Return)
      compare(submissions.length, 1, "Await acknowledgement before sending again")
      panel.submitted("question-1", composer.text, "Queue is full")
      compare(composer.text, "After this, explain the tests")
      keyClick(Qt.Key_Return)
      compare(submissions.length, 2)
      panel.submitted("question-1", composer.text, "")
      compare(composer.text, "")
      compare(panel.composerFocusId, "question-1")

      const queued = Object.assign(message("waiting", "user", "After this, explain the tests"), {state: "queued", screenshot: false})
      panel.sessions = [session([queued])]
      tryVerify(function() { return findChild(panel, "bubble-waiting") !== null })
      compare(findChild(panel, "bubble-waiting").state, "queued")
      queued.state = "error"
      panel.sessions = [session([queued])]
      compare(findChild(panel, "bubble-waiting").state, "error")
    }

    function test_alt_numbers_select_visible_tab_order_and_preserve_drafts() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessionSelected.connect(function(id) { panel.showingPrevious = false; panel.selectedSessionId = id })
      const sessions = []
      for (let index = 1; index <= 9; index++) sessions.push(Object.assign({}, session([]), {id: "question-" + index}))
      panel.sessions = sessions
      panel.selectedSessionId = "question-1"
      panel.focusComposer()
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Draft one"
      for (let index = 2; index <= 9; index++) {
        keyClick(Qt.Key_0 + index, Qt.AltModifier)
        tryCompare(panel, "selectedSessionId", "question-" + index)
        tryCompare(panel, "composerFocusId", "question-" + index)
      }
      composer.text = "Draft nine"
      keyClick(Qt.Key_1, Qt.AltModifier)
      tryCompare(panel, "composerFocusId", "question-1")
      compare(composer.text, "Draft one")
      keyClick(Qt.Key_9, Qt.AltModifier)
      tryCompare(panel, "composerFocusId", "question-9")
      compare(composer.text, "Draft nine")

      keyClick(Qt.Key_0, Qt.AltModifier)
      compare(panel.selectedSessionId, "")
      compare(panel.composerFocusId, "")
      compare(findChild(panel, "fullActivityStatus").visible, true)
      compare(findChild(panel, "activityStrip").visible, false)
      // Activity retains local navigation but no hidden composer cursor.
      keyClick(Qt.Key_X)
      keyClick(Qt.Key_9, Qt.AltModifier)
      tryCompare(panel, "composerFocusId", "question-9")
      compare(composer.text, "Draft nine")

      panel.sessions = sessions.filter(entry => entry.id !== "question-2")
      keyClick(Qt.Key_2, Qt.AltModifier)
      tryCompare(panel, "selectedSessionId", "question-3", 1000)
      keyClick(Qt.Key_9, Qt.AltModifier)
      compare(panel.selectedSessionId, "question-3", "Missing numbers do nothing")
      panel.animationsEnabled = false
      keyClick(Qt.Key_1, Qt.AltModifier)
      compare(panel.selectedSessionId, "question-3", "Closed native panels do not take these keys")
      keyClick(Qt.Key_0, Qt.AltModifier)
      compare(panel.selectedSessionId, "question-3", "Alt+0 also stays local to the open panel")
    }

    function test_local_super_alt_zero_and_tab_cycle_activity_and_conversations() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessionSelected.connect(function(id) { panel.showingPrevious = false; panel.selectedSessionId = id })
      panel.sessions = [session([]), Object.assign({}, session([]), {id: "question-2"})]
      panel.selectedSessionId = "question-1"
      panel.focusComposer()
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Keep this draft"
      keyClick(Qt.Key_0, Qt.MetaModifier | Qt.AltModifier)
      compare(panel.selectedSessionId, "")
      compare(panel.composerFocusId, "")
      keyClick(Qt.Key_Tab, Qt.MetaModifier | Qt.AltModifier)
      tryCompare(panel, "composerFocusId", "question-1")
      compare(composer.text, "Keep this draft")
      keyClick(Qt.Key_Tab, Qt.MetaModifier | Qt.AltModifier)
      tryCompare(panel, "composerFocusId", "question-2")
      keyClick(Qt.Key_Tab, Qt.MetaModifier | Qt.AltModifier)
      compare(panel.selectedSessionId, "")
      panel.sessions = []
      keyClick(Qt.Key_Tab, Qt.MetaModifier | Qt.AltModifier)
      compare(panel.selectedSessionId, "")
      panel.animationsEnabled = false
      panel.sessions = [session([])]
      keyClick(Qt.Key_Tab, Qt.MetaModifier | Qt.AltModifier)
      compare(panel.selectedSessionId, "", "Closed panels do not receive local keys")
    }

    function test_activity_header_stays_fixed_and_collapse_preserves_focus_and_drafts() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session([message("reply", "assistant", "A paragraph of the answer.\n\n".repeat(60))]),
        Object.assign({}, session([]), {id: "question-2"})]
      panel.selectedSessionId = "question-1"
      panel.focusComposer()
      const composer = findChild(panel, "sessionComposer")
      composer.text = "An unfinished follow-up"
      const strip = findChild(panel, "activityStrip")
      const chat = findChild(panel, "sessionView")
      const transcript = findChild(panel, "sessionTranscript")
      tryVerify(function() { return transcript.contentHeight > transcript.height })
      const headerPosition = strip.mapToItem(panel, 0, 0)
      transcript.positionViewAtBeginning()
      const beginning = transcript.contentY
      transcript.positionViewAtEnd()
      verify(transcript.contentY > beginning)
      compare(strip.mapToItem(panel, 0, 0), headerPosition)
      verify(chat.y >= strip.y + strip.height, "The transcript starts below the fixed header")

      const expandedChatHeight = chat.height
      mouseClick(findChild(strip, "toggleActivity"))
      tryCompare(strip, "height", 28)
      verify(chat.height > expandedChatHeight, "Collapsing returns space to the conversation")
      compare(panel.composerFocusId, "question-1")
      compare(composer.text, "An unfinished follow-up")
      panel.selectedSessionId = "question-2"
      compare(strip.collapsed, true)
      panel.showingPrevious = true
      compare(strip.visible, true)
      compare(strip.collapsed, true)
      panel.showingPrevious = false
      panel.selectedSessionId = "question-1"
      compare(composer.text, "An unfinished follow-up")
      mouseClick(findChild(strip, "toggleActivity"))
      tryCompare(strip, "height", 124)
      compare(strip.collapsed, false)
    }
  }
}
