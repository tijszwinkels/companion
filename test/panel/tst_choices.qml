import QtQuick
import QtTest
import "../../integrations/panel" as Panel

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
      Rectangle { anchors.fill: parent; z: -1; color: "#111827" }
      selectedSessionId: "first"
      sessions: [{id: "first", title: "Choices", status: "completed", messages: [], error: ""},
        {id: "second", title: "Other", status: "completed", messages: [], error: ""}]
      agentActions: ({sessionId: "first", stopRunId: "", choices: [
        {sessionId: "first", revision: "set-1", index: 0, label: "Tests", description: "Run the tests", available: true, voiceAvailable: true, voiceReason: ""},
        {sessionId: "first", revision: "set-1", index: 1, label: "No", description: "", available: true, voiceAvailable: true, voiceReason: ""},
        {sessionId: "first", revision: "set-1", index: 2, label: "insert", description: "An alternative", available: true, voiceAvailable: false, voiceReason: "This label overlaps a permanent voice shortcut"}
      ]})
    }
  }

  TestCase {
    name: "CompanionAgentChoices"
    when: windowShown

    function test_choices_stay_above_composer_and_clicks_preserve_freeform_drafts() {
      const panel = createTemporaryObject(panelComponent, parent)
      verify(waitForRendering(panel))
      const composer = findChild(panel, "sessionComposer")
      const choices = findChild(panel, "agentChoices")
      verify(choices.mapToItem(panel, 0, choices.height).y <= composer.mapToItem(panel, 0, 0).y)
      composer.text = "A freeform alternative"
      let selected = null
      panel.choiceRequested.connect(function(id, revision, index) { selected = {id: id, revision: revision, index: index} })
      const first = findChild(panel, "agentChoice-0")
      compare(first.voiceActive, true)
      compare(findChild(first, "choiceVoiceLabel").text, "[Tests]")
      mouseClick(first, 20, 15)
      compare(selected.id, "first")
      compare(selected.revision, "set-1")
      compare(selected.index, 0)
      compare(composer.text, "A freeform alternative")
      compare(first.selectable, false)
      compare(findChild(panel, "sendSession").enabled, false)
      panel.choiceSubmitted("first", "set-1", 0, "")
      compare(composer.text, "A freeform alternative")
      compare(findChild(panel, "sendSession").enabled, true)
    }

    function test_voice_highlighting_tracks_pause_offline_collision_and_running_state() {
      const panel = createTemporaryObject(panelComponent, parent)
      verify(waitForRendering(panel))
      const first = findChild(panel, "agentChoice-0")
      const collision = findChild(panel, "agentChoice-2")
      compare(collision.voiceActive, false)
      compare(collision.selectable, true)
      verify(collision.hint.includes("permanent"))
      panel.paused = true
      compare(first.voiceActive, false)
      compare(first.selectable, true)
      panel.paused = false
      panel.online = false
      compare(first.voiceActive, false)
      compare(first.selectable, false)
      panel.online = true
      const pending = Object.assign({}, panel.agentActions.choices[0], {available: false, voiceAvailable: false, voiceReason: "Available when the agent finishes"})
      panel.agentActions = {sessionId: "first", stopRunId: "run-1", choices: [pending]}
      compare(findChild(panel, "agentChoice-0").selectable, false)
      const stop = findChild(panel, "stopVoiceChoice")
      compare(stop.visible, true)
      let stopped = null
      panel.stopRunRequested.connect(function(id, runId) { stopped = {id: id, runId: runId} })
      verify(waitForRendering(panel))
      mouseClick(stop, 10, 10)
      compare(stopped.id, "first")
      compare(stopped.runId, "run-1")
    }

    function test_switching_tabs_replacement_and_errors_cannot_reuse_the_old_choice() {
      const panel = createTemporaryObject(panelComponent, parent)
      verify(waitForRendering(panel))
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Keep my draft"
      mouseClick(findChild(panel, "agentChoice-0"), 10, 10)
      panel.selectedSessionId = "second"
      compare(findChild(panel, "agentChoices").visible, false)
      composer.text = "Other draft"
      panel.choiceSubmitted("first", "set-1", 0, "Expired")
      compare(findChild(panel, "sessionView").inputError, "")
      compare(composer.text, "Other draft")
      panel.selectedSessionId = "first"
      compare(composer.text, "Keep my draft")
      const replacement = Object.assign({}, panel.agentActions.choices[1], {revision: "set-2"})
      panel.agentActions = {sessionId: "first", stopRunId: "", choices: [replacement]}
      let revision = ""
      panel.choiceRequested.connect(function(id, value, index) { revision = value })
      mouseClick(findChild(panel, "agentChoice-1"), 10, 10)
      compare(revision, "set-2")
      panel.choiceSubmitted("first", "set-2", 1, "Expired")
      compare(findChild(panel, "sessionView").inputError, "Expired")
      compare(composer.text, "Keep my draft")
      panel.agentActions = {sessionId: "first", stopRunId: "", choices: []}
      compare(findChild(panel, "agentChoices").visible, false)
    }

    function test_eight_long_options_are_bounded_on_a_small_panel() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.width = 390
      panel.height = 660
      const choices = []
      for (let index = 0; index < 8; index++) choices.push({sessionId: "first", revision: "many", index: index,
        label: "Long choice label " + index, description: "A detailed alternative with enough text to wrap across several lines on a narrow panel.", available: true, voiceAvailable: true, voiceReason: ""})
      panel.agentActions = {sessionId: "first", stopRunId: "", choices: choices}
      verify(waitForRendering(panel))
      const options = findChild(panel, "agentChoices")
      verify(options.height <= 180)
      const composer = findChild(panel, "sessionComposer")
      verify(composer.mapToItem(panel, 0, 0).y > 0)
      verify(composer.mapToItem(panel, 0, composer.height).y <= panel.height)
      grabImage(panel).save("/tmp/companion-agent-choices-preview.png")
    }
  }
}
