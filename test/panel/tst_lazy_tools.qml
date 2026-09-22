import QtQuick
import QtTest
import "../../integrations/panel" as Panel
import "../../integrations/window" as Window

Item {
  width: 600
  height: 900
  TextEdit { id: clipboardReader; visible: false; textFormat: TextEdit.PlainText }
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 600; height: 900
      online: true; paused: false; speaking: false; processing: 0
      foreground: "#e0e6f0"; muted: "#959faa"; accent: "#82aaff"
      selection: "#283348"; fontFamily: "sans-serif"
    }
  }
  Component {
    id: clientComponent
    Window.Client {
      transport: QtObject {
        signal received(var message)
        signal disconnected()
        property var sent: []
        function send(request) { sent.push(request); return true }
      }
    }
  }

  function group(count, revision) {
    return {id: "group", kind: "tool", text: "", input: "", toolName: "", state: "running",
      screenshot: false, toolGroup: {count: count, revision: revision}}
  }
  function session(count, revision, id, epoch) {
    return {id: id || "question", toolEpoch: epoch || "epoch", title: "Fixture", status: "running", error: "",
      messages: [group(count, revision)]}
  }
  function response(request, text, next) {
    return {type: "result", action: "agent-tool-page", requestId: request.requestId,
      result: Object.assign({}, request, {text: text, next: next || null})}
  }

  TestCase {
    name: "CompanionLazyTools"
    when: windowShown

    function click(item, x, y) {
      verify(waitForRendering(item))
      mouseClick(item, x, y)
      wait(20)
    }

    function setup() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [session(2, "r1")]
      panel.selectedSessionId = "question"
      tryVerify(() => findChild(panel, "bubble-group") !== null)
      return panel
    }

    function test_disclosure_fetches_only_on_click_and_growth_keeps_one_control() {
      const panel = setup()
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      const bubble = findChild(panel, "bubble-group")
      compare(findChild(bubble, "toolDetails"), null, "Collapsed tools must not instantiate a hidden body")
      compare(requests.length, 0)
      panel.sessions = [session(1500, "r2")]
      compare(findChild(panel, "sessionView").messageCount, 1)
      compare(findChild(panel, "bubble-group"), bubble)
      compare(bubble.expanded, false)
      compare(requests.length, 0)
      click(bubble, 24, 14)
      tryCompare(requests, "length", 1)
      compare(requests[0].groupId, "group")
      compare(requests[0].epoch, "epoch")
      compare(requests[0].revision, "r2")
      compare(requests[0].index, 0)
      panel.toolPageReceived(response(requests[0], "<b>plain input/result</b>", {index: 0, offset: 25}))
      const text = findChild(bubble, "toolPageText")
      compare(text.textFormat, TextEdit.PlainText)
      compare(text.getText(0, text.length), "<b>plain input/result</b>")
      text.selectAll()
      verify(findChild(panel, "sessionView").hasMessageSelection)
      click(findChild(bubble, "nextToolPage"))
      compare(requests.length, 2)
      panel.toolPageReceived(response(requests[1], "second page"))
      compare(text.text, "second page", "Loading more replaces the old page; no unbounded concatenation")
      compare(findChild(bubble, "nextToolPage").visible, false)
      click(findChild(bubble, "copyToolPage"))
      clipboardReader.text = ""
      clipboardReader.paste()
      compare(clipboardReader.text, "second page")
    }

    function test_stream_update_expires_old_pages_without_automatic_refetch() {
      const panel = setup()
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      const bubble = findChild(panel, "bubble-group")
      click(bubble, 24, 14)
      compare(requests.length, 1)
      panel.sessions = [session(3, "r2")]
      compare(bubble.expanded, true)
      compare(requests.length, 1)
      panel.toolPageReceived(response(requests[0], "stale secret"))
      compare(findChild(bubble, "toolPageText").text, "")
      click(findChild(bubble, "reloadToolDetails"))
      compare(requests.length, 2)
      compare(requests[1].revision, "r2")
      panel.toolPageReceived(response(requests[1], "current output"))
      compare(findChild(bubble, "toolPageText").text, "current output")
      panel.sessions = [session(3, "r2")]
      compare(findChild(bubble, "toolPageText").text, "current output", "Unrelated snapshots retain selection and the page")
    }

    function test_collapse_reexpand_discards_pending_and_loaded_contents() {
      const panel = setup()
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      const bubble = findChild(panel, "bubble-group")
      click(bubble, 24, 14)
      click(bubble, 24, 14)
      compare(findChild(bubble, "toolDetails"), null)
      panel.toolPageReceived(response(requests[0], "hidden stale output"))
      compare(findChild(bubble, "toolPageText"), null)
      click(bubble, 24, 14)
      compare(requests.length, 2)
      verify(requests[1].requestId !== requests[0].requestId)
      panel.toolPageReceived(response(requests[0], "stale output"))
      compare(findChild(bubble, "toolPageText").text, "")
      panel.toolPageReceived(response(requests[1], "fresh page"))
      compare(findChild(bubble, "toolPageText").text, "fresh page")
    }

    function test_disconnect_errors_switch_remove_and_reopen_reject_late_responses() {
      const panel = setup()
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      click(findChild(panel, "bubble-group"), 24, 14)
      panel.online = false
      panel.toolPageReceived(response(requests[0], "disconnected output"))
      compare(findChild(panel, "toolPageText").text, "")
      panel.online = true
      compare(requests.length, 1)
      click(findChild(panel, "reloadToolDetails"))
      panel.toolPageReceived({type: "error", requestId: requests[1].requestId, message: "Fixture read failure"})
      verify(findChild(panel, "toolDetails").error.indexOf("Fixture read failure") >= 0)
      click(findChild(panel, "reloadToolDetails"))
      const old = requests[2]
      panel.sessions = []
      wait(20)
      tryCompare(findChild(panel, "sessionView"), "messageCount", 0)
      panel.sessions = [session(2, "r1", "question", "reopened")]
      panel.selectedSessionId = "question"
      tryVerify(() => findChild(panel, "bubble-group") !== null)
      compare(findChild(panel, "bubble-group").expanded, false)
      click(findChild(panel, "bubble-group"), 24, 14)
      compare(requests[3].epoch, "reopened")
      panel.toolPageReceived(response(old, "previous tab lifetime"))
      compare(findChild(panel, "toolPageText").text, "")
      panel.sessions = [session(2, "r1", "other")]
      panel.selectedSessionId = "other"
      wait(20)
      panel.toolPageReceived(response(requests[3], "foreign conversation"))
      compare(findChild(panel, "toolDetails"), null)
    }

    function test_sibling_growth_keeps_page_position_and_call_revision() {
      const panel = setup()
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      click(findChild(panel, "bubble-group"), 24, 14)
      let reply = response(requests[0], "page one", {index: 0, offset: 8192})
      reply.result.callRevision = "finished-call"
      reply.result.state = "error"
      panel.toolPageReceived(reply)
      verify(findChild(panel, "toolPageStatus").text.indexOf("failed or stopped") >= 0)
      click(findChild(panel, "nextToolPage"))
      compare(requests[1].callRevision, "finished-call")
      reply = response(requests[1], "page two", {index: 0, offset: 16384})
      reply.result.callRevision = "finished-call"
      panel.toolPageReceived(reply)
      panel.sessions = [session(3, "r2")]
      compare(findChild(panel, "toolPageText").text, "page two")
      compare(findChild(panel, "toolDetails").offset, 8192)
      compare(requests.length, 2)
      click(findChild(panel, "nextToolPage"))
      compare(requests[2].offset, 16384)
      compare(requests[2].callRevision, "finished-call")
      compare(requests[2].revision, "r2")
      reply = response(requests[2], "page three")
      reply.result.callRevision = "finished-call"
      panel.toolPageReceived(reply)
      panel.sessions = [session(4, "r3")]
      click(findChild(panel, "reloadToolDetails"))
      compare(requests[3].index, 0)
      compare(requests[3].offset, 16384, "Refresh stays at the current page")
      compare(requests[3].callRevision, "", "Explicit refresh selects the latest call version")
    }

    function test_offline_expansion_and_running_page_status() {
      const panel = setup()
      panel.online = false
      click(findChild(panel, "bubble-group"), 24, 14)
      verify(findChild(panel, "toolDetails").error.indexOf("Disconnected") >= 0)
      panel.online = true
      const requests = []
      panel.toolPageRequested.connect(request => requests.push(request))
      click(findChild(panel, "reloadToolDetails"))
      const reply = response(requests[0], "partial output")
      reply.result.callRevision = "running-call"
      reply.result.state = "running"
      panel.toolPageReceived(reply)
      verify(findChild(panel, "toolPageStatus").text.indexOf("running") >= 0)
    }

    function test_native_client_forwards_correlated_success_and_failure_without_retaining_bodies() {
      const client = createTemporaryObject(clientComponent, parent)
      const replies = []
      client.toolPageReceived.connect(message => replies.push(message))
      client.receive({type: "state", protocol: 1, ready: true, sessions: [session(2, "r1")]})
      const request = {action: "agent-tool-page", requestId: "correlation", id: "question", groupId: "group", revision: "r1", epoch: "epoch", index: 0, offset: 0}
      client.reportPanel()
      verify(client.send(request))
      client.receive(response(request, "only the expanded component owns this page"))
      compare(replies.length, 1)
      compare(client.sessions.sessions[0].messages[0].text, "")
      client.receive({type: "error", action: "agent-tool-page", requestId: "correlation", message: "Unavailable"})
      compare(replies.length, 2)
      compare(client.error, "", "A tool read failure belongs to its disclosure")
    }
  }
}
