import QtQuick
import QtTest
import "../../integrations/panel" as Panel
import "../../integrations/panel/HistoryRows.mjs" as HistoryRows

// Continuous conversation scrolling against a synthetic listener. `page()`
// follows src/agents/history-pages.ts (same row/text budgets and fragments), so
// these checks join real-shaped pages: no row is skipped or repeated, the
// reader's row stays put and resident rows stay bounded.
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

  // --- Synthetic listener --------------------------------------------------

  function row(index, text) {
    return {id: "row-" + index, kind: index % 2 ? "assistant" : "user", text: text !== undefined ? text : "Message " + index + "\n" + "text ".repeat(35),
      input: "", toolName: "", state: "done", screenshot: false}
  }
  function source(count) {
    const rows = []
    for (let index = 0; index < count; index++) rows.push(row(index))
    return rows
  }
  function size(message) { return message.input.length + message.text.length }
  function fragment(message, start, end) {
    if (start === 0 && end === size(message)) return message
    const inputEnd = message.input.length
    return Object.assign({}, message, {input: message.input.slice(start, Math.min(end, inputEnd)),
      text: message.text.slice(Math.max(0, start - inputEnd), Math.max(0, end - inputEnd)),
      historyFragment: {start: start, end: end, total: size(message)}})
  }
  function page(rows, revision, direction, position) {
    let index = position.index
    let offset = position.offset
    const messages = []
    let remaining = HistoryRows.pageUnits
    const boundary = {index: index, offset: offset}
    while (messages.length < HistoryRows.pageRows && remaining > 0) {
      if (direction === "before") {
        if (offset === 0) {
          if (index === 0) break
          index--
          offset = size(rows[index])
        }
        const start = Math.max(0, offset - remaining)
        messages.unshift(fragment(rows[index], start, offset))
        remaining -= offset - start
        offset = start
      } else {
        if (index === rows.length) break
        const end = Math.min(size(rows[index]), offset + remaining)
        messages.push(fragment(rows[index], offset, end))
        remaining -= end - offset
        offset = end
        if (offset === size(rows[index])) { index++; offset = 0 }
      }
    }
    const other = {index: index, offset: offset}
    return {messages: messages, history: {start: direction === "before" ? other : boundary, end: direction === "before" ? boundary : other,
      total: rows.length, revision: revision, ids: messages.map(message => message.id)}}
  }
  function live(rows, revision, id, epoch) {
    const window = page(rows, revision || 1, "before", {index: rows.length, offset: 0})
    return {id: id || "fixture", toolEpoch: epoch || "epoch", title: "Fixture", status: "completed", error: "",
      messages: window.messages, history: window.history}
  }
  function answer(request, rows, revision) {
    const anchor = request.anchor ? rows.findIndex(entry => entry.id === request.anchor) : -1
    const result = request.anchor ? page(rows, revision || 1, "after", {index: anchor, offset: 0})
      : page(rows, revision || 1, request.direction, {index: request.index, offset: request.offset})
    return {action: "agent-history-page", type: "result", requestId: request.requestId,
      result: {id: request.id, epoch: request.epoch, messages: result.messages, history: result.history}}
  }
  function failure(request, message) {
    return {action: "agent-history-page", type: "error", requestId: request.requestId, message: message}
  }
  // The pre-existing simple fixture: rows [start, end) as the live window.
  function fixture(start, end, revision, id, epoch) {
    const messages = []
    for (let index = start; index < end; index++) messages.push(row(index))
    return {id: id || "fixture", toolEpoch: epoch || "epoch", title: "Fixture", status: "completed", error: "", messages: messages,
      history: {start: {index: start, offset: 0}, end: {index: end, offset: 0}, total: end, revision: revision || 1, ids: messages.map(row => row.id)}}
  }

  TestCase {
    name: "CompanionHistoryPages"
    when: windowShown

    // --- Reader helpers -------------------------------------------------------

    function transcriptOf(view) { return findChild(view, "sessionTranscript") }
    function wheel(view, notches) {
      const transcript = transcriptOf(view)
      mouseWheel(transcript, transcript.width / 2, transcript.height / 2, 0, 120 * notches, Qt.NoButton)
    }
    function toTop(view) {
      // Like dragging the scroll bar: the reader leaves the live end first.
      const transcript = transcriptOf(view)
      view.followEnd = false
      transcript.positionViewAtBeginning()
      wheel(view, 1)
    }
    function toBottom(view) {
      const transcript = transcriptOf(view)
      view.followEnd = false
      transcript.positionViewAtEnd()
      wheel(view, -1)
    }
    // Every resident row continues exactly where the previous one ends, keys are
    // unique and the resident bound holds.
    function verifyResident(view, label) {
      const rows = view.shownRows
      const keys = {}
      let units = 0
      for (let index = 0; index < rows.length; index++) {
        verify(keys[rows[index].key] === undefined, label + ": duplicate " + rows[index].key)
        keys[rows[index].key] = true
        units += size(rows[index].message)
        if (index > 0) {
          verify(HistoryRows.samePosition(rows[index - 1].end, rows[index].start),
            label + ": gap or overlap at " + rows[index].key + " after " + rows[index - 1].key)
        }
      }
      verify(rows.length <= HistoryRows.residentRows, label + ": " + rows.length + " rows resident")
      verify(units <= HistoryRows.residentUnits, label + ": " + units + " units resident")
      compare(view.messageCount, rows.length)
    }
    function anchorOf(view) { return view.topRow() }
    function verifyAnchor(view, anchor, label) {
      tryVerify(() => {
        const now = view.topRow()
        return now !== null && now.key === anchor.key && Math.abs(now.offset - anchor.offset) < 2
      }, 1000, label + ": reader moved from " + JSON.stringify(anchor) + " to " + JSON.stringify(view.topRow()))
    }

    function test_scrolling_up_and_down_walks_all_history_without_gaps_and_returns_to_live() {
      const rows = source(950)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      view.applyDraft({id: "fixture", text: "Keep this draft", source: {title: "Fixture"}})
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      verify(!findChild(view, "jumpToLatest").visible, "No arrow at the live end")
      const seen = {}
      // Upwards: each page joins above the reader without moving it.
      for (let step = 0; step < 10 && view.hasOlder; step++) {
        toTop(view)
        compare(requests.length, step + 1, "One request per edge visit")
        const request = requests[requests.length - 1]
        compare(request.direction, "before")
        verify(findChild(view, "jumpToLatest").visible, "Away from live shows the arrow")
        compare(findChild(view, "historyStatusText").text, "Loading earlier messages…")
        wheel(view, 3)
        compare(requests.length, step + 1, "Rapid wheel input while loading sends nothing more")
        const anchor = anchorOf(view)
        view.toolPageReceived(answer(request, rows))
        verifyAnchor(view, anchor, "older page " + step)
        verifyResident(view, "older page " + step)
        for (const entry of view.shownRows) seen[entry.key] = true
      }
      compare(view.shownRows[0].key, "row-0@0", "Reached the start of the conversation")
      verify(!view.hasOlder)
      toTop(view)
      const atStart = requests.length
      wheel(view, 5)
      compare(requests.length, atStart, "Nothing older to request")
      verify(view.historyDetached, "Two pages above live trimmed the live end")
      compare(Object.keys(seen).length, 950, "Every row appeared once on the way up")

      // Downwards: newer pages join below until the live window continues them.
      for (let step = 0; step < 10 && view.historyDetached; step++) {
        toBottom(view)
        if (!view.historyDetached) break
        const request = requests[requests.length - 1]
        compare(request.direction, "after")
        const anchor = anchorOf(view)
        view.toolPageReceived(answer(request, rows))
        verifyAnchor(view, anchor, "newer page " + step)
        verifyResident(view, "newer page " + step)
      }
      verify(!view.historyDetached, "Scrolling down reaches the live window")
      toBottom(view)
      tryVerify(() => view.followEnd, 1000, "The live end resumes following")
      verify(!findChild(view, "jumpToLatest").visible)
      compare(view.shownRows[view.shownRows.length - 1].key, "row-949@0")
      compare(findChild(view, "sessionComposer").text, "Keep this draft")
    }

    function test_arrow_appears_inside_recent_rows_and_jumps_to_live() {
      const rows = source(150)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      verify(waitForRendering(view))
      const arrow = findChild(view, "jumpToLatest")
      verify(!arrow.visible)
      compare(arrow.width, 32, "About 32 theme units")
      wheel(view, 2)
      verify(arrow.visible, "Scrolling up inside loaded recent rows shows the arrow")
      compare(arrow.Accessible.name, "Jump to latest")
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      compare(requests.length, 0, "Rows within the live window need no request")
      mouseClick(arrow)
      verify(view.followEnd)
      verify(!arrow.visible)
      tryVerify(() => transcriptOf(view).atYEnd)
      // Latest also discards older rows and pending requests.
      const longer = source(450)
      view.session = live(longer)
      toTop(view)
      view.toolPageReceived(answer(requests[0], longer))
      verify(view.readingHistory)
      toTop(view)
      verify(view.historyPending !== "")
      mouseClick(findChild(view, "jumpToLatest"))
      compare(view.historyPending, "")
      verify(!view.readingHistory)
      view.toolPageReceived(answer(requests[1], longer))
      verify(!view.readingHistory, "A request superseded by Latest is inert")
    }

    function test_live_updates_while_reading_keep_the_reader_and_stay_bounded() {
      const rows = source(260)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      verify(waitForRendering(view))
      const transcript = transcriptOf(view)
      // Read in the middle of the recent window, then let rows arrive.
      transcript.contentY = transcript.originY + (transcript.contentHeight - transcript.height) / 2
      wheel(view, 1)
      verify(!view.followEnd)
      const anchor = anchorOf(view)
      for (let added = 0; added < 120; added++) {
        rows.push(row(rows.length))
          view.session = live(rows, 2 + added)
        verifyAnchor(view, anchor, "append " + added)
      }
      verify(view.historyAttached, "Evicted rows stay joined to the live window")
      verifyResident(view, "after appends")
      verify(findChild(view, "jumpToLatest").visible)
      // Keep the reader near the top while many more rows arrive: the bound
      // holds by turning the view into a detached snapshot.
      view.followEnd = false
      transcript.positionViewAtBeginning()
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      const top = anchorOf(view)
      view.readerAnchor = top
      for (let added = 0; added < 500; added += 10) {
        for (let more = 0; more < 10; more++) rows.push(row(rows.length))
        view.session = live(rows, 200 + added)
        verifyResident(view, "burst " + added)
      }
      verifyAnchor(view, top, "after the burst")
      verify(view.historyDetached)
      verify(view.historyChanged, "A detached view whose conversation changed says so")
      compare(findChild(view, "historyStatusAction").text, "Refresh")
    }

    function test_same_row_revisions_update_in_place() {
      const rows = source(220)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      verify(waitForRendering(view))
      wheel(view, 2)
      const anchor = anchorOf(view)
      const last = rows.length - 1
      for (let revision = 2; revision < 6; revision++) {
        rows[last] = Object.assign({}, rows[last], {text: rows[last].text + " more"})
        view.session = live(rows, revision)
        verifyAnchor(view, anchor, "revision " + revision)
      }
      compare(view.shownRows.filter(entry => entry.message.id === "row-" + last).length, 1, "Updated in place, not duplicated")
      verify(view.shownRows[view.shownRows.length - 1].message.text.endsWith("more more more more"))
    }

    function test_oversized_rows_join_as_fragments_without_lost_or_repeated_text() {
      const rows = source(30)
      const giant = "gg ".repeat(23000) + "hh ".repeat(23000) + "ii ".repeat(7000)
      rows.splice(10, 0, row(1000, giant))
      for (let index = 0; index < 8; index++) rows.push(row(2000 + index, "ww ".repeat(3000)))
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      verify(view.liveHistory.start.offset > 0 || view.liveHistory.start.index > 0)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      for (let step = 0; step < 8 && view.hasOlder; step++) {
        toTop(view)
        view.toolPageReceived(answer(requests[requests.length - 1], rows))
        verifyResident(view, "fragment page " + step)
      }
      verify(!view.hasOlder)
      const text = view.shownRows.filter(entry => entry.message.id === "row-1000").map(entry => entry.message.text).join("")
      compare(text.length, giant.length, "Fragments add up to the whole message")
      verify(text === giant)
      // Heading labels identify each piece.
      const pieces = view.shownRows.filter(entry => entry.message.id === "row-1000")
      verify(pieces.length >= 3)
      // Refresh from a fragment restarts at that exact fragment.
      view.refreshHistory()
      const refresh = requests[requests.length - 1]
      verify(refresh.direction === "after")
      view.toolPageReceived(answer(refresh, rows))
      verifyResident(view, "after refresh")
    }

    function test_join_cuts_a_spanning_fragment_at_the_live_start() {
      // The live window starts inside a giant row; an older page fetched as
      // fragments of a different size spans that start and must be shortened.
      const rows = source(5)
      rows.push(row(500, "aaaa ".repeat(20000)))
      for (let index = 0; index < 4; index++) rows.push(row(600 + index, "bbbb ".repeat(2000)))
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const liveStart = view.liveHistory.start
      verify(liveStart.index === 5 && liveStart.offset > 0, "Live window starts inside the giant row")
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      // A detached page from the start ends inside the giant row, before the
      // live start; the next page spans the live start.
      view.loadHistory("after", {index: 0, offset: 0}, "", true)
      view.toolPageReceived(answer(requests[0], rows))
      verify(view.historyDetached)
      verifyResident(view, "detached at a fragment")
      toBottom(view)
      compare(requests[1].direction, "after")
      verify(requests[1].index === 5 && requests[1].offset > 0)
      view.toolPageReceived(answer(requests[1], rows))
      verifyResident(view, "joined at a fragment")
      verify(view.historyAttached)
      const text = view.shownRows.filter(entry => entry.message.id === "row-500").map(entry => entry.message.text).join("")
      compare(text.length, 100000)
    }

    function test_tool_groups_stay_lazy_and_expanded_across_older_pages() {
      const rows = source(400)
      for (let index = 200; index < 206; index += 2) {
        rows[index] = {id: "row-" + index, kind: "tool", text: "", input: "", toolName: "bash", state: "done", screenshot: false,
          toolGroup: {count: 3, revision: "r" + index}}
      }
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      toTop(view)
      const history = requests.filter(request => request.action === "agent-history-page")
      compare(history.length, 1)
      // Open a group the reader is looking at while the older page loads.
      tryVerify(() => findChild(view, "bubble-row-202") !== null)
      findChild(view, "bubble-row-202").toggleExpanded()
      const toolRequests = requests.filter(request => request.action === "agent-tool-page").length
      verify(toolRequests > 0, "Expanding asks for the group's details")
      const anchor = anchorOf(view)
      view.toolPageReceived(answer(history[0], rows))
      verifyAnchor(view, anchor, "older page above an open group")
      verify(findChild(view, "bubble-row-202").expanded, "Joining older rows keeps the open group open")
      // Joining at the very top can recreate visible delegates; an open group
      // then rereads its own first detail page once. Nothing else loads.
      const later = requests.filter(request => request.action === "agent-tool-page").slice(toolRequests)
      verify(later.length <= 1 && later.every(request => request.groupId === "row-202"), JSON.stringify(later))
      verify(!requests.some(request => request.action === "agent-tool-page" && request.groupId !== "row-202"), "Closed groups load nothing")
      verifyResident(view, "with tool groups")
    }

    function test_errors_empty_pages_and_short_content_never_loop() {
      const view = createTemporaryObject(viewComponent, parent)
      // Short content: three rows above which older history exists.
      const short = fixture(200, 203)
      short.messages = short.messages.map(message => Object.assign({}, message, {text: "Short " + message.id}))
      view.session = short
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      view.width = 500
      view.height = 700
      view.zoomPercent = 150
      verify(waitForRendering(view))
      compare(requests.length, 0, "Layout, resize and zoom never request history")
      compare(findChild(view, "historyStatusText").text, "Earlier messages")
      compare(findChild(view, "historyStatusAction").text, "Load")
      mouseClick(findChild(view, "historyStatusAction"))
      compare(requests.length, 1)
      view.toolPageReceived(failure(requests[0], "History is unavailable in this conversation"))
      compare(findChild(view, "historyStatusText").text, "History is unavailable in this conversation")
      compare(findChild(view, "historyStatusAction").text, "Retry")
      wheel(view, 5)
      wait(50)
      compare(requests.length, 1, "Errors do not retry by themselves")
      mouseClick(findChild(view, "historyStatusAction"))
      compare(requests.length, 2)
      compare(requests[1].index, 200)
      // An empty answer (nothing earlier after all) stalls that boundary.
      view.toolPageReceived({action: "agent-history-page", type: "result", requestId: requests[1].requestId,
        result: {id: "fixture", epoch: "epoch", messages: [], history: {start: {index: 200, offset: 0}, end: {index: 200, offset: 0}, total: 203, revision: 1, ids: []}}})
      wheel(view, 5)
      wait(50)
      compare(requests.length, 2, "A boundary that brought nothing is not requested again")
      verify(!findChild(view, "historyStatus").visible, "No Load offer for a stalled boundary")
      // Timeouts become a retryable error, not a loop.
      view.latestHistory()
      toTop(view)
      compare(requests.length, 3)
      view.online = false
      verify(view.historyPending === "")
      view.online = true
      view.toolPageReceived(answer(requests[2], source(203)))
      verify(!view.readingHistory, "A reply after a disconnect is inert")
    }

    function test_resize_and_zoom_keep_the_reader() {
      const rows = source(500)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      toTop(view)
      view.toolPageReceived(answer(requests[0], rows))
      wheel(view, -2)
      const anchor = anchorOf(view)
      view.width = 420
      verifyAnchor(view, anchor, "narrower")
      view.zoomPercent = 160
      verifyAnchor(view, anchor, "zoomed")
      view.height = 500
      verifyAnchor(view, anchor, "shorter")
      compare(requests.length, 1, "Layout changes never request pages")
    }

    // Review round 1 (Rowan): live rows growing under an unchanged window
    // start must not push joined rows past the bound.
    function test_growth_with_same_live_start_stays_bounded() {
      const rows = []
      for (let i = 0; i < 50; i++) rows.push(row(i, "old ".repeat(750)))
      for (let i = 50; i < 250; i++) rows.push(row(i, "new ".repeat(38)))
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      for (let i = 0; i < 4 && view.hasOlder; i++) {
        toTop(view)
        view.toolPageReceived(answer(requests[requests.length - 1], rows))
        verifyResident(view, "before growth")
      }
      verify(view.historyAttached)
      const anchor = anchorOf(view)
      const beforeStart = JSON.stringify(view.liveHistory.start)
      rows[249] = row(249, "new ".repeat(7538))
      view.session = live(rows, 2)
      compare(JSON.stringify(view.liveHistory.start), beforeStart)
      verifyResident(view, "same-start live growth")
      verifyAnchor(view, anchor, "reader at the oldest rows")
      // A reader at the live end simply drops the older rows.
      view.latestHistory()
      toTop(view)
      view.toolPageReceived(answer(requests[requests.length - 1], rows))
      transcriptOf(view).positionViewAtEnd()
      view.followEnd = true
      rows[249] = row(249, "new ".repeat(15000))
      view.session = live(rows, 3)
      verifyResident(view, "growth while following")
    }

    // Review round 1: an older page that arrives after the reader went back
    // to the live end must not evict what the reader now sees.
    function test_reverse_direction_while_older_page_pending_keeps_visible_rows() {
      const rows = source(950)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      for (let i = 0; i < 2; i++) {
        toTop(view)
        view.toolPageReceived(answer(requests[requests.length - 1], rows))
        verifyResident(view, "loaded older")
      }
      compare(view.messageCount, 600)
      toTop(view)
      const pending = requests[requests.length - 1]
      toBottom(view)
      verify(waitForRendering(view))
      verify(view.followEnd)
      view.toolPageReceived(answer(pending, rows))
      verify(waitForRendering(view))
      compare(view.shownRows[view.shownRows.length - 1].message.id, "row-949", "Late older page leaves the live end alone")
      verifyResident(view, "after the late page")
      // Not following but looking at the newest rows: the page is dropped
      // rather than trimming visible rows.
      toTop(view)
      const second = requests[requests.length - 1]
      transcriptOf(view).positionViewAtEnd()
      wheel(view, 1)
      verify(!view.followEnd)
      const anchor = anchorOf(view)
      view.toolPageReceived(answer(second, rows))
      verifyAnchor(view, anchor, "late page while reading the newest rows")
      verifyResident(view, "after the dropped page")
    }

    // Review round 1: a message that grew far beyond what was loaded must not
    // be joined as if the loaded text reached the live window.
    function test_large_same_row_update_loads_the_missing_text_before_joining() {
      const rows = [row(0, "old ".repeat(1000))]
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      wheel(view, 2)
      verify(!view.followEnd)
      rows[0] = row(0, rows[0].text + "new ".repeat(24000))
      view.session = live(rows, 2)
      verify(view.liveHistory.start.offset > 4000)
      verifyResident(view, "large update")
      if (view.historyAttached) {
        compare(view.shownRows.map(entry => entry.message.text).join("").length, rows[0].text.length, "Attached text cannot skip growth")
      }
      verify(view.historyDetached, "The old text stays a snapshot")
      // Scrolling down loads the missing middle from where the loaded text ends.
      toBottom(view)
      const bridge = requests[requests.length - 1]
      compare(bridge.direction, "after")
      compare(bridge.index, 0)
      compare(bridge.offset, 4000)
      view.toolPageReceived(answer(bridge, rows, 2))
      verifyResident(view, "after the bridge")
      verify(view.historyAttached)
      compare(view.shownRows.map(entry => entry.message.text).join(""), rows[0].text, "Every unit appears exactly once")
    }

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
        view.followEnd = false
        view.loadHistory("before", view.shownHistory.start, "", false)
        view.toolPageReceived(answer(requests[0], source(210), 10))
        verify(view.readingHistory)
      }
      view.followEnd = false
      view.loadHistory("before", view.shownHistory.start, "", false)
      const pending = requests[requests.length - 1]
      view.historyError = "Old lifetime error"
      view.online = false
      // Another client closes/reopens and continues this ID while disconnected.
      view.session = fixture(210, 220, 1, "fixture", "new-epoch")
      view.online = true
      verify(!view.readingHistory, "Do not relabel old rows with the new epoch")
      compare(view.shownHistory.start.index, 210)
      compare(view.previousLive.toolEpoch, "new-epoch")
      compare(view.historyPending, "")
      compare(view.historyRequest, null)
      compare(view.historyError, "")
      compare(view.followEnd, true)
      compare(view.messageCount, 10)
      compare(findChild(view, "sessionComposer").text, "Draft survives reopening")
      view.toolPageReceived(answer(pending, source(220)))
      verify(!view.readingHistory, "Late old-epoch response is inert")
    }

    function test_tab_switch_and_moved_boundaries_drop_stale_replies() {
      const rows = source(600)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.applyDraft({id: "fixture", text: "Keep my draft", source: {title: "Fixture"}})
      verify(waitForRendering(view))
      toTop(view)
      view.session = live(source(10), 1, "other")
      view.toolPageReceived(answer(requests[0], rows))
      verify(!view.readingHistory)
      compare(view.displayedId, "other")
      compare(view.messageCount, 10)
      view.session = live(rows)
      compare(findChild(view, "sessionComposer").text, "Keep my draft")
      // A reply for a boundary the view no longer starts at is dropped.
      toTop(view)
      const stale = requests[1]
      view.latestHistory()
      toTop(view)
      view.toolPageReceived(answer(stale, rows))
      verify(!view.readingHistory, "Superseded request is inert")
      view.toolPageReceived(answer(requests[2], rows))
      verify(view.readingHistory)
      verifyResident(view, "after the current reply")
    }

    function test_refresh_reloads_from_the_visible_row() {
      const rows = source(500)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      verify(waitForRendering(view))
      toTop(view)
      view.toolPageReceived(answer(requests[0], rows))
      toTop(view)
      view.toolPageReceived(answer(requests[1], rows))
      wheel(view, -3)
      const anchor = anchorOf(view)
      rows[anchor.key.split("@")[0].slice(4) * 1] = Object.assign({}, rows[anchor.key.split("@")[0].slice(4) * 1], {text: "Edited earlier message"})
      view.refreshHistory()
      const refresh = requests[requests.length - 1]
      compare(refresh.direction, "after")
      compare("row-" + refresh.index + "@" + refresh.offset, anchor.key, "Refresh starts at the row being read")
      compare(findChild(view, "historyStatusText").text, "Refreshing messages…")
      view.toolPageReceived(answer(refresh, rows, 9))
      verifyAnchor(view, {key: anchor.key, offset: anchor.offset}, "refresh")
      compare(view.shownRows.find(entry => entry.key === anchor.key).message.text, "Edited earlier message")
      verifyResident(view, "after refresh")
    }

    function test_origin_jump_fetches_directly_and_aligns_the_group() {
      const rows = source(400)
      const view = createTemporaryObject(viewComponent, parent)
      view.session = live(rows)
      const transcript = transcriptOf(view)
      const requests = []
      view.toolPageRequested.connect(request => requests.push(request))
      view.jumpToToolGroup("row-50")
      compare(requests[0].anchor, "row-50")
      view.toolPageReceived(answer(requests[0], rows))
      tryVerify(() => findChild(view, "bubble-row-50") !== null)
      wait(30)
      const bubble = findChild(view, "bubble-row-50")
      verify(Math.abs(bubble.y - transcript.contentY) < 2)
      compare(requests.length, 1, "Source jump never expands tool details")
      verify(view.historyAttached, "The page reaches the live window and joins it")
      verifyResident(view, "origin page")
    }

    function test_oldest_page_has_no_older_offer() {
      const view = createTemporaryObject(viewComponent, parent)
      view.session = fixture(0, 20)
      verify(waitForRendering(view))
      verify(!view.hasOlder)
      verify(!findChild(view, "historyStatus").visible)
      verify(!findChild(view, "jumpToLatest").visible)
      compare(transcriptOf(view).anchors.topMargin, 0, "No toolbar reserves space")
    }

    function test_window_deltas_prune_and_order_without_losing_retained_rows() {
      const state = createTemporaryObject(stateComponent, parent)
      state.replace([fixture(200, 205)])
      const patch = fixture(202, 207, 2)
      patch.messages = patch.messages.slice(-2)
      state.update(patch)
      compare(state.sessions[0].messages.map(row => row.id).join(","), "row-202,row-203,row-204,row-205,row-206")
    }
  }
}
