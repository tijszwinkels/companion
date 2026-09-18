import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 420
  height: 800

  Component {
    id: statusComponent
    Panel.StatusView {
      width: 300
      height: 500
      online: true
      paused: false
      speaking: false
      processing: 0
      foreground: "white"
      muted: "gray"
      accent: "cyan"
      fontFamily: "sans-serif"
      unit: 1
    }
  }

  Component {
    id: contentComponent
    Panel.PanelContent {
      width: 420
      height: 400
      online: true
      paused: false
      speaking: false
      processing: 0
      foreground: "white"
      muted: "gray"
      accent: "cyan"
      selection: "#333333"
      fontFamily: "sans-serif"
    }
  }

  TestCase {
    name: "CompanionPanel"
    when: windowShown

    function test_application_lifecycle() {
      const status = createTemporaryObject(statusComponent, parent)
      verify(status !== null)
      compare(status.title, "Listening")

      status.processing = 1
      compare(status.title, "Listening")
      compare(status.indicatorColor, "#66bb6a")

      // A new utterance may overlap the previous request. It must be visible.
      status.speaking = true
      compare(status.title, "Listening")
      compare(status.indicatorColor, "#ef5350")

      status.paused = true
      compare(status.title, "Paused")

      status.online = false
      compare(status.title, "Not running")

      status.paused = false
      status.speaking = false
      status.processing = 0
      status.online = true
      compare(status.title, "Listening")
    }

    function test_close_button() {
      const content = createTemporaryObject(contentComponent, parent)
      verify(content !== null)

      let requested = false
      content.closeRequested.connect(function() { requested = true })
      mouseClick(findChild(content, "closeButton"))
      verify(requested)
    }

    function test_history_reaches_activity_and_stops_when_hidden() {
      const content = createTemporaryObject(contentComponent, parent)
      const activity = findChild(content, "phraseActivity")
      content.history = [{id: "first", utterance: "An incoming phrase", intent: null, outcome: "processing"}]
      compare(activity.phrase, "An incoming phrase")
      compare(activity.presenting, true)

      content.animationsEnabled = false
      compare(activity.presenting, false)
      compare(activity.visibility, 0)
      content.history = [{id: "first", utterance: "An incoming phrase", intent: "IGNORE", outcome: "ignored"}]
      content.animationsEnabled = true
      compare(activity.presenting, false)
    }
  }
}
