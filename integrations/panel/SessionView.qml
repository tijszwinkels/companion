import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "Markdown.mjs" as Markdown
import "HistoryRows.mjs" as HistoryRows

// Chat rendering is independent of Pi and Omarchy. Stable ListModel rows keep
// selection and expanded tool bubbles intact while text deltas update a row.
Item {
  id: root
  clip: true
  required property var session
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  // Shell chrome may be monospace (Omarchy's default). Conversation text needs
  // its own proportional face so Markdown's native code font stays distinct.
  property string proseFontFamily: {
    const available = Qt.fontFamilies()
    return ["Adwaita Sans", "Inter", "Segoe UI", "Noto Sans"].find(name => available.includes(name)) || "sans-serif"
  }
  property bool online: true
  property bool paused: false
  // Hosts supply their surface color; floating controls blend it opaque.
  property color background: selection
  readonly property color overlayColor: Qt.tint(Qt.rgba(background.r, background.g, background.b, 1), selection)
  property var agentActions: ({})
  property var pendingChoice: null
  readonly property bool actionsCurrent: session !== null && agentActions.sessionId === session.id
  // The desktop host supplies the shortcut; other hosts can leave it unset.
  property string focusShortcut: ""
  property real unit: 1
  // One zoom level follows the reader between tabs for this panel lifetime.
  property int zoomPercent: 100
  property real scrollSpeed: 3
  readonly property real textScale: root.unit * root.zoomPercent / 100
  // The host can budget choices against its available area before allocating a
  // pin. Using the resulting chat height for that budget would create a layout
  // cycle: pin height -> chat height -> choices -> minimum chat -> pin height.
  property real choiceHeightLimit: Math.max(48 * root.unit, Math.min(180 * root.unit, root.height * 0.3))
  readonly property real minimumHeight: inputSection.implicitHeight + 12 * root.unit + 96 * root.textScale
  readonly property bool composerReachable: root.visible && root.width > 0 && root.height >= inputSection.height
  onComposerReachableChanged: if (!composerReachable) root.releaseComposerFocus()
  readonly property bool zoomEnabled: visible && session !== null && root.Window.window !== null && root.Window.window.active
  property string displayedId: ""
  property bool followEnd: true
  property var drafts: ({})
  // Continuous scrolling (see HistoryRows.mjs). Older rows loaded while the
  // reader scrolls are kept here, separate from the live recent window, and
  // never fed back into authoritative state. When `historyAttached`, they end
  // exactly where the live window starts and the transcript continues into
  // live rows that keep updating. Otherwise they are a detached snapshot and
  // newer rows load as the reader scrolls down. Bounded together with any
  // attached live rows by HistoryRows' resident limit.
  property var historyRows: []
  property bool historyAttached: false
  property var previousLive: null
  property string historyPending: ""
  property string historyError: ""
  property var historyRequest: null
  // The request that failed, for Retry. Failures never retry by themselves.
  property var failedHistoryRequest: null
  // Boundaries ("before:index:offset") where a page brought nothing new. They
  // are not requested again automatically, so an empty answer cannot loop.
  property var historyStalled: ({})
  // The row at the top of the viewport and its distance from the top edge,
  // restored when rows are added or removed above it, or the layout changes.
  property var readerAnchor: null
  // Resident rows mirroring the ListModel, to skip unchanged rows.
  property var shownRows: []
  // Row key -> true for tool groups the reader opened in this conversation.
  property var expandedRows: ({})
  readonly property var liveHistory: session && session.history ? session.history : null
  readonly property bool readingHistory: historyRows.length > 0
  readonly property bool historyDetached: readingHistory && !historyAttached
  readonly property var shownHistory: !liveHistory ? null
    : readingHistory ? {start: historyRows[0].start, end: historyDetached ? historyRows[historyRows.length - 1].end : liveHistory.end}
    : {start: liveHistory.start, end: liveHistory.end}
  readonly property bool hasOlder: shownHistory !== null && (shownHistory.start.index > 0 || shownHistory.start.offset > 0)
  // A detached snapshot whose conversation has changed since it was loaded.
  // Joined rows are not flagged: the revision moves with every streamed word,
  // and Refresh stays available from the conversation menu.
  readonly property bool historyChanged: historyDetached && liveHistory !== null
    && historyRows.some(row => row.revision !== liveHistory.revision)
  // Following the live end; anything else shows the Jump to latest arrow.
  readonly property bool atLatest: followEnd && !historyDetached
  // Conversation id -> title of the agent conversation that drafted its unsent
  // text. Cleared when that composer becomes empty or its message is sent.
  property var draftSources: ({})
  // Sender conversation ID -> true when an agent heading can open it.
  property var openableOrigins: ({})
  readonly property string displayedDraftSource: composer.text !== "" && root.draftSources[root.displayedId] !== undefined
    ? root.draftSources[root.displayedId] : ""
  property var pendingSubmission: null
  property string inputError: ""
  // Same bound as the listener's MAX_DIRECT_USER_MESSAGE_LENGTH. Agents may
  // draft at most 4000 characters at a time, but the combined text in this
  // composer, which the user sends, may reach this length.
  readonly property int maximumMessageLength: 8000
  property var selectedMessage: null
  property var hoveredWidget: null
  property bool widgetsRunning: true
  property bool nativeWidgets: false
  readonly property bool hasMessageSelection: selectedMessage !== null && selectedMessage.visible && selectedMessage.selectedText !== ""
  readonly property bool running: session && (session.status === "starting" || session.status === "running")
  readonly property int messageCount: messages.count
  // Manual recording into this text box (Record / Stop recording). The
  // listener reports whether it offers recording and the current recording,
  // {recordingId, sessionId, state}, or null. Recorded words are only ever
  // appended to the draft; sending stays the separate Send action.
  property bool recordingAvailable: false
  property var recording: null
  // The recording this panel started: {id, recordingId}. recordingId is ""
  // until the listener confirms the start.
  property var ownRecording: null
  property bool stopRecordingPending: false
  // A recording-finished event for this panel's recording that overtook the
  // answer to Record (the listener runs controls concurrently, so a quick
  // tab change can end the recording first). Applied when the answer names it.
  property var earlyRecordingFinish: null
  // Conversation id -> why its last recording stopped or what may be missing.
  property var recordingNotices: ({})
  readonly property bool recordingHere: ownRecording !== null && session !== null && ownRecording.id === session.id
  // "", "starting", "recording" or "finishing", for this panel's own recording.
  readonly property string recordingState: !recordingHere ? ""
    : ownRecording.recordingId !== "" && recording !== null && recording.recordingId === ownRecording.recordingId
      ? recording.state : "starting"
  // While words may still arrive in this conversation's draft, it cannot be
  // sent or closed, whichever panel started the recording.
  readonly property bool recordingBusy: session !== null
    && (recordingHere || (recording !== null && recording.sessionId === session.id))
  readonly property bool canRecord: recordingAvailable && online && session !== null
    && ownRecording === null && recording === null && pendingSubmission === null
    && composer.text.length < maximumMessageLength
  readonly property string displayedRecordingNotice: root.recordingNotices[root.displayedId] || ""
  readonly property bool canSend: online && session !== null && pendingSubmission === null
    && pendingChoice === null && !recordingBusy
    && composer.text.trim().length > 0 && composer.text.length <= maximumMessageLength
  readonly property string composerFocusId: online && composerReachable && composer.activeFocus
    && root.Window.window && root.Window.window.active ? displayedId : ""
  signal toolPageRequested(var request)
  signal toolPageReceived(var message)
  signal stopRequested(string id)
  signal dismissRequested(string id)
  signal sendRequested(string id, string text)
  signal recordRequested(string id, int draftLength)
  signal stopRecordingRequested(string id)
  signal choiceRequested(string id, string revision, int index)
  signal stopRunRequested(string id, string runId)
  signal screenshotRequested(url source, string title)
  signal originRequested(string sessionId, string groupId)

  // One request at a time. Positions come from resident rows or the live
  // window, never from typed input. Returns whether a request was sent.
  function loadHistory(direction, position, anchor, refresh) {
    if (!root.online || !root.session || !root.liveWindow() || root.historyPending) return false
    root.historyError = ""
    root.failedHistoryRequest = null
    root.historyPending = "history-" + Date.now() + "-" + Math.random().toString(36).slice(2)
    root.historyRequest = {id: root.displayedId, epoch: root.session.toolEpoch, direction: direction,
      position: {index: position.index, offset: position.offset}, anchor: anchor || "", refresh: refresh === true,
      following: root.followEnd}
    historyDeadline.restart()
    const request = {action: "agent-history-page", requestId: root.historyPending,
      id: root.displayedId, epoch: root.session.toolEpoch, direction: direction,
      index: position.index, offset: position.offset}
    if (anchor) request.anchor = anchor
    root.toolPageRequested(request)
    return true
  }

  // Only the reader's explicit Retry repeats a failed request.
  function retryHistory() {
    const failed = root.failedHistoryRequest
    if (failed) root.loadHistory(failed.direction, failed.position, failed.anchor, failed.refresh)
  }

  function historyStalledAt(direction, position) {
    return root.historyStalled[direction + ":" + HistoryRows.positionKey(position)] === true
  }

  function loadOlder() {
    if (!root.hasOlder || root.historyStalledAt("before", root.shownHistory.start)) return
    root.loadHistory("before", root.shownHistory.start, "", false)
  }

  // Scrolling down a detached snapshot: continue into the live window once the
  // rows reach it, otherwise load the next page. Rows loaded before a message
  // grew can stop short of the live start inside it; the rest then loads as
  // an ordinary page from where the loaded text really ends.
  function loadNewer() {
    if (!root.historyDetached) return
    if (HistoryRows.comparePositions(root.shownHistory.end, root.liveWindow().start) >= 0) {
      root.joinLiveWindow(root.historyRows)
      root.synchronize()
      if (!root.historyDetached) return
    }
    const end = root.shownHistory.end
    if (HistoryRows.comparePositions(end, root.liveWindow().start) >= 0 || root.historyStalledAt("after", end)) return
    root.loadHistory("after", end, "", false)
  }

  // Reload older messages from the row at the top of the viewport, replacing
  // the resident older rows with current content.
  function refreshHistory() {
    if (!root.readingHistory) return
    const top = root.topRow()
    const row = top ? root.shownRows.find(entry => entry.key === top.key) : null
    root.loadHistory("after", row && row.start ? row.start : root.historyRows[0].start, "", true)
  }

  function latestHistory() {
    root.historyPending = ""
    root.historyRequest = null
    historyDeadline.stop()
    root.historyRows = []
    root.historyAttached = false
    root.historyError = ""
    root.failedHistoryRequest = null
    root.historyStalled = ({})
    root.readerAnchor = null
    root.followEnd = true
    root.synchronize()
    transcript.positionViewAtEnd()
  }

  // The live window's position metadata. Functions read it from the session
  // itself: within onSessionChanged, the liveHistory binding may still hold
  // the previous window.
  function liveWindow() {
    return root.session && root.session.history ? root.session.history : null
  }

  // Live window rows with their positions. Listeners without paging omit
  // `history`; their rows carry no positions and never load other pages.
  function liveRows() {
    if (!root.session) return []
    if (!root.liveWindow()) {
      return root.session.messages.map(message => ({key: HistoryRows.rowKey(message), message: message, start: null, end: null, revision: 0, live: true}))
    }
    const rows = HistoryRows.rowsFrom(root.session.messages, root.liveWindow().start, root.liveWindow().revision)
    for (const row of rows) row.live = true
    return rows
  }

  // Keep older rows within the resident bound, trimming from `side`: the end
  // away from where rows were just added. Joined rows count together with the
  // live window. When the far end is the live window itself, it becomes a
  // detached copy so the oldest loaded rows the reader is looking at stay.
  // If staying in bound would remove rows the reader can see (they moved
  // while the page loaded), nothing changes and this returns false: the page
  // is dropped rather than the reader's view.
  function applyHistory(rows, attached, side) {
    const visible = root.visibleKeys()
    let reserved = attached ? HistoryRows.sizeOf(root.liveRows()) : {rows: 0, units: 0}
    if (!HistoryRows.withinBudget(rows, reserved)) {
      if (attached && side === "end") {
        rows = rows.concat(root.frozenLiveRows())
        attached = false
        reserved = {rows: 0, units: 0}
      }
      const kept = HistoryRows.trimmed(rows, side, visible, reserved)
      const dropped = side === "start" ? rows.slice(0, rows.length - kept.length) : rows.slice(kept.length)
      if (dropped.some(row => visible[row.key] === true)) return false
      rows = kept
    }
    root.historyRows = rows
    root.historyAttached = attached && rows.length > 0
    return true
  }

  // A copy of the live rows that no longer follows updates.
  function frozenLiveRows() {
    return root.liveRows().map(row => Object.assign({}, row, {live: false}))
  }

  // The current length of the row the live window starts inside, if any.
  function liveStartTotal() {
    const live = root.liveWindow()
    const first = root.session.messages[0]
    return live && live.start.offset > 0 && first && first.historyFragment ? first.historyFragment.total : 0
  }

  // Older rows that reach the live window's start continue into it: keep only
  // the part before that start (shortening a spanning fragment). Rows that
  // stop short of it stay a detached snapshot ending at their loaded text.
  function joinLiveWindow(rows) {
    const cut = HistoryRows.rowsBefore(rows, root.liveWindow().start, root.liveStartTotal())
    return root.applyHistory(cut.rows, cut.complete, "start") && cut.complete
  }

  function replaceHistory(rows) {
    const last = rows.length > 0 ? rows[rows.length - 1] : null
    if (last && HistoryRows.comparePositions(last.end, root.liveWindow().start) >= 0) root.joinLiveWindow(rows)
    else root.applyHistory(rows, false, "start")
  }

  onToolPageReceived: reply => {
    if (reply.action !== "agent-history-page" || !root.historyPending || reply.requestId !== root.historyPending) return
    const request = root.historyRequest
    root.historyPending = ""
    root.historyRequest = null
    historyDeadline.stop()
    if (!root.session || request.id !== root.displayedId || request.epoch !== root.session.toolEpoch || !root.liveHistory) return
    if (reply.type === "error") {
      root.historyError = reply.message || "History unavailable"
      root.failedHistoryRequest = request
      return
    }
    const page = reply.result
    if (!page || page.id !== request.id || page.epoch !== request.epoch || !page.history) return
    const rows = HistoryRows.rowsFrom(page.messages || [], page.history.start, page.history.revision)
    const boundary = request.position
    const stall = request.direction + ":" + HistoryRows.positionKey(boundary)

    if (request.anchor || request.refresh) {
      root.historyStalled = ({})
      root.followEnd = false
      root.replaceHistory(rows)
      root.synchronize()
      if (request.anchor) {
        Qt.callLater(function() {
          if (root.displayedId === request.id) root.jumpToToolGroup(request.anchor)
        })
      }
      return
    }

    // Only join a page that ends (or starts) exactly where the transcript now
    // starts (or ends). Anything else answers a superseded view: drop it.
    if (request.direction === "before") {
      if (!HistoryRows.samePosition(page.history.end, boundary) || !root.shownHistory
          || !HistoryRows.samePosition(root.shownHistory.start, boundary)) return
      if (rows.length === 0) {
        root.historyStalled = Object.assign({}, root.historyStalled, {[stall]: true})
        return
      }
      // A reader who scrolled up for it and has since returned to the live
      // end no longer wants it. (Short content is always at the live end;
      // its explicit Load still applies.)
      if (!request.following && root.followEnd && !root.historyDetached) return
      if (!root.applyHistory(rows.concat(root.historyRows), root.readingHistory ? root.historyAttached : true, "end")) return
    } else {
      if (!root.historyDetached || !HistoryRows.samePosition(page.history.start, boundary)
          || !HistoryRows.samePosition(root.shownHistory.end, boundary)) return
      if (rows.length === 0) root.historyStalled = Object.assign({}, root.historyStalled, {[stall]: true})
      else if (!root.applyHistory(root.historyRows.concat(rows), false, "start")) return
      if (root.historyDetached && HistoryRows.comparePositions(root.shownHistory.end, root.liveHistory.start) >= 0) {
        root.joinLiveWindow(root.historyRows)
      }
    }
    root.synchronize()
  }

  Timer {
    id: historyDeadline
    interval: 10000
    onTriggered: {
      root.failedHistoryRequest = root.historyRequest
      root.historyPending = ""
      root.historyRequest = null
      root.historyError = "History request timed out."
    }
  }

  function zoomBy(amount) { root.zoomPercent = Math.max(80, Math.min(200, root.zoomPercent + amount)) }

  function clearMessageSelection() {
    const previous = root.selectedMessage
    root.selectedMessage = null
    if (previous) previous.deselect()
  }

  function messageSelectionChanged(item) {
    if (item.selectedText !== "") {
      if (root.selectedMessage !== item) root.clearMessageSelection()
      root.selectedMessage = item
      composer.deselect()
    } else if (root.selectedMessage === item) {
      root.selectedMessage = null
    }
  }

  function copySelectedMessage() {
    if (!root.hasMessageSelection) return false
    root.selectedMessage.copy()
    return true
  }

  // A hidden plain-text buffer copies a whole message without moving keyboard
  // focus or disturbing the reader's selection. Assistant copies keep Markdown.
  TextEdit { id: copyBuffer; visible: false; textFormat: TextEdit.PlainText }
  function copyMessage(text) {
    copyBuffer.text = text
    copyBuffer.selectAll()
    copyBuffer.copy()
    copyBuffer.text = ""
  }

  // Window shortcuts also work while text is selected or the composer owns
  // focus. They never register with the compositor or affect other apps.
  Shortcut {
    sequences: [StandardKey.Copy]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled && root.hasMessageSelection
    onActivated: root.copySelectedMessage()
  }
  Shortcut {
    sequences: ["Ctrl++", "Ctrl+=", "Ctrl+Shift++"]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(10)
  }
  Shortcut {
    sequence: "Ctrl+-"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(-10)
  }
  Shortcut {
    sequence: "Ctrl+0"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomPercent = 100
  }

  function focusComposer() {
    if (root.online && root.composerReachable && root.session) composer.forceActiveFocus(Qt.ShortcutFocusReason)
  }

  function releaseComposerFocus() { composer.focus = false }

  function submit() {
    if (!root.canSend) return
    root.inputError = ""
    root.pendingSubmission = {id: root.session.id, text: composer.text}
    root.sendRequested(root.session.id, composer.text)
  }

  function submitted(id, text, error) {
    if (!root.pendingSubmission || root.pendingSubmission.id !== id || root.pendingSubmission.text !== text) return
    root.pendingSubmission = null
    root.inputError = error || ""
    if (!error) {
      root.setRecordingNotice(id, "")
      if (root.drafts[id] === text) {
        delete root.drafts[id]
        root.forgetDraftSource(id)
      }
      if (root.displayedId === id && composer.text === text) composer.text = ""
    }
  }

  function setRecordingNotice(id, text) {
    if ((root.recordingNotices[id] || "") === text) return
    const notices = Object.assign({}, root.recordingNotices)
    if (text) notices[id] = text
    else delete notices[id]
    root.recordingNotices = notices
  }

  // Record starts a recording for the displayed conversation; while it runs,
  // the same button stops it. Stopping keeps the final words: they are still
  // transcribed and added while the button says "Finishing transcription…".
  function toggleRecording() {
    if (root.recordingHere) {
      if (root.recordingState === "finishing" || root.stopRecordingPending || root.ownRecording.recordingId === "") return
      root.stopRecordingPending = true
      root.stopRecordingRequested(root.ownRecording.id)
      return
    }
    if (!root.canRecord) return
    root.inputError = ""
    root.setRecordingNotice(root.session.id, "")
    root.ownRecording = {id: root.session.id, recordingId: ""}
    root.recordRequested(root.session.id, composer.text.length)
  }

  // The listener's answer to Record: a recording ID, or a refusal.
  function recordingStarted(id, recordingId, error) {
    if (!root.ownRecording || root.ownRecording.id !== id || root.ownRecording.recordingId !== "") return
    const early = root.earlyRecordingFinish
    root.earlyRecordingFinish = null
    if (error || !recordingId) {
      root.ownRecording = null
      if (root.displayedId === id) root.inputError = error || "Recording did not start."
      return
    }
    root.ownRecording = {id: id, recordingId: recordingId}
    if (early && early.recordingId === recordingId) root.recordingFinished(early)
  }

  function recordingStopAnswered(error) {
    root.stopRecordingPending = false
    const own = root.ownRecording
    if (!error || !own) return
    // The listener no longer has this recording (its end was missed): stop
    // showing it rather than leaving Send and Close disabled.
    if (own.recordingId !== "" && !(root.recording && root.recording.recordingId === own.recordingId)) {
      root.ownRecording = null
      root.setRecordingNotice(own.id, "Recording had already ended. Check the text: some speech may be missing.")
      return
    }
    if (root.displayedId === own.id) root.inputError = error
  }

  // A transcript chunk from this panel's recording. Appended at the end of
  // that conversation's draft, after anything already there (including the
  // user's edits), whether or not its tab is displayed. Runs synchronously,
  // so no keystroke interleaves between reading and writing the draft.
  // Returns the resulting length so the listener can stop at the Send limit;
  // text is never cut here.
  function appendRecording(request) {
    const own = root.ownRecording
    if (!own || own.id !== request.id || own.recordingId === "" || own.recordingId !== request.recordingId) {
      return {outcome: "unavailable", reason: "This panel is not recording into that conversation."}
    }
    const displayed = root.displayedId === request.id
    const current = displayed ? composer.text : (root.drafts[request.id] || "")
    const separator = current === "" || /\s$/.test(current) ? "" : " "
    const addition = separator + request.text
    if (displayed) composer.insert(composer.length, addition)
    else root.drafts[request.id] = current + addition
    return {outcome: "appended", length: current.length + addition.length}
  }

  function recordingFinished(message) {
    const own = root.ownRecording
    if (own && own.recordingId === "" && own.id === message.id) {
      root.earlyRecordingFinish = message
      return
    }
    if (!own || own.recordingId === "" || own.recordingId !== message.recordingId) return
    root.ownRecording = null
    root.stopRecordingPending = false
    // Always warn when speech may be missing, whatever the reason says.
    const notice = message.message || (message.complete === false
      ? "Recording stopped. Some speech may be missing; check the text." : "")
    root.setRecordingNotice(own.id, notice)
  }

  // The listener abandons a recording when its panel disconnects.
  function recordingDisconnected() {
    const own = root.ownRecording
    root.stopRecordingPending = false
    root.earlyRecordingFinish = null
    if (!own) return
    root.ownRecording = null
    root.setRecordingNotice(own.id, "Recording stopped because Companion disconnected. Some speech may be missing.")
  }

  function forgetDraftSource(id) {
    if (root.draftSources[id] === undefined) return
    const sources = Object.assign({}, root.draftSources)
    delete sources[id]
    root.draftSources = sources
  }

  // An agent proposes unsent text. It never submits, and never replaces or
  // edits text the user already wrote: that is a conflict unless the agent
  // explicitly asked to append below it. Returns the outcome the listener
  // reports back to the agent. Runs synchronously in the UI event loop, so no
  // keystroke can interleave between reading and writing the composer.
  function applyDraft(request) {
    const id = request.id
    if (root.pendingSubmission && root.pendingSubmission.id === id) {
      return {outcome: "conflict", reason: "A message from that conversation's input is still being sent."}
    }

    const displayed = root.displayedId === id
    const current = displayed ? composer.text : (root.drafts[id] || "")
    let next = request.text
    let outcome = "inserted"
    if (current.trim() !== "") {
      if (request.ifDraftExists !== "append") return {outcome: "conflict", reason: ""}
      next = current + (current.endsWith("\n") ? "\n" : "\n\n") + request.text
      outcome = "appended"
    }
    if (next.length > root.maximumMessageLength) {
      return {outcome: "conflict", reason: "The combined draft would exceed " + root.maximumMessageLength + " characters."}
    }

    const title = request.source && typeof request.source.title === "string" ? request.source.title : ""
    root.draftSources = Object.assign({}, root.draftSources, {[id]: (request.source && request.source.kind === "external" ? "external (unverified) · " : "") + (title || "another conversation")})
    if (displayed) {
      composer.text = next
      composer.cursorPosition = composer.length
    } else {
      root.drafts[id] = next
    }
    return {outcome: outcome, reason: ""}
  }

  function choiceSubmitted(id, revision, index, error) {
    if (!root.pendingChoice || root.pendingChoice.id !== id || root.pendingChoice.revision !== revision || root.pendingChoice.index !== index) return
    root.pendingChoice = null
    if (root.displayedId === id) root.inputError = error || ""
    // Choosing never edits or clears a freeform draft, including on failure.
  }

  function enterPressed(event) {
    event.accepted = true
    if (event.modifiers & Qt.ShiftModifier) {
      composer.insert(composer.cursorPosition, "\n")
    } else {
      root.submit()
    }
  }

  function followLatestMessage() {
    if (root.followEnd) {
      transcript.positionViewAtEnd()
    }
  }

  // The sender's tool call may be one of several in a collapsed group. Bring
  // that group into view without opening tool details or changing the composer.
  // Align its top edge: an expanded group can be taller than the viewport, and
  // centring it would push the heading being navigated to out of sight.
  function jumpToToolGroup(groupId) {
    const sessionId = root.displayedId
    if (!sessionId || !groupId) return
    for (let index = 0; index < messages.count; index++) {
      if (messages.get(index).messageId !== groupId) continue
      root.followEnd = false
      transcript.positionViewAtIndex(index, ListView.Beginning)
      root.readerAnchor = root.topRow()
      // Delegate layout can change heights; settle the scroll position once more.
      Qt.callLater(function() {
        if (root.displayedId !== sessionId) return
        transcript.positionViewAtIndex(index, ListView.Beginning)
        root.readerAnchor = root.topRow()
      })
      return
    }
    root.loadHistory("after", {index: 0, offset: 0}, groupId, false)
  }

  // The reader's own scrolling (wheel, drag, flick, scroll bar). Layout,
  // resizing and live updates never call this, so short content, errors and
  // empty pages cannot start a request loop. Loads begin within one viewport
  // of an edge in the direction the reader is moving.
  function readerScrolled(towardOlder) {
    root.followEnd = transcript.atYEnd && !root.historyDetached
    root.readerAnchor = root.followEnd ? null : root.topRow()
    if (root.historyPending || root.historyError !== "" || !root.online || !root.liveWindow()) return
    const reach = Math.max(transcript.height, 160 * root.unit)
    const fromTop = transcript.contentY - transcript.originY
    const fromBottom = transcript.originY + transcript.contentHeight - transcript.height - transcript.contentY
    if (towardOlder && fromTop <= reach) root.loadOlder()
    else if (!towardOlder && fromBottom <= reach) root.loadNewer()
  }

  // The row at the viewport's top edge and its offset from that edge. The
  // second probe covers the gap between two bubbles.
  function topRow() {
    let index = transcript.indexAt(transcript.width / 2, transcript.contentY + 1)
    if (index < 0) index = transcript.indexAt(transcript.width / 2, transcript.contentY + transcript.spacing + 1)
    const item = index >= 0 && index < root.shownRows.length ? transcript.itemAtIndex(index) : null
    return item ? {key: root.shownRows[index].key, offset: item.y - transcript.contentY} : null
  }

  // Keys of rows the reader can currently see; trimming spares them.
  function visibleKeys() {
    const keys = {}
    const top = transcript.contentY
    const bottom = top + transcript.height
    for (let index = 0; index < root.shownRows.length; index++) {
      const item = transcript.itemAtIndex(index)
      if (item && item.y + item.height > top && item.y < bottom) keys[root.shownRows[index].key] = true
    }
    return keys
  }

  // Put the anchored row back at its offset from the viewport's top edge.
  function restoreAnchor(anchor) {
    if (!anchor || root.followEnd) return
    const index = root.shownRows.findIndex(row => row.key === anchor.key)
    if (index < 0) return
    transcript.forceLayout()
    let item = transcript.itemAtIndex(index)
    if (!item) {
      transcript.positionViewAtIndex(index, ListView.Beginning)
      item = transcript.itemAtIndex(index)
    }
    if (!item) return
    const beginning = transcript.originY
    const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
    const target = Math.max(beginning, Math.min(end, item.y - anchor.offset))
    if (Math.abs(transcript.contentY - target) >= 0.5) transcript.contentY = target
  }

  function restoreReaderAnchor() {
    if (!root.followEnd && root.readerAnchor) root.restoreAnchor(root.readerAnchor)
  }

  function setExpanded(key, expanded) {
    const rows = Object.assign({}, root.expandedRows)
    if (expanded) rows[key] = true
    else delete rows[key]
    root.expandedRows = rows
  }

  function rowData(row) {
    const message = row.message
    return {rowKey: row.key, messageId: message.id, kind: message.kind, body: message.text,
      toolName: message.toolName, input: message.input, state: message.state,
      toolCount: message.toolGroup ? message.toolGroup.count : 0,
      toolUnavailable: message.toolGroup ? message.toolGroup.unavailable === true : false,
      toolRevision: message.toolGroup ? message.toolGroup.revision : "",
      screenshot: message.screenshot, screenshotUrl: message.screenshotUrl || "",
      // False only when capture storage deliberately did not save it.
      screenshotNotSaved: message.screenshotSaved === false,
      fromWake: message.origin ? message.origin.kind === "scheduled-wake" : false,
      fromExternal: message.origin ? message.origin.kind === "external" : false,
      fromAgent: message.origin !== undefined && message.origin !== null,
      originTitle: message.origin ? message.origin.title || "" : "",
      // External origins carry unverified labels, never a linkable conversation.
      originSessionId: message.origin && message.origin.kind === "agent" ? message.origin.sessionId || "" : "",
      originGroupId: message.origin && message.origin.kind === "agent" ? message.origin.sourceGroupId || "" : "",
      fragmentLabel: message.historyFragment ? " · text " + (message.historyFragment.start + 1) + "–" + message.historyFragment.end + " of " + message.historyFragment.total : "",
      widgetJson: message.widget ? JSON.stringify(message.widget) : ""}
  }

  // Bring the ListModel to `rows` in place: remove rows that left in runs,
  // then insert, move or update in order. Unchanged rows keep their delegates
  // (and expanded tool groups) and are not rewritten.
  function reconcile(rows) {
    const shown = root.shownRows.slice()
    const wanted = {}
    for (const row of rows) wanted[row.key] = true

    let last = shown.length - 1
    while (last >= 0) {
      if (wanted[shown[last].key] === true) {
        last--
        continue
      }
      let first = last
      while (first > 0 && wanted[shown[first - 1].key] !== true) first--
      messages.remove(first, last - first + 1)
      shown.splice(first, last - first + 1)
      last = first - 1
    }

    // Every remaining shown row is wanted, so the loop below never meets a
    // stale row; rows not yet shown are inserted.
    const present = {}
    for (const entry of shown) present[entry.key] = true
    let index = 0
    while (index < rows.length) {
      const row = rows[index]
      if (index < shown.length && shown[index].key === row.key) {
        // Older rows are immutable page snapshots; live rows are rewritten
        // because a listener update may reuse a changed message object.
        if (row.live === true || shown[index].message !== row.message) messages.set(index, root.rowData(row))
        shown[index] = row
        index++
        continue
      }
      if (present[row.key] === true) {
        const existing = shown.findIndex((entry, position) => position > index && entry.key === row.key)
        messages.move(existing, index, 1)
        shown.splice(index, 0, shown.splice(existing, 1)[0])
        continue
      }
      // Insert a run of new rows at once, e.g. a whole older page.
      let end = index + 1
      while (end < rows.length && present[rows[end].key] !== true) end++
      messages.insert(index, rows.slice(index, end).map(root.rowData))
      shown.splice(index, 0, ...rows.slice(index, end))
      index = end
    }
    while (messages.count > rows.length) messages.remove(rows.length, messages.count - rows.length)
    shown.length = rows.length
    root.shownRows = shown
    // Forget open groups that are no longer resident.
    if (Object.keys(root.expandedRows).some(key => wanted[key] !== true)) {
      const open = {}
      for (const key of Object.keys(root.expandedRows)) if (wanted[key] === true) open[key] = true
      root.expandedRows = open
    }
  }

  // The recent window slides forward as rows arrive. While the reader is away
  // from the live end, the rows it drops stay resident and joined, so nothing
  // the reader sees moves. If that cannot stay contiguous and bounded without
  // removing visible rows, the view becomes a detached snapshot instead.
  function keepEvictedRows() {
    const previous = root.previousLive
    const current = root.liveWindow()
    if (!previous || !previous.history || !current || previous.id !== root.session.id
        || previous.toolEpoch !== root.session.toolEpoch) return
    if (HistoryRows.samePosition(previous.history.start, current.start) || root.historyDetached) return
    if (root.followEnd) {
      root.historyRows = []
      root.historyAttached = false
      return
    }
    const previousRows = HistoryRows.rowsFrom(previous.messages, previous.history.start, previous.history.revision)
    // Joined older rows end where the previous window started.
    const joined = root.historyRows.concat(previousRows)
    const cut = HistoryRows.rowsBefore(joined, current.start, root.liveStartTotal())
    const kept = cut.rows
    const contiguous = !cut.complete ? false : kept.length === 0
      ? HistoryRows.comparePositions(current.start, joined.length > 0 ? joined[0].start : current.start) <= 0
      : HistoryRows.samePosition(kept[kept.length - 1].end, current.start)
    const visible = root.visibleKeys()
    if (contiguous) {
      const rows = HistoryRows.trimmed(kept, "start", visible, HistoryRows.sizeOf(root.liveRows()))
      const dropped = kept.slice(0, kept.length - rows.length)
      if (!dropped.some(row => visible[row.key] === true)) {
        root.historyRows = rows
        root.historyAttached = rows.length > 0
        return
      }
    }
    root.historyRows = HistoryRows.trimmed(joined, "end", visible, {rows: 0, units: 0})
    root.historyAttached = false
  }

  // Live rows can also grow without the window moving (a long answer still
  // streaming). Joined older rows then give way from the oldest end; if the
  // reader is looking at those, the view becomes a detached snapshot instead.
  function keepWithinBound() {
    if (!root.historyAttached || root.historyRows.length === 0) return
    const live = HistoryRows.sizeOf(root.liveRows())
    if (HistoryRows.withinBudget(root.historyRows, live)) return
    if (root.followEnd) {
      root.historyRows = []
      root.historyAttached = false
      return
    }
    const visible = root.visibleKeys()
    const kept = HistoryRows.trimmed(root.historyRows, "start", visible, live)
    const dropped = root.historyRows.slice(0, root.historyRows.length - kept.length)
    if (!dropped.some(row => visible[row.key] === true)) {
      root.historyRows = kept
      root.historyAttached = kept.length > 0
      return
    }
    root.historyRows = HistoryRows.trimmed(root.historyRows.concat(root.frozenLiveRows()), "end", visible, {rows: 0, units: 0})
    root.historyAttached = false
  }

  function synchronize() {
    const id = root.session ? root.session.id : ""
    if (id !== root.displayedId) {
      root.clearMessageSelection()
      if (root.displayedId) root.drafts[root.displayedId] = composer.text
      messages.clear()
      root.shownRows = []
      root.resetHistory()
      root.displayedId = id
      composer.text = root.drafts[id] || ""
      root.inputError = ""
    }

    if (root.previousLive && root.session && root.previousLive.toolEpoch !== root.session.toolEpoch) {
      // A reconnect can reveal the same ID reopened by another client. Never
      // keep rows from the old lifetime under its successor's page token.
      root.clearMessageSelection()
      root.resetHistory()
    }
    const anchor = root.followEnd ? null : root.topRow()
    root.keepEvictedRows()
    root.keepWithinBound()
    root.previousLive = root.session
    const live = root.liveRows()
    const rows = !root.readingHistory ? live : root.historyAttached ? root.historyRows.concat(live) : root.historyRows
    root.reconcile(rows)
    if (anchor) {
      root.readerAnchor = anchor
      root.restoreAnchor(anchor)
      Qt.callLater(root.restoreReaderAnchor)
    }
    Qt.callLater(root.followLatestMessage)
  }

  function resetHistory() {
    root.expandedRows = ({})
    root.historyRows = []
    root.historyAttached = false
    root.previousLive = null
    root.historyPending = ""
    root.historyRequest = null
    root.historyError = ""
    root.failedHistoryRequest = null
    root.historyStalled = ({})
    root.readerAnchor = null
    root.followEnd = true
    historyDeadline.stop()
  }

  onSessionChanged: synchronize()
  onOnlineChanged: {
    if (!root.online) {
      root.historyPending = ""
      root.historyRequest = null
      historyDeadline.stop()
    }
  }
  onVisibleChanged: Qt.callLater(root.followLatestMessage)
  // Text zoom and width change every bubble's height: keep the reader's row.
  onTextScaleChanged: Qt.callLater(root.restoreReaderAnchor)
  onWidthChanged: Qt.callLater(root.restoreReaderAnchor)
  Component.onCompleted: synchronize()
  ListModel { id: messages }

  ListView {
    id: transcript
    objectName: "sessionTranscript"
    anchors.fill: parent
    anchors.bottomMargin: inputSection.height + 12 * root.unit
    clip: true
    spacing: 12 * root.unit
    model: messages
    boundsBehavior: Flickable.StopAtBounds
    property real readerY: 0
    onMovementEnded: root.followEnd = atYEnd && !root.historyDetached
    // Dragging, flicking and the scroll bar; wheel input is handled below.
    onContentYChanged: {
      if (moving || transcriptBar.pressed) root.readerScrolled(contentY < readerY)
      readerY = contentY
    }
    onContentHeightChanged: Qt.callLater(root.followLatestMessage)
    onHeightChanged: {
      Qt.callLater(root.followLatestMessage)
      Qt.callLater(root.restoreReaderAnchor)
    }

    // Handle the transcript's wheel events before selectable message text.
    // Pixel deltas retain precise touchpad motion; wheel notches use the
    // desktop's line count. Both are faster without changing shell-wide input.
    WheelHandler {
      parent: transcript
      target: null
      acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
      onWheel: event => {
        if (root.hoveredWidget && root.hoveredWidget.hovered) { event.accepted = false; return }
        const pixels = event.pixelDelta.y || event.angleDelta.y / 120 * Qt.styleHints.wheelScrollLines * 24 * root.unit
        if (pixels === 0) {
          event.accepted = false
          return
        }

        transcript.cancelFlick()
        root.followEnd = false
        const beginning = transcript.originY
        const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
        transcript.contentY = Math.max(beginning, Math.min(end, transcript.contentY - pixels * root.scrollSpeed))
        // Changing contentY directly does not emit movementEnded. Update the
        // live-following state now, before a queued streaming update can jump
        // back to the bottom, and load further history near an edge.
        root.readerScrolled(pixels > 0)
        event.accepted = true
      }
    }

    ScrollBar.vertical: ScrollBar {
      id: transcriptBar
      visible: transcript.contentHeight > transcript.height
      contentItem: Rectangle { color: root.muted; radius: 2; implicitWidth: 4 }
    }

    delegate: Item {
      id: bubble
      required property string messageId
      required property string kind
      required property string body
      required property string toolName
      required property string input
      required property string state
      required property bool screenshot
      required property string screenshotUrl
      required property bool screenshotNotSaved
      required property bool toolUnavailable
      required property int toolCount
      required property string toolRevision
      required property string widgetJson
      required property string fragmentLabel
      // Written by another conversation's agent through session tools.
      required property bool fromExternal
      required property bool fromAgent
      required property bool fromWake
      required property string originTitle
      required property string originSessionId
      required property string originGroupId
      readonly property bool originLinked: fromAgent && originSessionId !== ""
        && root.openableOrigins[originSessionId] === true
      readonly property var widget: widgetJson ? JSON.parse(widgetJson) : null
      required property string rowKey
      // Kept by the view per resident row, so an open group stays open when
      // its delegate is recreated (e.g. a page joins above it). Cleared with
      // the conversation or its lifetime; never part of the transcript.
      readonly property bool expanded: root.expandedRows[rowKey] === true
      objectName: "bubble-" + messageId
      width: transcript.width
      height: bubbleSurface.height

      // A tool heading discloses its calls; a linked agent heading navigates.
      function activateHeading() {
        if (bubble.kind === "tool") {
          bubble.toggleExpanded()
        } else if (bubble.originLinked) {
          root.originRequested(bubble.originSessionId, bubble.originGroupId)
        }
      }

      function toggleExpanded() {
        // Keep the visible answer in place when a group above or crossing the
        // viewport's top edge shrinks. Never anchor to the shrinking group.
        let anchor = null
        if (expanded && toolCount > 0 && !root.followEnd && y < transcript.contentY) {
          const anchorTop = Math.max(transcript.contentY, y + height)
          let index = transcript.indexAt(0, anchorTop + 1)
          if (index < 0) index = transcript.indexAt(0, anchorTop + transcript.spacing + 1)
          anchor = transcript.itemAtIndex(index)
          if (anchor && anchor.y >= transcript.contentY + transcript.height) anchor = null
        }
        const anchorY = anchor ? anchor.y - transcript.contentY : 0
        root.setExpanded(rowKey, !expanded)
        if (anchor) {
          // Settle the Column before ListView computes the new content origin.
          contents.forceLayout()
          transcript.forceLayout()
          const beginning = transcript.originY
          const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
          transcript.contentY = Math.max(beginning, Math.min(end, anchor.y - anchorY))
        }
      }

      Rectangle {
        id: bubbleSurface
        // Keep a subtle 20px gutter opposite the sender, plus 8px for the
        // scrollbar. The full-width row lets ListView position messages vertically
        // without overriding each bubble's horizontal alignment.
        width: Math.max(0, transcript.width - 28 * root.unit)
        x: bubble.kind === "user" ? transcript.width - 8 * root.unit - width : 0
        height: contents.implicitHeight + 20 * root.unit
        radius: 10 * root.unit
        color: bubble.kind === "user" ? root.selection
          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)

        HoverHandler { id: messageHover }

        Column {
          id: contents
          x: 10 * root.unit
          y: 10 * root.unit
          width: parent.width - 20 * root.unit
          spacing: 8 * root.unit

          Text {
            id: heading
            objectName: "messageHeading"
            width: parent.width - copyButton.width - 8 * root.unit
            height: Math.max(implicitHeight, copyButton.height)
            verticalAlignment: Text.AlignVCenter
            text: bubble.kind === "tool" ? (bubble.expanded ? "▾ " : "▸ ") + (bubble.toolCount ? bubble.toolCount + " tool call" + (bubble.toolCount === 1 ? "" : "s") : bubble.toolName)
              + (bubble.toolUnavailable ? " · details unavailable" : bubble.state === "running" ? " · running" : bubble.state === "error" ? " · failed or stopped" : "")
              : bubble.kind === "user" ? (bubble.fromAgent ? (bubble.fromWake ? "Scheduled wake · " : bubble.fromExternal ? "External agent (unverified) · " : "Agent · ") + (bubble.originTitle || "another conversation") : "You")
                + (bubble.state === "queued" ? " · queued" : bubble.state === "error" ? " · not sent" : "")
                + (bubble.screenshot ? (bubble.screenshotUrl ? " · screenshot attached" : bubble.screenshotNotSaved ? " · screenshot not saved" : " · screenshot unavailable") : "") + bubble.fragmentLabel : "Pi" + bubble.fragmentLabel
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: bubble.originLinked ? root.accent
              : bubble.state === "error" ? "#ef5350" : root.muted
            font.underline: bubble.originLinked && headingMouse.containsMouse
            font.family: root.fontFamily
            font.pixelSize: 10 * root.unit

            MouseArea {
              anchors.fill: parent
              id: headingMouse
              hoverEnabled: true
              enabled: bubble.kind === "tool" || bubble.originLinked
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: bubble.activateHeading()
            }
            Accessible.role: headingMouse.enabled ? Accessible.Button : Accessible.StaticText
            Accessible.name: text
            Accessible.description: bubble.originLinked ? "Opens the source conversation" : ""
            Accessible.onPressAction: bubble.activateHeading()
          }

          Rectangle {
            objectName: "screenshotThumbnail"
            visible: bubble.kind === "user" && bubble.screenshot && bubble.screenshotUrl !== ""
            width: parent.width
            height: visible ? 132 * root.unit : 0
            radius: 6 * root.unit
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
            border.color: thumbnailHover.containsMouse ? root.accent : "transparent"
            Image {
              id: thumbnail
              anchors.fill: parent
              anchors.margins: 6 * root.unit
              source: parent.visible ? bubble.screenshotUrl : ""
              sourceSize.width: 600
              asynchronous: true
              fillMode: Image.PreserveAspectFit
            }
            Rectangle {
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              anchors.margins: 8 * root.unit
              width: zoomLabel.width + 16 * root.unit
              height: 24 * root.unit
              radius: 12 * root.unit
              color: root.selection
              Text {
                id: zoomLabel
                anchors.centerIn: parent
                text: thumbnail.status === Image.Error ? "Screenshot unavailable" : "↗  Enlarge"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 10 * root.unit
              }
            }
            MouseArea {
              id: thumbnailHover
              anchors.fill: parent
              hoverEnabled: true
              enabled: thumbnail.status === Image.Ready
              cursorShape: Qt.PointingHandCursor
              onClicked: root.screenshotRequested(bubble.screenshotUrl, root.session.title)
            }
            Accessible.role: Accessible.Button
            Accessible.name: "Enlarge attached screenshot"
            Accessible.onPressAction: if (thumbnail.status === Image.Ready) root.screenshotRequested(bubble.screenshotUrl, root.session.title)
          }

          WidgetSurface {
            id: widgetView
            nativeRendering: root.nativeWidgets
            objectName: "inlineWidget"
            visible: bubble.widget !== null && bubble.widget.presentation.placement === "inline" && viewUrl !== ""
            width: parent.width
            height: visible ? preferredHeight : 0
            reference: bubble.widget
            summary: bubble.body
            foreground: root.foreground
            muted: root.muted
            accent: root.accent
            selection: root.selection
            fontFamily: root.proseFontFamily
            unit: root.unit
            textScale: root.textScale
            // ListView can retain offscreen delegates. Stop frame polling there
            // and while the desktop panel is hidden, without losing widget state.
            running: visible && root.widgetsRunning && bubble.y + bubble.height >= transcript.contentY
              && bubble.y <= transcript.contentY + transcript.height
            onInteractionStarted: root.clearMessageSelection()
            onHoveredChanged: {
              if (hovered) root.hoveredWidget = widgetView
              else if (root.hoveredWidget === widgetView) root.hoveredWidget = null
            }
            Component.onDestruction: if (root.hoveredWidget === widgetView) root.hoveredWidget = null
          }

          Loader {
            width: parent.width
            active: bubble.expanded && bubble.toolCount > 0
            // Unloading destroys the reader but can retain its previous size.
            // Release both its height and the Column spacing when collapsed.
            visible: active
            height: active ? implicitHeight : 0
            sourceComponent: ToolDetails {
              reader: root
              sessionId: root.displayedId
              epoch: root.session ? root.session.toolEpoch || "" : ""
              groupId: bubble.messageId
              revision: bubble.toolRevision
              count: bubble.toolCount
            }
          }

          TextEdit {
            id: messageText
            objectName: "messageText"
            width: parent.width
            height: visible ? contentHeight : 0
            visible: !bubble.toolCount && (bubble.kind !== "tool" || bubble.expanded)
              && (!widgetView.visible || !widgetView.rendered || widgetView.error !== "")
            text: bubble.kind === "assistant" ? Markdown.render(bubble.body, root.textScale, root.selection.toString(), root.accent.toString())
              : bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
            textFormat: bubble.kind === "assistant" ? TextEdit.RichText : TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            activeFocusOnPress: false
            onSelectedTextChanged: root.messageSelectionChanged(messageText)
            Component.onDestruction: if (root.selectedMessage === messageText) root.selectedMessage = null
            onVisibleChanged: if (!visible && root.selectedMessage === messageText) root.clearMessageSelection()
            wrapMode: TextEdit.Wrap
            color: root.foreground
            selectionColor: root.selection
            selectedTextColor: root.foreground
            font.family: bubble.kind === "tool" ? "monospace" : root.proseFontFamily
            font.pixelSize: (bubble.kind === "tool" ? 14 : 16) * root.textScale
            onLinkActivated: link => {
              // Opening a link is an explicit click; commands and file URLs do
              // not become executable UI actions through generated Markdown.
              if (/^https?:\/\//i.test(link)) Qt.openUrlExternally(link)
            }
          }
        }

        Rectangle {
          id: copyButton
          objectName: "copyMessage"
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: 10 * root.unit
          width: 58 * root.unit
          height: 24 * root.unit
          radius: 4 * root.unit
          color: root.selection
          opacity: messageHover.hovered || copyMouse.containsMouse || copied.running ? 1 : 0
          visible: !bubble.toolCount && messageText.text !== ""
          Behavior on opacity { NumberAnimation { duration: 120 } }
          function activate() {
            const source = bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
            root.copyMessage(source)
            copied.restart()
          }
          Timer { id: copied; interval: 1400 }
          Text {
            anchors.centerIn: parent
            text: copied.running ? "Copied" : "Copy"
            color: copyMouse.containsMouse || copied.running ? root.accent : root.foreground
            font.family: root.proseFontFamily
            font.pixelSize: 11 * root.unit
          }
          MouseArea {
            id: copyMouse
            anchors.fill: parent
            hoverEnabled: true
            enabled: copyButton.opacity > 0.5
            cursorShape: Qt.PointingHandCursor
            onClicked: copyButton.activate()
          }
          Accessible.role: Accessible.Button
          Accessible.name: "Copy message"
          Accessible.onPressAction: activate()
        }
      }
    }

    footer: Text {
      width: transcript.width - 8 * root.unit
      text: root.session && root.session.error ? root.session.error : ""
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  // Loading, failure and out-of-date notices float over the transcript edge
  // they concern. They appear only when relevant and never reserve a row.
  Rectangle {
    id: historyStatus
    objectName: "historyStatus"
    readonly property var request: root.historyPending !== "" ? root.historyRequest : root.historyError !== "" ? root.failedHistoryRequest : null
    readonly property bool newer: request !== null && request.direction === "after" && !request.refresh && request.anchor === ""
    // Content too short to scroll cannot reach an edge by scrolling.
    readonly property bool offerOlder: root.hasOlder && root.online && transcript.contentHeight <= transcript.height
      && !root.historyStalledAt("before", root.shownHistory.start)
    readonly property string message: root.historyPending !== "" && request !== null
      ? (request.refresh ? "Refreshing messages…" : request.anchor !== "" ? "Loading messages…"
        : newer ? "Loading newer messages…" : "Loading earlier messages…")
      : root.historyError !== "" ? root.historyError
      : root.historyChanged ? "Messages may have changed since they loaded"
      : offerOlder ? "Earlier messages" : ""
    readonly property string action: root.historyPending !== "" ? ""
      : root.historyError !== "" ? (root.failedHistoryRequest !== null && root.online ? "Retry" : "")
      : root.historyChanged ? (root.online ? "Refresh" : "")
      : offerOlder ? "Load" : ""
    function activate() {
      if (action === "Retry") root.retryHistory()
      else if (action === "Refresh") root.refreshHistory()
      else if (action === "Load") root.loadOlder()
    }
    visible: message !== "" && root.session !== null
    // Sized from the text's natural width (not its laid-out width, which
    // depends on this size). Leaves room for the Jump to latest arrow.
    readonly property real actionSpace: statusAction.visible ? statusAction.implicitWidth + 8 * root.unit : 0
    width: Math.min(statusText.implicitWidth + actionSpace + 20 * root.unit,
      Math.max(0, transcript.width - 2 * (latestArrow.width + 16 * root.unit)))
    height: Math.max(statusText.implicitHeight, statusAction.visible ? statusAction.implicitHeight : 0) + 8 * root.unit
    x: transcript.x + (transcript.width - width) / 2
    y: newer ? transcript.y + transcript.height - height - 8 * root.unit : transcript.y + 6 * root.unit
    radius: height / 2
    color: root.overlayColor
    border.color: root.historyError !== "" ? "#ef5350" : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.4)
    Text {
      id: statusText
      objectName: "historyStatusText"
      x: 10 * root.unit
      anchors.verticalCenter: parent.verticalCenter
      width: Math.max(0, historyStatus.width - 20 * root.unit - historyStatus.actionSpace)
      text: historyStatus.message
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.historyError !== "" ? "#ef5350" : root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }
    PanelAction {
      id: statusAction
      objectName: "historyStatusAction"
      anchors.right: parent.right
      anchors.rightMargin: 6 * root.unit
      anchors.verticalCenter: parent.verticalCenter
      visible: historyStatus.action !== ""
      text: historyStatus.action
      implicitHeight: 22 * root.unit
      foreground: root.foreground
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onTriggered: historyStatus.activate()
      Accessible.name: historyStatus.action === "Load" ? "Load earlier messages" : historyStatus.action + " history"
    }
  }

  // A small shortcut back to the live end. It appears whenever the reader is
  // away from it; scrolling down reaches the same place without it.
  Rectangle {
    id: latestArrow
    objectName: "jumpToLatest"
    visible: root.session !== null && !root.atLatest
    width: 32 * root.unit
    height: width
    x: transcript.x + transcript.width - width - 12 * root.unit
    y: transcript.y + transcript.height - height - 8 * root.unit
    radius: 6 * root.unit
    color: latestMouse.containsMouse ? Qt.lighter(root.overlayColor, 1.35) : root.overlayColor
    border.color: latestMouse.containsMouse ? root.accent : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.6)
    function activate() { root.latestHistory() }
    Text {
      anchors.centerIn: parent
      text: "↓"
      color: latestMouse.containsMouse ? root.accent : root.foreground
      font.family: root.proseFontFamily
      font.pixelSize: 16 * root.unit
    }
    MouseArea {
      id: latestMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: latestArrow.activate()
    }
    ToolTip.visible: latestMouse.containsMouse
    ToolTip.delay: 400
    ToolTip.text: "Jump to latest"
    Accessible.role: Accessible.Button
    Accessible.name: "Jump to latest"
    Accessible.onPressAction: activate()
  }

  Column {
    id: inputSection
    anchors.bottom: parent.bottom
    width: parent.width
    spacing: 8 * root.unit

    AgentChoices {
      objectName: "agentChoices"
      width: parent.width
      maximumHeight: root.choiceHeightLimit
      choices: root.actionsCurrent ? root.agentActions.choices || [] : []
      sessionId: root.actionsCurrent ? root.session.id : ""
      stopRunId: root.actionsCurrent ? root.agentActions.stopRunId || "" : ""
      online: root.online
      listening: !root.paused
      pending: root.pendingChoice !== null || root.pendingSubmission !== null
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.proseFontFamily
      unit: root.unit
      onChoiceRequested: (id, revision, index) => {
        root.inputError = ""
        root.pendingChoice = {id: id, revision: revision, index: index}
        root.choiceRequested(id, revision, index)
      }
      onStopRequested: (id, runId) => root.stopRunRequested(id, runId)
    }

    ScrollView {
      id: composerScroll
      width: parent.width
      height: 76 * root.textScale
      contentWidth: availableWidth
      clip: true
      TextArea {
        id: composer
        objectName: "sessionComposer"
        enabled: root.composerReachable
        width: composerScroll.availableWidth
        placeholderText: !root.composerFocusId && root.focusShortcut
          ? root.focusShortcut + " to focus"
          : root.running ? "Write a follow-up while Pi answers…" : "Ask a follow-up…"
        placeholderTextColor: root.muted
        color: root.foreground
        selectionColor: root.selection
        selectedTextColor: root.foreground
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        selectByMouse: true
        padding: 8 * root.unit
        font.family: root.proseFontFamily
        font.pixelSize: 16 * root.textScale
        background: Rectangle {
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: composer.activeFocus ? root.accent : root.muted
          radius: 4 * root.unit
        }
        onTextChanged: {
          if (root.displayedId) root.drafts[root.displayedId] = text
          if (text === "") root.forgetDraftSource(root.displayedId)
        }
        onSelectedTextChanged: if (selectedText !== "") root.clearMessageSelection()
        TapHandler { onPressedChanged: if (pressed) root.clearMessageSelection() }
        // TextArea consumes the standard copy key before window shortcuts.
        // When the reader selected a message, route that same key explicitly;
        // otherwise leave ordinary composer copying to TextArea.
        Keys.onPressed: event => {
          if (event.matches(StandardKey.Copy) && root.copySelectedMessage()) event.accepted = true
        }
        Keys.onReturnPressed: event => root.enterPressed(event)
        Keys.onEnterPressed: event => root.enterPressed(event)
        Accessible.name: "Message to the selected agent session"
      }
    }

    Text {
      objectName: "agentDraftSource"
      width: parent.width
      visible: root.displayedDraftSource !== ""
      text: "Drafted by agent · " + root.displayedDraftSource + " — review before sending"
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Text {
      objectName: "recordingNotice"
      width: parent.width
      visible: root.displayedRecordingNotice !== ""
      text: root.displayedRecordingNotice
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    // Appears near the limit, so a long message never fails by surprise.
    Text {
      objectName: "sessionComposerCounter"
      width: parent.width
      visible: composer.text.length > root.maximumMessageLength - 1000
      text: composer.text.length + " / " + root.maximumMessageLength + " characters"
      color: composer.text.length > root.maximumMessageLength ? "#ef5350" : root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Text {
      width: parent.width
      visible: text !== ""
      text: composer.text.length > root.maximumMessageLength ? "Keep messages within " + root.maximumMessageLength + " characters." : root.inputError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Row {
      spacing: 8 * root.unit
      PanelAction {
        objectName: "sendSession"
        enabled: root.canSend
        text: root.running ? "Queue" : "Send"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.submit()
      }
      // Distinct from the agent's Stop: this only ends recording into the text box.
      PanelAction {
        objectName: "recordSession"
        visible: root.recordingAvailable && root.session !== null
        enabled: root.recordingHere
          ? root.online && root.recordingState !== "finishing" && !root.stopRecordingPending && root.ownRecording.recordingId !== ""
          : root.canRecord
        text: root.recordingState === "finishing" ? "Finishing transcription…"
          : root.recordingHere ? "Stop recording" : "Record"
        foreground: root.foreground
        selection: root.recordingHere ? Qt.rgba(0.94, 0.33, 0.31, 0.45) : root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.toggleRecording()
      }
      PanelAction {
        objectName: "stopSession"
        visible: root.running && !(root.actionsCurrent && root.agentActions.stopRunId)
        enabled: root.online
        text: "Stop"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.stopRequested(root.session.id)
      }
      PanelAction {
        objectName: "dismissSession"
        enabled: root.online && root.session !== null && !root.recordingBusy
        text: "Close session"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.dismissRequested(root.session.id)
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: !root.online ? "Disconnected" : root.running ? "Answering…"
          : root.session && root.session.status === "cancelled" ? "Stopped"
          : root.session && root.session.status === "error" ? "Failed" : "Done"
        textFormat: Text.PlainText
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
      }
    }
  }
}
