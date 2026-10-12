import QtQuick
import QtTest

// The installed Omarchy bar indicator, with stub shell modules (test/omarchy/stubs)
// and a synthetic Companion service. Run:
//   QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -import test/omarchy/stubs -input test/omarchy
// This checks the indicator's state logic, not live Quickshell rendering.
Item {
  id: host
  width: 200
  height: 40

  QtObject {
    id: companion
    property bool online: true
    property bool paused: false
    property string pauseReason: ""
    property bool speaking: false
    property int processing: 0
    property string lastError: ""
    property bool soundsAvailable: true
    property bool soundsEnabled: true
    property var recording: null
    property int toggles: 0
    function togglePause() { toggles++ }
    function toggleSounds() {}
  }
  QtObject {
    id: bar
    property color barForeground: "#dddddd"
    property var shell: QtObject { function serviceFor(name) { return name === "companion.desktop" ? companion : null } }
  }

  Loader {
    id: loader
    source: "../../integrations/omarchy/plugin/BarWidget.qml"
    onLoaded: item.bar = bar
  }

  TestCase {
    name: "OmarchyBarRecordingIndicator"
    when: loader.status === Loader.Ready

    function init() {
      companion.online = true
      companion.paused = false
      companion.pauseReason = ""
      companion.speaking = false
      companion.processing = 0
      companion.lastError = ""
      companion.recording = null
      companion.toggles = 0
    }

    function button() { return findChild(loader.item, "barButton") }
    function listeningToggle() {
      const toggles = []
      const visit = item => {
        for (const child of item.children) {
          if (child.label === "Listening") toggles.push(child)
          visit(child)
        }
      }
      visit(loader.item)
      return toggles[0]
    }

    function recording(state, capturing) {
      return {recordingId: "rec", sessionId: "conversation", state: state, capturing: capturing}
    }

    function test_paused_without_recording_shows_paused() {
      companion.paused = true
      companion.pauseReason = "manual"
      compare(button().text, "󰍭")
      verify(button().tooltipText.indexOf("Paused") >= 0)
      compare(listeningToggle().description, "Paused")
      compare(listeningToggle().checked, false)
    }

    function test_recording_while_paused_shows_the_live_microphone_and_keeps_the_pause() {
      companion.paused = true
      companion.pauseReason = "media"
      for (const state of ["starting", "recording", "finishing"]) {
        // Capture (including start and the moment before the recorder exits) is shown.
        companion.recording = recording(state, true)
        compare(button().text, "󰍬", state)
        compare(String(button().foreground), "#ef5350")
        verify(button().tooltipText.indexOf("Microphone on") >= 0)
        verify(button().tooltipText.indexOf("Recording into a text box") >= 0)
        verify(button().tooltipText.indexOf("paused for media") >= 0)
        compare(listeningToggle().checked, false, "The pause choice is unchanged")
        verify(listeningToggle().description.indexOf("Recording into a text box") >= 0)
      }
      // A click still only toggles listening.
      listeningToggle().clicked()
      compare(companion.toggles, 1)
    }

    function test_finishing_transcription_returns_to_the_actual_listening_state() {
      companion.paused = true
      companion.pauseReason = "manual"
      companion.recording = recording("finishing", false)
      compare(button().text, "󰍭")
      verify(button().tooltipText.indexOf("Recording") < 0)
      compare(listeningToggle().description, "Paused")

      companion.paused = false
      companion.processing = 1
      compare(button().text, "󰍬")
      verify(button().tooltipText.indexOf("processing") >= 0)

      companion.recording = null
      companion.processing = 0
      verify(button().tooltipText.indexOf("listening") >= 0)
    }

    function test_recording_from_listening_and_precedence() {
      companion.recording = recording("recording", true)
      companion.lastError = "Some earlier error"
      companion.speaking = true
      verify(button().tooltipText.indexOf("Recording into a text box") >= 0)
      verify(button().tooltipText.indexOf("Listening") < 0, "No pause mentioned while listening is on")
      compare(listeningToggle().checked, true)

      // Disconnected: nothing claims recording.
      companion.online = false
      compare(button().tooltipText, "Companion is not running")
      compare(button().text, "󰍭")
    }
  }
}
