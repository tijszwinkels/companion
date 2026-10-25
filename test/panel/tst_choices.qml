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

    // Per-view controls from `agent-view-actions`, as the listener sends them:
    // own choices, no voice claims, unavailable reasons only when unavailable.
    function viewActions() {
      return {
        first: {sessionId: "first", stopRunId: "", choices: [
          {sessionId: "first", revision: "set-1", index: 0, label: "Tests", description: "Run the tests", available: true, voiceAvailable: false, voiceReason: ""},
          {sessionId: "first", revision: "set-1", index: 1, label: "No", description: "", available: true, voiceAvailable: false, voiceReason: ""}
        ]},
        second: {sessionId: "second", stopRunId: "run-2", choices: [
          {sessionId: "second", revision: "set-9", index: 0, label: "Later", description: "", available: false, voiceAvailable: false, voiceReason: "Available when the agent finishes"}
        ]}
      }
    }
    function voiceFor(id, revision) {
      return {sessionId: id, stopRunId: "", choices: [
        {sessionId: id, revision: revision, index: 0, label: "Tests", description: "Run the tests", available: true, voiceAvailable: true, voiceReason: ""}
      ]}
    }

    function test_a_view_keeps_its_own_choices_when_voice_goes_elsewhere() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.viewAgentActions = viewActions()
      // Speech goes to another conversation (for example an active window).
      panel.agentActions = voiceFor("second", "set-9")
      verify(waitForRendering(panel))
      const choices = findChild(panel, "agentChoices")
      compare(choices.visible, true)
      const first = findChild(panel, "agentChoice-0")
      compare(first.selectable, true)
      compare(first.voiceActive, false)
      compare(first.hint, "Click to select; voice goes elsewhere")
      compare(findChild(panel, "voiceTargetStatus").text, "Voice: another conversation")

      // Clicking still submits this conversation's own stored identity.
      let selected = null
      panel.choiceRequested.connect(function(id, revision, index) { selected = {id: id, revision: revision, index: index} })
      mouseClick(first, 20, 15)
      compare(selected, {id: "first", revision: "set-1", index: 0})
      panel.choiceSubmitted("first", "set-1", 0, "")

      // Pausing stops listening everywhere: a non-target view says so too.
      panel.paused = true
      compare(findChild(panel, "voiceTargetStatus").text, "Voice paused")
      compare(findChild(panel, "agentChoice-0").hint, "Click to select; voice listening is paused")
      compare(findChild(panel, "agentChoice-0").selectable, true)
      panel.paused = false

      // No voice target at all (none or ambiguous): still clickable.
      panel.agentActions = ({})
      compare(findChild(panel, "voiceTargetStatus").text, "Voice: no conversation")
      compare(findChild(panel, "agentChoice-0").selectable, true)
      compare(findChild(panel, "agentChoice-0").hint, "Click to select; voice goes elsewhere")
      panel.paused = true
      compare(findChild(panel, "voiceTargetStatus").text, "Voice paused")
      compare(findChild(panel, "agentChoice-0").hint, "Click to select; voice listening is paused")
      panel.paused = false

      // An empty projection means this connection shows no conversation:
      // nothing is displayed, even if voice names this conversation.
      panel.viewAgentActions = ({})
      panel.agentActions = voiceFor("first", "set-1")
      compare(choices.visible, false)
    }

    function test_voice_hints_need_the_same_conversation_revision_and_index() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.viewAgentActions = viewActions()
      panel.agentActions = voiceFor("first", "set-1")
      verify(waitForRendering(panel))
      compare(findChild(panel, "voiceTargetStatus").text, "Voice: this conversation")
      const first = findChild(panel, "agentChoice-0")
      const second = findChild(panel, "agentChoice-1")
      compare(first.voiceActive, true)
      compare(first.hint, "Say “Tests” to select")
      // The voice projection has no entry for index 1: not called speakable.
      compare(second.voiceActive, false)
      compare(second.hint, "Click to select")

      // An older or newer voice set never annotates this view's choices.
      panel.agentActions = voiceFor("first", "set-0")
      compare(findChild(panel, "agentChoice-0").voiceActive, false)
      compare(findChild(panel, "agentChoice-0").hint, "Click to select")

      // Paused listening is never shown as listening.
      panel.agentActions = voiceFor("first", "set-1")
      panel.paused = true
      compare(findChild(panel, "voiceTargetStatus").text, "Voice paused")
      compare(findChild(panel, "agentChoice-0").voiceActive, false)
      compare(findChild(panel, "agentChoice-0").selectable, true)
      compare(findChild(panel, "agentChoice-0").hint, "Click to select; voice listening is paused")
      panel.paused = false

      // Offline: no status line; the choices say so themselves.
      panel.online = false
      compare(findChild(panel, "voiceTargetStatus").visible, false)
      compare(findChild(panel, "agentChoice-0").hint, "Disconnected")
    }

    function test_a_non_target_view_keeps_its_own_run_stop_and_busy_reason() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [{id: "first", title: "Choices", status: "completed", messages: [], error: ""},
        {id: "second", title: "Other", status: "running", messages: [], error: ""}]
      panel.viewAgentActions = viewActions()
      panel.agentActions = voiceFor("first", "set-1")
      panel.selectedSessionId = "second"
      verify(waitForRendering(panel))
      const later = findChild(panel, "agentChoice-0")
      compare(later.selectable, false)
      compare(later.hint, "Available when the agent finishes")
      // An unavailable choice keeps its reason while paused.
      panel.paused = true
      compare(later.hint, "Available when the agent finishes")
      compare(findChild(panel, "voiceTargetStatus").text, "Voice paused")
      panel.paused = false
      const stop = findChild(panel, "stopVoiceChoice")
      compare(stop.visible, true)
      // Not the voice target: the run-scoped stop is not highlighted as speakable.
      compare(Qt.colorEqual(stop.foreground, panel.muted), true)
      compare(findChild(panel, "stopSession").visible, false, "One stop control")
      let stopped = null
      panel.stopRunRequested.connect(function(id, runId) { stopped = {id: id, runId: runId} })
      mouseClick(stop, 10, 10)
      compare(stopped, {id: "second", runId: "run-2"})

      // Its run ended: the ordinary conversation Stop returns if still running.
      const ended = viewActions()
      ended.second.stopRunId = ""
      panel.viewAgentActions = ended
      compare(findChild(panel, "stopVoiceChoice").visible, false)
      compare(findChild(panel, "stopSession").visible, true)
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
