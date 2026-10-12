import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// Defaults for new coding sessions in Activity's "Start a coding session"
// card. The listener is replaced by direct replies to the recorded requests;
// no configuration file, Pi discovery or desktop is involved.
Item {
  width: 600
  height: 1200
  Component {
    id: stateComponent
    Panel.AgentSessionState { controlsAvailable: true }
  }
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 600
      height: 1200
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

  function intent(name, label, prefix) {
    return {name: name, label: label, enabled: true, toggleable: true, supportsInference: name === "START_CODING_AGENT_SESSION",
      inferenceEnabled: true, shortcutEnabled: true, inferenceAvailable: true, prefixes: [prefix], prefixAvailable: true}
  }

  TestCase {
    name: "CompanionCodingDefaults"
    when: windowShown

    property var requests: []

    function open() {
      requests = []
      const state = createTemporaryObject(stateComponent, parent)
      state.controlRequested.connect(function(request) { requests.push(request) })
      const panel = createTemporaryObject(panelComponent, parent, {sessionControls: state})
      panel.intents = [
        intent("START_CODING_AGENT_SESSION", "Start a coding session", "new session"),
        intent("START_PI_SESSION", "Start a Pi session", "new pi session")
      ]
      verify(waitForRendering(panel))
      return {state: state, panel: panel}
    }

    function sent(action) { return requests.filter(function(request) { return request.action === action }) }

    function reply(state, action, result) { state.controlReceived({type: "result", action: action, result: result}) }

    function piCatalog() {
      return {models: ["configured/one", "configured/two", "configured/unpinned"], pinned: ["configured/one", "configured/two"], thinkingLevels: {}}
    }

    function test_only_the_coding_session_card_shows_the_defaults() {
      const setup = open()
      verify(findChild(findChild(setup.panel, "activity-START_CODING_AGENT_SESSION"), "codingDefaultHarness") !== null)
      compare(findChild(findChild(setup.panel, "activity-START_PI_SESSION"), "codingDefaultHarness"), null)
    }

    function test_choices_follow_the_saved_defaults_and_send_their_revision() {
      const setup = open()
      const harness = findChild(setup.panel, "codingDefaultHarness")
      const model = findChild(setup.panel, "codingDefaultModel")
      const status = findChild(setup.panel, "codingDefaultsStatus")

      // Visible Activity reads the defaults; nothing is chosen before they arrive.
      tryVerify(function() { return sent("coding-defaults").length === 1 })
      verify(!harness.enabled)
      reply(setup.state, "coding-defaults", {harness: "pi", piModel: "configured/one", claudeModel: "claude-opus-5-5", revision: "r1"})
      // Only Pi's catalogue is needed for a Pi default.
      tryVerify(function() { return sent("agent-models").length === 1 })
      compare(sent("claude-models").length, 0)
      verify(!model.enabled, "No model list before the catalogue arrives")
      reply(setup.state, "agent-models", piCatalog())
      compare(harness.displayText, "Pi")
      compare(model.displayText, "configured/one")
      verify(harness.enabled)
      verify(model.enabled)

      // Choosing Claude Code sends only the backend, then waits for the save.
      harness.forceActiveFocus()
      keyClick(Qt.Key_Down)
      const backend = sent("set-coding-defaults")
      compare(backend.length, 1)
      compare(backend[0].harness, "claude-code")
      compare(backend[0].revision, "r1")
      compare(backend[0].model, undefined)
      compare(harness.displayText, "Pi", "Nothing changes before the listener saves it")
      verify(!harness.enabled)
      verify(!model.enabled)
      compare(status.text, "Saving…")

      reply(setup.state, "set-coding-defaults", {harness: "claude-code", piModel: "configured/one", claudeModel: "claude-opus-5-5", revision: "r2"})
      compare(harness.displayText, "Claude Code")
      compare(model.displayText, "claude-opus-5-5")
      tryVerify(function() { return sent("claude-models").length === 1 })
      reply(setup.state, "claude-models", {models: ["claude-opus-5-5", "claude-sonnet-5"], model: "claude-opus-5-5"})
      verify(model.enabled)

      // A model choice names its backend and the latest revision.
      model.forceActiveFocus()
      keyClick(Qt.Key_Down)
      const choice = sent("set-coding-defaults")[1]
      compare(choice.harness, "claude-code")
      compare(choice.model, "claude-sonnet-5")
      compare(choice.revision, "r2")
      compare(model.displayText, "claude-opus-5-5")

      // A refusal stays visible, the saved value stays shown and the
      // defaults are read again in case the file changed.
      const refusal = "companion-agent.json changed outside this panel. Check the refreshed defaults and choose again."
      setup.state.controlReceived({type: "error", action: "set-coding-defaults", message: refusal})
      compare(model.displayText, "claude-opus-5-5")
      compare(status.text, refusal)
      compare(sent("coding-defaults").length, 2)
      reply(setup.state, "coding-defaults", {harness: "claude-code", piModel: "configured/one", claudeModel: "claude-sonnet-5", revision: "r3"})
      compare(status.text, refusal, "The refusal explains why the shown value changed")
      compare(model.displayText, "claude-sonnet-5")

      // Choosing the value already saved sends nothing.
      model.currentIndex = 1
      model.activated(1)
      compare(sent("set-coding-defaults").length, 2)
    }

    function test_saved_pi_default_is_always_listed_and_marked_when_unavailable() {
      const setup = open()
      const model = findChild(setup.panel, "codingDefaultModel")
      tryVerify(function() { return sent("coding-defaults").length === 1 })
      reply(setup.state, "coding-defaults", {harness: "pi", piModel: "configured/unpinned", claudeModel: "claude-opus-5-5", revision: "r1"})
      reply(setup.state, "agent-models", piCatalog())
      compare(model.displayText, "configured/unpinned")
      compare(model.count, 3)

      reply(setup.state, "coding-defaults", {harness: "pi", piModel: "retired/model", claudeModel: "claude-opus-5-5", revision: "r2"})
      compare(model.displayText, "retired/model (unavailable)")
    }

    function test_disconnected_or_unloaded_defaults_cannot_be_changed() {
      const setup = open()
      const harness = findChild(setup.panel, "codingDefaultHarness")
      tryVerify(function() { return sent("coding-defaults").length === 1 })
      setup.state.controlReceived({type: "error", action: "coding-defaults", message: "companion-agent.json: unsupported thinking level"})
      compare(findChild(setup.panel, "codingDefaultsStatus").text, "companion-agent.json: unsupported thinking level")
      verify(!harness.enabled)

      reply(setup.state, "coding-defaults", {harness: "pi", piModel: "configured/one", claudeModel: "claude-opus-5-5", revision: "r1"})
      verify(harness.enabled)
      setup.panel.online = false
      verify(!harness.enabled)
      setup.panel.online = true
      setup.state.disconnectControls()
      verify(!harness.enabled)
      setup.state.setCodingDefaults("claude-code", "")
      compare(sent("set-coding-defaults").length, 0)
    }
  }
}
