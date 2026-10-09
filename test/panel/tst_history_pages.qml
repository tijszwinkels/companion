import QtQuick
import QtTest
import "../../integrations/panel" as Panel
import "../../integrations/window" as Window

Item {
  width: 600; height: 900
  Component {
    id: viewComponent
    Panel.SessionView {
      width: 600; height: 900
      foreground: "white"; muted: "gray"; accent: "cyan"; selection: "#223344"; fontFamily: "sans-serif"
      session: null
    }
  }
  Component { id: stateComponent; Panel.AgentSessionState {} }
  function row(index) {
    return {id: "row-" + index, kind: "assistant", text: "Message " + index + "\n" + "text ".repeat(35), input: "", toolName: "", state: "done", screenshot: false}
  }
  function fixture(start, end, revision, id, epoch) {
    const messages = []
    for (let index = start; index < end; index++) messages.push(row(index))
    return {id: id || "fixture", toolEpoch: epoch || "epoch", title: "Fixture", status: "completed", error: "", messages: messages,
      history: {start: {index: start, offset: 0}, end: {index: end, offset: 0}, total: end, revision: revision || 1, ids: messages.map(row => row.id)}}
  }
  function reply(request, session) {
    return {action: "agent-history-page", type: "result", requestId: request.requestId,
      result: {id: request.id, epoch: request.epoch, history: session.history, messages: session.messages}}
  }

  TestCase {
    name: "CompanionHistoryPages"
    when: windowShown
    function test_window_deltas_prune_and_order_without_losing_retained_rows() {
      const state = createTemporaryObject(stateComponent, parent)
      state.replace([fixture(200, 205)])
      const patch = fixture(202, 207, 2)
      patch.messages = patch.messages.slice(-2)
      state.update(patch)
      compare(state.sessions[0].messages.map(row => row.id).join(","), "row-202,row-203,row-204,row-205,row-206")
    }
    function test_pages_replace_not_accumulate_and_ignore_navigation_races() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 210)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.applyDraft({id: "fixture", text: "Keep my draft", source: {title: "Fixture"}})
      view.loadHistory("before", view.shownHistory.start, "", false)
      compare(requests.length, 1)
      view.toolPageReceived(reply(requests[0], fixture(190, 200)))
      compare(view.messageCount, 10)
      compare(view.historyPage.messages[0].id, "row-190")
      compare(findChild(view, "sessionComposer").text, "Keep my draft")
      compare(view.followEnd, false)
      view.loadHistory("before", view.shownHistory.start, "", false)
      view.session = fixture(300, 310, 1, "other")
      view.toolPageReceived(reply(requests[1], fixture(180, 190)))
      compare(view.historyPage, null)
      compare(view.displayedId, "other")
      compare(view.messageCount, 10)
    }
    function test_stale_page_refresh_latest_and_epoch() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 210)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.loadHistory("before", view.shownHistory.start, "", false)
      view.toolPageReceived(reply(requests[0], fixture(190, 200)))
      view.session = fixture(201, 211, 2)
      compare(view.historyChanged, true)
      compare(view.historyPage.messages[0].id, "row-190")
      view.loadHistory("after", view.shownHistory.start, "", true)
      view.latestHistory()
      view.toolPageReceived(reply(requests[1], fixture(190, 200, 2)))
      compare(view.historyPage, null)
      compare(view.followEnd, true)
      view.loadHistory("before", view.shownHistory.start, "", false)
      view.session = fixture(201, 211, 1, "fixture", "reopened")
      view.toolPageReceived(reply(requests[2], fixture(190, 200)))
      compare(view.historyPage, null)
    }
    function test_disconnect_invalidates_pending_page_without_discarding_draft() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 210)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.applyDraft({id: "fixture", text: "Still unsent", source: {title: "Fixture"}})
      view.loadHistory("before", view.shownHistory.start, "", false)
      view.online = false
      view.toolPageReceived(reply(requests[0], fixture(190, 200)))
      compare(view.historyPage, null)
      compare(findChild(view, "sessionComposer").text, "Still unsent")
    }
    function test_reading_freezes_before_eviction_and_anchor_jump_fetches_directly() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 210)
      view.followEnd = false
      const transcript = findChild(view, "sessionTranscript")
      transcript.positionViewAtBeginning()
      wait(30)
      const before = transcript.contentY
      view.session = fixture(201, 211, 2)
      compare(view.historyPage.messages[0].id, "row-200")
      compare(transcript.contentY, before)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.jumpToToolGroup("row-50")
      compare(requests[0].anchor, "row-50")
      view.toolPageReceived(reply(requests[0], fixture(50, 60, 2)))
      tryVerify(() => findChild(view, "bubble-row-50") !== null)
      wait(30)
      const bubble = findChild(view, "bubble-row-50")
      verify(Math.abs(bubble.y - transcript.contentY) < 2)
      compare(requests.length, 1, "Source jump never expands tool details")
    }
  }
}
