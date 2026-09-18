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
      fontFamily: "sans-serif"
      unit: 1
    }
  }

  Component {
    id: contentComponent
    Panel.PanelContent {
      width: 420
      height: 800
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
      compare(status.title, "Processing")

      // A new utterance may overlap the previous request. It must be visible.
      status.speaking = true
      compare(status.title, "Hearing you")

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
  }
}
