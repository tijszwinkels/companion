import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 640
  height: 800
  Component {
    id: view
    Panel.ActivityView {
      width: 600; height: 760
      online: true; paused: true; speaking: false; processing: 0
      textInputAvailable: true
      foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"
      selection: "#293a51"; fontFamily: "sans-serif"
    }
  }
  TestCase {
    name: "ActivityText"
    when: windowShown
    property var page: null
    SignalSpy { id: submitted; signalName: "utteranceRequested" }
    function init() {
      page = createTemporaryObject(view, parent)
      verify(page !== null)
      submitted.target = page
      submitted.clear()
    }
    function test_input_stays_at_bottom_when_activity_scrolls() {
      const input = findChild(page, "activityTextArea")
      const start = input.y
      compare(input.y + input.height, page.height)
      page.scrollTo(page.contentHeight - page.viewportHeight)
      wait(0)
      compare(input.y, start)
      page.height = 420
      compare(input.y + input.height, page.height)
      verify(page.viewportHeight > 0)
    }
    function test_enter_newline_ack_and_successor_draft() {
      const input = findChild(page, "activityTextInput")
      input.forceActiveFocus()
      input.text = "new session inspect this"
      keyClick(Qt.Key_Return, Qt.ShiftModifier)
      compare(submitted.count, 0)
      verify(input.text.indexOf("\n") >= 0)
      keyClick(Qt.Key_Return)
      compare(submitted.count, 1)
      const original = submitted.signalArguments[0][0]
      compare(input.text, original, "Keep text until admission is acknowledged")
      keyClick(Qt.Key_Return)
      compare(submitted.count, 1, "No duplicate while awaiting confirmation")
      input.text = "next draft"
      page.utteranceSubmitted(original, "")
      compare(input.text, "next draft", "A delayed acknowledgement cannot erase a successor")
      page.submitText()
      page.utteranceSubmitted("next draft", "")
      compare(input.text, "")
    }
    function test_offline_rejection_and_capability_keep_draft() {
      const input = findChild(page, "activityTextInput")
      const send = findChild(page, "activityTextSend")
      input.text = "ignore this"
      page.online = false
      verify(!send.enabled)
      page.submitText()
      compare(submitted.count, 0)
      page.online = true
      page.textInputAvailable = false
      verify(!send.enabled)
      page.textInputAvailable = true
      page.submitText()
      compare(submitted.count, 1)
      page.utteranceSubmitted(input.text, "Queue is full")
      compare(input.text, "ignore this")
      compare(page.inputError, "Queue is full")
      verify(send.enabled)
      // 8000 characters are sent; 8001 are refused locally, kept and unsent.
      const counter = findChild(page, "activityTextCounter")
      input.text = "x".repeat(6999)
      verify(!counter.visible)
      input.text = "x".repeat(8000)
      verify(counter.visible)
      compare(counter.text, "8000 / 8000 characters")
      page.submitText()
      compare(submitted.count, 2)
      compare(submitted.signalArguments[1][0].length, 8000)
      page.utteranceSubmitted(input.text, "")
      compare(input.text, "")
      input.text = "y".repeat(8001)
      page.submitText()
      compare(submitted.count, 2, "An over-long message is never sent")
      compare(page.pendingText, "")
      compare(input.text, "y".repeat(8001), "The over-long draft is kept")
      verify(page.inputError.indexOf("8000") >= 0)
      compare(counter.text, "8001 / 8000 characters")
      // Pressing Enter on it is refused the same way.
      input.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(submitted.count, 2)
      compare(input.text.length, 8001)
    }
  }
}
