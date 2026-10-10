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
    function test_epoch_reset_discards_old_lifetime_data() {
      return [{tag: "reading recent", historical: false}, {tag: "reading history", historical: true}]
    }
    function test_epoch_reset_discards_old_lifetime(data) {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 210, 10, "fixture", "old-epoch")
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.applyDraft({id: "fixture", text: "Draft survives reopening", source: {title: "Fixture"}})
      if (data.historical) {
        view.loadHistory("before", view.shownHistory.start, "", false)
        view.toolPageReceived(reply(requests[0], fixture(190, 200, 10)))
      }
      view.followEnd = false
      view.loadHistory("before", view.shownHistory.start, "", false)
      const pending = requests[requests.length - 1]
      view.historyError = "Old lifetime error"
      view.online = false
      // Another client closes/reopens and continues this ID while disconnected.
      view.session = fixture(210, 220, 1, "fixture", "new-epoch")
      view.online = true
      compare(view.historyPage, null, "Do not relabel old rows with the new epoch")
      compare(view.shownHistory.start.index, 210)
      compare(view.previousLive.toolEpoch, "new-epoch")
      compare(view.historyPending, "")
      compare(view.historyRequest, null)
      compare(view.historyError, "")
      compare(view.followEnd, true)
      compare(view.messageCount, 10)
      compare(findChild(view, "sessionComposer").text, "Draft survives reopening")
      view.toolPageReceived(reply(pending, fixture(180, 190, 10)))
      compare(view.historyPage, null, "Late old-epoch response is inert")
    }
    function test_wake_updates_keep_frozen_history_draft_selection_and_epoch_guards() {
      const view = createTemporaryObject(viewComponent, parent)
      const timer = {id: "timer", label: "Review", state: "scheduled", dueAt: Date.now() + 60000}
      const initial = fixture(200, 210, 1)
      initial.wakes = [timer]
      view.session = initial
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.applyDraft({id: "fixture", text: "Unsent during wake", source: {title: "Fixture"}})
      view.loadHistory("before", view.shownHistory.start, "", false)
      view.toolPageReceived(reply(requests[0], fixture(190, 200)))
      const frozen = view.historyPage
      const composer = findChild(view, "sessionComposer")
      composer.forceActiveFocus()
      const toggle = findChild(view, "wakeToggle")
      verify(waitForRendering(view))
      mouseClick(toggle)
      verify(waitForRendering(view))
      const controls = findChild(view, "olderHistory")
      const cancel = findChild(view, "cancelWakeButton")
      verify(controls.visible && cancel.visible, "Paging and cancellation coexist")
      let cancelled = null
      view.cancelWakeRequested.connect((id, timerId) => cancelled = [id, timerId])
      for (const state of ["waiting", "cancelled"]) {
        const updated = fixture(201, 211, 2)
        updated.wakes = [Object.assign({}, timer, {state: state})]
        view.session = updated
        compare(view.historyPage, frozen)
        compare(view.shownHistory.start.index, 190)
        compare(composer.text, "Unsent during wake")
        compare(view.displayedId, "fixture")
        if (state === "waiting") {
          verify(waitForRendering(view))
          mouseClick(findChild(view, "cancelWakeButton"))
          compare(cancelled, ["fixture", "timer"])
        }
      }
      view.loadHistory("before", view.shownHistory.start, "", false)
      const stale = requests[requests.length - 1]
      const reopened = fixture(300, 310, 1, "fixture", "new-wake-lifetime")
      reopened.wakes = [Object.assign({}, timer, {state: "cancelled"})]
      view.session = reopened
      view.toolPageReceived(reply(stale, fixture(180, 190)))
      compare(view.historyPage, null)
      compare(view.shownHistory.start.index, 300)
      compare(view.previousLive.toolEpoch, "new-wake-lifetime")
      compare(composer.text, "Unsent during wake")
    }
    function test_older_action_scrolls_with_history_and_preserves_draft() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(200, 230)
      view.applyDraft({id: "fixture", text: "Keep this draft", source: {title: "Fixture"}})
      const transcript = findChild(view, "sessionTranscript")
      const older = findChild(view, "olderHistory")
      verify(waitForRendering(view))
      verify(transcript.headerItem !== null, "Older action belongs to the scrolling header")
      compare(older.parent, transcript.headerItem)
      compare(transcript.anchors.topMargin, 0, "Recent history has no sticky paging toolbar")
      tryVerify(() => transcript.atYEnd)
      verify(older.mapToItem(transcript, 0, 0).y + older.height <= 0, "Older action is clipped at Latest")
      mouseWheel(transcript, 100, 100, 0, 12000, Qt.NoButton)
      tryVerify(() => transcript.atYBeginning)
      const top = older.mapToItem(transcript, 0, 0).y
      verify(top >= 0 && top + older.height <= transcript.height, "Wheel scrolling reaches the older action")
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      mouseClick(older)
      compare(requests.length, 1)
      compare(requests[0].direction, "before")
      compare(requests[0].index, 200)
      view.toolPageReceived(reply(requests[0], fixture(170, 200)))
      compare(view.historyPage.messages[0].id, "row-170")
      compare(findChild(view, "sessionComposer").text, "Keep this draft")
      verify(findChild(view, "latestHistory").visible, "Historical navigation remains available")
    }
    function test_oldest_page_has_no_older_action_or_empty_toolbar() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(0, 20)
      verify(waitForRendering(view))
      const transcript = findChild(view, "sessionTranscript")
      verify(transcript.headerItem !== null)
      compare(transcript.headerItem.height, 0)
      verify(!findChild(view, "olderHistory").visible)
      compare(transcript.anchors.topMargin, 0)
    }
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
