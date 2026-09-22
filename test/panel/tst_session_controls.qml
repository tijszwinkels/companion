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
      Panel.AgentSessionState {
        id: state
        controlsAvailable: true
        panelVisible: true
        orderRevision: "order-1"
        modelCatalog: ({models: ["configured/alternate"], coding: "configured/coding", quickQuestion: "configured/local"})
        onControlRequested: request => {
          setup.requests = setup.requests.concat([request])
          if (request.action === "agent-models") {
            controlReceived({type: "result", action: request.action, result: modelCatalog})
          } else if (request.action === "move-agent") {
            const ids = sessions.map(entry => entry.id).filter(id => id !== request.id)
            ids.splice(request.beforeId ? ids.indexOf(request.beforeId) : ids.length, 0, request.id)
            controlReceived({type: "agent-order", ids: ids, revision: orderRevision + "-next"})
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
        state.select("b")
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
