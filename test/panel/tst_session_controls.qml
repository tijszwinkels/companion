import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 800
  height: 900
  Component {
    id: fixture
    Item {
      id: setup
      width: 800
      height: 900
      property alias panel: panel
      property alias state: state
      property var requests: []
      property bool answerModels: true
      property bool initiallySelected: true
      property bool controlsEnabled: true
      property var availableCatalog: ({models: ["configured/alternate"], coding: "configured/coding", quickQuestion: "configured/local"})
      Panel.AgentSessionState {
        id: state
        controlsAvailable: setup.controlsEnabled
        panelVisible: true
        orderRevision: "order-1"
        onControlRequested: request => {
          setup.requests = setup.requests.concat([request])
          if (request.action === "agent-models") {
            if (setup.answerModels) controlReceived({type: "result", action: request.action, result: setup.availableCatalog})
          } else if (request.action === "move-agent") {
            const ids = sessions.map(entry => entry.id).filter(id => id !== request.id)
            ids.splice(request.beforeId ? ids.indexOf(request.beforeId) : ids.length, 0, request.id)
            controlReceived({type: "agent-order", ids: ids, revision: orderRevision + "-next"})
          } else if (request.action === "set-agent-thinking") {
            const session = sessions.find(entry => entry.id === request.id)
            update(Object.assign({}, session, {thinkingOverride: request.thinking, messages: []}))
          } else if (request.action === "set-agent-model") {
            const session = sessions.find(entry => entry.id === request.id)
            update(Object.assign({}, session, {modelOverride: request.model, messages: []}))
          }
        }
      }
      Panel.PanelContent {
        id: panel
        anchors.fill: parent
        online: true
        paused: false
        speaking: false
        processing: 0
        foreground: "#e0e6f0"
        muted: "#959faa"
        accent: "#82aaff"
        selection: "#283348"
        fontFamily: "sans-serif"
        sessions: state.sessions
        selectedSessionId: state.selectedId
        showingPrevious: state.showingPrevious
        sessionControls: state
        onSessionSelected: id => state.select(id)
        onPreviousRequested: state.showingPrevious = true
      }
      Component.onCompleted: {
        state.replace([entry("a"), entry("b"), entry("c")])
        state.select(initiallySelected ? "b" : "")
      }
      function entry(id) {
        return {id: id, title: "Session " + id, profile: "quickQuestion", status: "running", model: "configured/local",
          messages: [{id: "message-" + id, kind: "assistant", text: "Retained answer", toolName: "", input: "", state: "done", screenshot: false}]}
      }
    }
  }
  TestCase {
    name: "SessionControls"
    when: windowShown
    function test_removed_drag_source_data() {
      return [{tag: "close", reconnect: false}, {tag: "reconnect snapshot", reconnect: true}]
    }
    function test_removed_drag_source(data) {
      const setup = createTemporaryObject(fixture, parent)
      const panel = setup.panel
      const entries = []
      for (let index = 0; index < 12; index++) entries.push(setup.entry("s" + index))
      setup.state.replace(entries)
      setup.state.select("s0")
      setup.height = 500
      verify(waitForRendering(panel))
      const list = findChild(panel, "sessionTabList")
      const source = findChild(panel, "tab-s1")
      mousePress(source, 20, 40, Qt.LeftButton)
      mouseMove(source, 20, -20, 20)
      compare(panel.draggingSessionId, "s1")
      verify(panel.dragDestinationValid)

      // A destroyed delegate cannot emit release/cancel. Both incremental
      // close and a reconnect snapshot must cancel the parent-owned gesture.
      if (data.reconnect) setup.state.replace(entries.filter(entry => entry.id !== "s1"))
      else setup.state.remove("s1")
      setup.state.orderRevision = "after-removal"
      wait(50)
      mouseRelease(panel, 60, 200, Qt.LeftButton)
      compare(panel.draggingSessionId, "")
      compare(panel.dragBeforeId, "")
      compare(panel.dragOrderRevision, "")
      compare(panel.dragSceneX, 0)
      compare(panel.dragSceneY, 0)
      verify(!panel.dragDestinationValid)
      verify(!findChild(panel, "sessionDragScrollTimer").running)
      verify(list.interactive)

      mouseWheel(list, 30, 100, 0, -240)
      tryVerify(() => list.contentY > 0)
      list.cancelFlick()
      list.contentY = 0
      setup.state.select("s11")
      const last = findChild(panel, "tab-s11")
      tryVerify(() => last.y + last.height <= list.contentY + list.height)
      setup.state.select("s0")
      tryCompare(list, "contentY", 0)

      // The very next physical drag must capture the new membership revision.
      const first = findChild(panel, "tab-s0")
      mouseDrag(first, 20, 40, 0, 175, Qt.LeftButton)
      tryCompare(first, "number", 3)
      const moves = setup.requests.filter(request => request.action === "move-agent")
      compare(moves.length, 1)
      compare(moves[0].revision, "after-removal")
      compare(setup.state.selectedId, "s0")
    }
    function modelRequests(setup) {
      return setup.requests.filter(request => request.action === "agent-models").length
    }
    function test_claude_code_conversation_hides_pickers_without_pi_catalogue() {
      const setup = createTemporaryObject(fixture, parent, {initiallySelected: false})
      const claude = Object.assign(setup.entry("claude"), {profile: "coding", harness: "claude-code",
        model: "claude-opus-5-5", claudeCode: {model: "claude-opus-5-5", effort: "high"}})
      setup.state.replace([claude, setup.entry("pi")])
      setup.state.select("claude")
      verify(waitForRendering(setup.panel))
      wait(20)
      compare(modelRequests(setup), 0, "A Claude Code conversation never needs Pi's catalogue")
      const footer = findChild(setup.panel, "sessionModelFooter")
      const summary = findChild(setup.panel, "fixedSessionModel")
      verify(footer.visible)
      verify(summary.visible)
      compare(summary.text, "Claude Code · claude-opus-5-5 · high effort")
      verify(findChild(setup.panel, "fixedSessionModelNote").visible)
      for (const name of ["sessionModelPicker", "sessionThinkingPicker", "showAllSessionModels", "refreshSessionModels"]) {
        compare(findChild(setup.panel, name).visible, false, name)
      }

      // Pi conversations keep the existing pickers and catalogue loading.
      setup.state.select("pi")
      tryVerify(() => modelRequests(setup) === 1)
      verify(findChild(setup.panel, "sessionModelPicker").visible)
      verify(findChild(setup.panel, "sessionThinkingPicker").visible)
      verify(!summary.visible)

      // Streaming updates carry the whole view, so the harness is retained.
      setup.state.update(Object.assign({}, claude, {status: "completed", messages: []}))
      setup.state.select("claude")
      verify(summary.visible)
      compare(findChild(setup.panel, "sessionModelPicker").visible, false)
      compare(modelRequests(setup), 1)
    }
    function test_model_catalog_reused_across_selection_and_reconnect() {
      const setup = createTemporaryObject(fixture, parent, {controlsEnabled: false})
      verify(waitForRendering(setup.panel))
      compare(modelRequests(setup), 0)
      // Capabilities can arrive after the connection and selected tab.
      setup.controlsEnabled = true
      tryCompare(setup.state, "modelsLoading", false)
      tryVerify(() => modelRequests(setup) === 1)
      for (const id of ["a", "c", "b", "a", "c"]) {
        setup.state.select(id)
        wait(20)
      }
      compare(modelRequests(setup), 1)

      setup.state.disconnectControls()
      setup.panel.online = false
      setup.answerModels = false
      setup.panel.online = true
      setup.state.controlsAvailable = true
      tryVerify(() => modelRequests(setup) === 2)
      verify(setup.state.modelsLoading)
      const picker = findChild(setup.panel, "sessionModelPicker")
      verify(picker.enabled, "Cached rows remain usable during reconnect discovery")
      setup.state.select("a")
      wait(20)
      compare(modelRequests(setup), 2)
    }
    function test_model_initial_need_and_unknown_catalog() {
      const setup = createTemporaryObject(fixture, parent, {initiallySelected: false, answerModels: false})
      verify(waitForRendering(setup.panel))
      compare(modelRequests(setup), 0)
      setup.state.update(Object.assign({}, setup.state.sessions[1], {modelOverride: "configured/alternate", messages: []}))
      setup.state.select("b")
      tryVerify(() => modelRequests(setup) === 1)
      const picker = findChild(setup.panel, "sessionModelPicker")
      compare(picker.currentText, "configured/alternate", "Unknown availability is not unavailability")
      verify(!picker.enabled)
      setup.state.controlReceived({type: "error", action: "agent-models", message: "Fixture discovery failed"})
      for (const id of ["a", "c", "b"]) {
        setup.state.select(id)
        wait(20)
      }
      compare(modelRequests(setup), 1, "Selection does not retry failed discovery")
      compare(picker.currentText, "configured/alternate")
      const refresh = findChild(setup.panel, "refreshSessionModels")
      mouseClick(refresh, refresh.width / 2, refresh.height / 2)
      compare(modelRequests(setup), 2)
      setup.state.controlReceived({type: "result", action: "agent-models", result: {models: []}})
      compare(picker.currentText, "configured/alternate (unavailable)")
    }
    function test_cached_picker_usable_while_refresh_pins_rows() {
      const setup = createTemporaryObject(fixture, parent)
      const picker = findChild(setup.panel, "sessionModelPicker")
      verify(waitForRendering(picker))
      tryVerify(() => modelRequests(setup) === 1)
      setup.answerModels = false
      const refresh = findChild(setup.panel, "refreshSessionModels")
      mouseClick(refresh, refresh.width / 2, refresh.height / 2)
      compare(modelRequests(setup), 2)
      verify(setup.state.modelsLoading)
      verify(picker.enabled)
      mouseClick(picker, 35, 15)
      verify(picker.popup.visible)
      setup.state.controlReceived({type: "result", action: "agent-models", result: {models: ["configured/new-row", "configured/alternate"]}})
      keyClick(Qt.Key_Down)
      keyClick(Qt.Key_Return)
      const choice = setup.requests.filter(request => request.action === "set-agent-model")[0]
      compare(choice.id, "b")
      compare(choice.model, "configured/alternate")
      compare(modelRequests(setup), 2)
    }
    function test_keyboard_and_drag_preserve_selected_conversation_draft_and_delegate() {
      const setup = createTemporaryObject(fixture, parent)
      const panel = setup.panel
      verify(waitForRendering(panel))
      panel.focusComposer()
      const input = findChild(panel, "sessionComposer")
      verify(input !== null)
      input.text = "Unsent draft"
      const tab = findChild(panel, "tab-b")
      const bubble = findChild(panel, "bubble-message-b")
      keyClick(Qt.Key_Up, Qt.AltModifier | Qt.ShiftModifier)
      tryCompare(tab, "number", 1)
      compare(setup.state.selectedId, "b")
      compare(input.text, "Unsent draft")
      compare(findChild(panel, "tab-b"), tab)
      compare(findChild(panel, "bubble-message-b"), bubble)
      compare(setup.requests.filter(request => request.action === "move-agent")[0].beforeId, "a")
      keyClick(Qt.Key_Down, Qt.AltModifier | Qt.ShiftModifier)
      tryCompare(tab, "number", 2)
      const first = findChild(panel, "tab-a")
      mouseDrag(first, 20, 40, 0, 175, Qt.LeftButton)
      tryCompare(first, "number", 3)
      compare(setup.state.selectedId, "b")
      compare(input.text, "Unsent draft")
      // Streaming and a routine reconnect snapshot use the same accepted order.
      setup.state.update(Object.assign({}, setup.state.sessions[0], {messages: []}))
      setup.state.replace(setup.state.sessions.slice())
      compare(setup.state.sessions.map(entry => entry.id).join(","), "b,c,a")
      compare(findChild(panel, "activityTab").y, 25)
    }
    function dragDivider(panel, destination) {
      const divider = findChild(panel, "railDivider")
      // The divider moves under the pointer: send window-relative events, as
      // a physical pointer does, rather than remapping each step to the divider.
      const point = divider.mapToItem(panel, 5, 300)
      mousePress(panel, point.x, point.y, Qt.LeftButton)
      mouseMove(panel, destination, point.y, 20)
      mouseRelease(panel, destination, point.y, Qt.LeftButton)
    }
    function test_divider_constraints_and_preference_survive_narrowing() {
      const setup = createTemporaryObject(fixture, parent)
      const panel = setup.panel
      verify(waitForRendering(panel))
      const divider = findChild(panel, "railDivider")
      const rail = findChild(panel, "tabRail")
      compare(rail.width, 80)
      dragDivider(panel, 220)
      compare(rail.width, 220)
      compare(findChild(panel, "tab-b").height, 77.5)
      const chosen = panel.railWidthUnits
      setup.width = 420
      compare(rail.width, 100)
      verify(findChild(panel, "sessionComposer").width > 200)
      setup.width = 800
      compare(panel.railWidthUnits, chosen)
      compare(rail.width, chosen)
      dragDivider(panel, 5)
      compare(rail.width, 80)
      dragDivider(panel, 780)
      compare(rail.width, 280)
    }
    function test_model_menu_pins_rows_and_cancels_when_conversation_changes() {
      const setup = createTemporaryObject(fixture, parent)
      const picker = findChild(setup.panel, "sessionModelPicker")
      verify(waitForRendering(picker))
      mouseClick(picker, 35, 15)
      verify(picker.popup.visible)
      setup.state.modelCatalog = {models: ["configured/new-row", "configured/alternate"], quickQuestion: "configured/local"}
      keyClick(Qt.Key_Down)
      keyClick(Qt.Key_Return)
      compare(setup.requests.filter(request => request.action === "set-agent-model")[0].model, "configured/alternate")
      mouseClick(picker, 35, 15)
      verify(picker.popup.visible)
      setup.state.select("a")
      tryCompare(picker.popup, "visible", false)
      keyClick(Qt.Key_Return)
      compare(setup.requests.filter(request => request.action === "set-agent-model").length, 1)
    }
    function test_effort_picker_forwards_only_selected_conversation() {
      const setup = createTemporaryObject(fixture, parent)
      setup.availableCatalog = {models: ["configured/local"], pinned: ["configured/local"], quickQuestion: "configured/local", quickQuestionThinking: "off", thinkingLevels: {"configured/local": ["off", "low", "high"]}}
      const picker = findChild(setup.panel, "sessionThinkingPicker")
      tryCompare(picker, "enabled", true)
      verify(waitForRendering(picker))
      mouseClick(picker, 30, picker.height / 2)
      keyClick(Qt.Key_End)
      keyClick(Qt.Key_Return)
      const request = setup.requests.find(request => request.action === "set-agent-thinking")
      verify(request !== undefined)
      compare(request.id, "b")
      compare(request.thinking, "high")
      compare(setup.state.sessions[1].thinkingOverride, "high")
      compare(setup.state.sessions[0].thinkingOverride, undefined)
    }

    function test_model_picker_scope_and_stale_voice_selection() {
      const setup = createTemporaryObject(fixture, parent)
      const panel = setup.panel
      verify(waitForRendering(panel))
      const picker = findChild(panel, "sessionModelPicker")
      verify(picker.visible)
      verify(picker.currentText.indexOf("quick-question") >= 0)
      mouseClick(picker, 35, 15)
      keyClick(Qt.Key_Down)
      keyClick(Qt.Key_Return)
      tryCompare(picker, "currentIndex", 1)
      const request = setup.requests.find(request => request.action === "set-agent-model")
      compare(request.id, "b")
      compare(request.model, "configured/alternate")
      compare(setup.state.sessions[1].model, "configured/local", "Running model is independent of next-turn override")
      const token = setup.state.navigationToken
      setup.state.select("a")
      setup.state.controlReceived({type: "agent-select", id: "c", token: token, orderRevision: setup.state.orderRevision})
      compare(setup.state.selectedId, "a")
      setup.state.controlReceived({type: "agent-select", id: "c", token: setup.state.navigationToken, orderRevision: "stale"})
      compare(setup.state.selectedId, "a")
      setup.state.controlReceived({type: "agent-select", id: "c", token: setup.state.navigationToken, orderRevision: setup.state.orderRevision})
      compare(setup.state.selectedId, "c")
      setup.state.panelVisible = false
      setup.state.controlReceived({type: "agent-select", id: "a", token: setup.state.navigationToken, orderRevision: setup.state.orderRevision})
      compare(setup.state.selectedId, "c")
    }
  }
}
