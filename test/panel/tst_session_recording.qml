import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// Manual recording into a conversation's text box: the Record toggle, its
// gating of Send/Close, and appends to the draft. The listener's answers are
// scripted; no microphone, socket or model is involved.
Item {
  width: 600
  height: 900
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
      recordingAvailable: true
    }
  }

  function conversation(id, title) {
    return {id: id, title: title, status: "completed", model: "fixture", error: "",
      messages: [{id: id + "-answer", kind: "assistant", text: "Answer", toolName: "", input: "", state: "done", screenshot: false}]}
  }
  function append(id, recordingId, sequence, text) {
    return {requestId: "append-" + sequence, recordingId: recordingId, id: id, sequence: sequence, text: text}
  }

  TestCase {
    name: "CompanionSessionRecording"
    when: windowShown

    function openPanel() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [conversation("visible", "Visible"), conversation("other", "Other")]
      panel.selectedSessionId = "visible"
      verify(waitForRendering(panel))
      return panel
    }

    // Click Record and confirm it like the listener would.
    function startRecording(panel, recordingId) {
      const requests = []
      panel.recordRequested.connect(function(id, length) { requests.push({id: id, length: length}) })
      mouseClick(findChild(panel, "recordSession"))
      compare(requests.length, 1)
      panel.recordingStarted("visible", recordingId, "")
      panel.recording = {recordingId: recordingId, sessionId: "visible", state: "recording"}
      return requests[0]
    }

    function test_record_toggle_appends_literal_text_and_never_sends() {
      const panel = openPanel()
      const sent = []
      panel.sendSessionRequested.connect(function(id, text) { sent.push(text) })
      const composer = findChild(panel, "sessionComposer")
      const record = findChild(panel, "recordSession")
      const send = findChild(panel, "sendSession")
      const close = findChild(panel, "dismissSession")
      composer.text = "My notes."

      verify(record.visible)
      compare(record.text, "Record")
      verify(record.enabled)
      const request = startRecording(panel, "rec-1")
      compare(request.id, "visible")
      compare(request.length, 9)
      compare(record.text, "Stop recording")
      verify(!send.enabled, "Send waits for recording")
      verify(!close.enabled, "Close waits for recording")

      // Chunks are appended after existing text, with one separating space.
      let result = panel.appendRecording(append("visible", "rec-1", 1, "Send it now."))
      compare(result.outcome, "appended")
      compare(composer.text, "My notes. Send it now.")
      compare(result.length, composer.text.length)

      // The user may edit while recording; later chunks follow those edits.
      composer.text = composer.text + " Edited\n"
      result = panel.appendRecording(append("visible", "rec-1", 2, "close session"))
      compare(composer.text, "My notes. Send it now. Edited\nclose session")
      compare(result.length, composer.text.length)
      keyClick(Qt.Key_Return)
      compare(sent.length, 0, "Recorded or command-shaped text never sends")

      // Stop recording → Finishing transcription… → done.
      const stops = []
      panel.stopRecordingRequested.connect(function(id) { stops.push(id) })
      mouseClick(record)
      compare(stops, ["visible"])
      panel.recordingStopAnswered("")
      panel.recording = {recordingId: "rec-1", sessionId: "visible", state: "finishing"}
      compare(record.text, "Finishing transcription…")
      verify(!record.enabled)
      verify(!send.enabled)
      panel.appendRecording(append("visible", "rec-1", 3, "final words"))
      panel.recordingFinished({recordingId: "rec-1", id: "visible", reason: "stopped", complete: true, message: ""})
      panel.recording = null
      compare(record.text, "Record")
      verify(send.enabled)
      verify(close.enabled)
      compare(composer.text, "My notes. Send it now. Edited\nclose session final words")
      verify(!findChild(panel, "recordingNotice").visible)
    }

    function test_appends_reach_the_original_draft_after_switching_tabs() {
      const panel = openPanel()
      const composer = findChild(panel, "sessionComposer")
      startRecording(panel, "rec-2")
      panel.appendRecording(append("visible", "rec-2", 1, "first"))

      panel.selectedSessionId = "other"
      verify(waitForRendering(panel))
      compare(composer.text, "")
      const record = findChild(panel, "recordSession")
      verify(!record.enabled, "No second recording while the first finishes")

      const result = panel.appendRecording(append("visible", "rec-2", 2, "tail"))
      compare(result.outcome, "appended")
      compare(result.length, "first tail".length)
      compare(composer.text, "", "Never written into the newly selected tab")
      panel.recordingFinished({recordingId: "rec-2", id: "visible", reason: "navigation", complete: true,
        message: "Recording stopped because you left this conversation."})
      panel.recording = null

      panel.selectedSessionId = "visible"
      verify(waitForRendering(panel))
      compare(composer.text, "first tail")
      const notice = findChild(panel, "recordingNotice")
      verify(notice.visible)
      verify(notice.text.indexOf("left this conversation") >= 0)
    }

    function test_foreign_or_stale_appends_are_refused() {
      const panel = openPanel()
      const composer = findChild(panel, "sessionComposer")
      compare(panel.appendRecording(append("visible", "rec-x", 1, "nope")).outcome, "unavailable")
      startRecording(panel, "rec-3")
      compare(panel.appendRecording(append("visible", "other-recording", 1, "nope")).outcome, "unavailable")
      compare(panel.appendRecording(append("other", "rec-3", 1, "nope")).outcome, "unavailable")
      compare(panel.appendRecording(append("closed", "rec-3", 1, "nope")).outcome, "unavailable")
      compare(composer.text, "")
    }

    function test_8000_character_boundaries() {
      const panel = openPanel()
      const composer = findChild(panel, "sessionComposer")
      const record = findChild(panel, "recordSession")
      const send = findChild(panel, "sendSession")

      composer.text = "x".repeat(8000)
      verify(!record.enabled, "Record is refused at the limit")
      composer.text = "x".repeat(7999)
      verify(record.enabled)

      // A chunk that crosses the limit is kept whole; Send then refuses.
      startRecording(panel, "rec-4")
      const result = panel.appendRecording(append("visible", "rec-4", 1, "twelve chars"))
      compare(result.length, 8012)
      compare(composer.text.length, 8012)
      panel.recordingFinished({recordingId: "rec-4", id: "visible", reason: "limit", complete: true,
        message: "Recording stopped at 8000 characters. Shorten the text before sending."})
      panel.recording = null
      verify(!send.enabled)
      verify(findChild(panel, "recordingNotice").visible)
      verify(!record.enabled)

      composer.text = "y".repeat(8001)
      verify(!send.enabled)
      composer.text = "y".repeat(8000)
      verify(send.enabled, "8000 is accepted once recording has finished")
    }

    function test_refusal_disconnect_and_another_panels_recording() {
      const panel = openPanel()
      const record = findChild(panel, "recordSession")
      const send = findChild(panel, "sendSession")
      findChild(panel, "sessionComposer").text = "Draft"

      // A refused start leaves everything as it was and shows the reason.
      mouseClick(record)
      panel.recordingStarted("visible", "", "Open this conversation to record into its text box")
      compare(record.text, "Record")
      verify(record.enabled)

      // Disconnecting while recording explains that words may be missing.
      startRecording(panel, "rec-5")
      panel.recordingDisconnected()
      panel.recording = null
      compare(record.text, "Record")
      verify(findChild(panel, "recordingNotice").text.indexOf("may be missing") >= 0)

      // Another panel recording into this conversation blocks Send and Record here.
      panel.recording = {recordingId: "elsewhere", sessionId: "visible", state: "recording"}
      verify(!send.enabled)
      verify(!record.enabled)
      compare(record.text, "Record")
      panel.recording = null
      verify(send.enabled)

      // Without listener support the button is hidden.
      panel.recordingAvailable = false
      verify(!record.visible)
    }

    function test_an_early_finish_before_the_start_answer_does_not_strand_the_composer() {
      const panel = openPanel()
      const record = findChild(panel, "recordSession")
      const send = findChild(panel, "sendSession")
      const close = findChild(panel, "dismissSession")
      findChild(panel, "sessionComposer").text = "Draft"

      mouseClick(record)
      // The listener ended the recording (a quick tab change) before its
      // answer to Record arrived on the same connection.
      panel.recordingFinished({recordingId: "rec-6", id: "visible", reason: "navigation", complete: true,
        message: "Recording stopped because you left this conversation. The recorded text was added here."})
      panel.recordingStarted("visible", "rec-6", "")
      compare(record.text, "Record")
      verify(record.enabled)
      verify(send.enabled)
      verify(close.enabled)
      verify(findChild(panel, "recordingNotice").text.indexOf("left this conversation") >= 0)
    }

    function test_a_missed_end_is_recovered_by_the_stop_answer() {
      const panel = openPanel()
      const record = findChild(panel, "recordSession")
      findChild(panel, "sessionComposer").text = "Draft"
      startRecording(panel, "rec-7")
      panel.recording = null
      mouseClick(record)
      panel.recordingStopAnswered("This conversation is not recording in this panel")
      compare(record.text, "Record")
      verify(findChild(panel, "sendSession").enabled)
      verify(findChild(panel, "recordingNotice").text.indexOf("already ended") >= 0)

      // While the listener still shows the recording, a Stop error is only shown.
      startRecording(panel, "rec-8")
      mouseClick(record)
      panel.recordingStopAnswered("Companion is disconnected.")
      compare(record.text, "Stop recording")
    }

    function test_incomplete_results_always_warn() {
      const panel = openPanel()
      startRecording(panel, "rec-9")
      panel.recordingFinished({recordingId: "rec-9", id: "visible", reason: "stopped", complete: false, message: ""})
      panel.recording = null
      const notice = findChild(panel, "recordingNotice")
      verify(notice.visible)
      verify(notice.text.indexOf("may be missing") >= 0)
    }
  }
}
