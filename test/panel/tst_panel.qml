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

      status.pauseReason = "media"
      compare(status.title, "Paused for media")
      compare(status.description, "Listening resumes when playback stops.")
      status.pauseReason = "manual"
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
      const activity = findChild(findChild(content, "fullActivityStatus"), "phraseActivity")
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

    function test_compact_activity_tracks_state_and_collapsing_resets_hidden_animation() {
      const content = createTemporaryObject(contentComponent, parent)
      content.showingPrevious = true
      const strip = findChild(content, "activityStrip")
      const status = findChild(strip, "compactActivityStatus")
      const activity = findChild(status, "phraseActivity")
      activity.riseDuration = 30
      activity.resultHoldDuration = 80
      activity.fadeDuration = 40

      content.paused = true
      content.pauseReason = "media"
      compare(findChild(strip, "activityStripTitle").text, "Activity · Paused for media")
      content.paused = false
      content.speaking = true
      compare(status.indicatorColor, "#ef5350")
      content.speaking = false
      content.processing = 1
      compare(status.indicatorColor, "#66bb6a")

      content.history = [{id: "pending", utterance: "Explain the function on screen", outcome: "processing"}]
      compare(activity.phrase, "Explain the function on screen")
      compare(activity.label, "PROCESSING")
      tryCompare(activity, "arrived", true)
      content.history = [{id: "pending", utterance: "Explain the function on screen", intent: "START_CODING_AGENT_SESSION", outcome: "sent"}]
      compare(activity.label, "START_CODING_AGENT_SESSION")
      compare(activity.phraseColor, content.accent)
      tryCompare(activity, "presenting", false)

      const toggle = findChild(strip, "toggleActivity")
      mouseClick(toggle)
      tryCompare(strip, "height", 28)
      compare(activity.active, false)
      content.history = [{id: "hidden", utterance: "A completed hidden phrase", intent: "IGNORE", outcome: "ignored"}]
      mouseClick(toggle)
      tryCompare(strip, "height", 124)
      compare(activity.presenting, false, "Expansion must not replay old results")

      mouseClick(toggle)
      content.history = [{id: "incoming", utterance: "A phrase still processing", outcome: "processing"}]
      mouseClick(toggle)
      compare(activity.phrase, "A phrase still processing")
      compare(activity.presenting, true)
      content.animationsEnabled = false
      compare(activity.presenting, false)
      compare(activity.visibility, 0)
    }
  }
}
