import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 600
  height: 900
  Component {
    id: chatComponent
    Panel.SessionView {
      width: 540
      height: 850
      foreground: "#dce5ef"
      muted: "#8ba0b8"
      accent: "#9fc0f7"
      selection: "#293a51"
      fontFamily: "sans-serif"
      session: null
    }
  }

  function conversation(extra) {
    return {id: "scrolling", title: "Long answer", status: "running", error: "", messages: [
      {id: "answer", kind: "assistant", text: "A paragraph in a long answer.\n\n".repeat(120) + (extra || ""),
        input: "", toolName: "", screenshot: false, state: "streaming"}
    ]}
  }

  TestCase {
    name: "CompanionConversationScrolling"
    when: windowShown

    function test_wheel_over_message_moves_a_useful_distance_and_stops_at_bounds() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation()
      const transcript = findChild(chat, "sessionTranscript")
      tryVerify(function() { return transcript.contentHeight > transcript.height })
      chat.followEnd = false
      transcript.positionViewAtBeginning()
      const beginning = transcript.contentY
      mouseWheel(transcript, 100, 100, 0, -120, Qt.NoButton)
      tryVerify(function() { return transcript.contentY > beginning })
      tryCompare(transcript, "moving", false)
      verify(transcript.contentY - beginning >= 120,
        "A wheel notch should move at least 120 pixels; moved " + (transcript.contentY - beginning))
      compare(chat.followEnd, false)

      mouseWheel(transcript, 100, 100, 0, 12000, Qt.NoButton)
      tryCompare(transcript, "atYBeginning", true)
      compare(transcript.contentY, transcript.originY)
      mouseWheel(transcript, 100, 100, 0, -12000, Qt.NoButton)
      tryCompare(transcript, "atYEnd", true)
      compare(chat.followEnd, true)
    }

    function test_wheel_preserves_selection_and_reading_position_survives_streaming() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation()
      const transcript = findChild(chat, "sessionTranscript")
      const composer = findChild(chat, "sessionComposer")
      tryVerify(function() { return transcript.contentHeight > transcript.height })
      tryCompare(transcript, "atYEnd", true)
      const body = findChild(findChild(chat, "bubble-answer"), "messageText")
      body.select(0, 11)
      const selection = body.selectedText
      composer.text = "An unsent draft"
      chat.focusComposer()
      mouseWheel(transcript, 100, 100, 0, 120, Qt.NoButton)
      compare(chat.followEnd, false, "Stop following as soon as the reader scrolls up")
      compare(body.selectedText, selection, "Wheel scrolling keeps the text selection")
      const readingPosition = transcript.contentY
      chat.session = conversation("Another streamed paragraph.\n\n".repeat(10))
      wait(30)
      compare(transcript.contentY, readingPosition)
      compare(composer.text, "An unsent draft")
      compare(composer.activeFocus, true)

      mouseWheel(transcript, 100, 100, 0, -12000, Qt.NoButton)
      tryCompare(transcript, "atYEnd", true)
      chat.session = conversation("The stream continues.\n\n".repeat(30))
      tryCompare(transcript, "atYEnd", true)
      compare(chat.followEnd, true)
    }
  }
}
