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
  // Voice projection: controls of the conversation speech currently goes to
  // (`sessionId` is empty when there is none). It decides voice hints only.
  property var agentActions: ({})
  // This connection's per-conversation controls (session ID -> actions), or
  // null when the host has no view projection from its listener yet.
  property var viewAgentActions: null
  property var pendingChoice: null
  // Whether speech goes to this conversation right now.
  readonly property bool voiceTarget: session !== null && agentActions.sessionId === session.id
  // Choice and stop controls for this conversation, whichever view is the
  // voice target. Without a view projection (older listener) only the voice
  // target has controls, as before.
  readonly property var ownActions: {
    if (session === null) return null
    if (viewAgentActions === null) return voiceTarget ? agentActions : null
    return viewAgentActions[session.id] || null
  }
  readonly property string ownStopRunId: ownActions ? ownActions.stopRunId || "" : ""
  // Own choices, each with its voice hint only when the voice projection has
  // the same conversation, choice revision and index. A label is never shown
  // as speakable from another conversation's or an older set's annotation.
  readonly property var displayedChoices: {
    const own = ownActions ? ownActions.choices || [] : []
    const voiceChoices = voiceTarget ? agentActions.choices || [] : []
    return own.map(choice => {
      const voice = voiceChoices.find(entry => entry.sessionId === choice.sessionId
        && entry.revision === choice.revision && entry.index === choice.index)
      return Object.assign({}, choice, {
        voiceAvailable: voice ? voice.voiceAvailable === true : false,
        voiceReason: voice ? voice.voiceReason || "" : choice.voiceReason || ""
      })
    })
  }
  // Where speech goes, shown beside this conversation's controls. Empty while
  // offline; the choices then say "Disconnected". Pausing stops listening for
  // every conversation, so it is shown whichever conversation is the target.
  readonly property string voiceStatus: {
    if (!online) return ""
    if (paused) return "Voice paused"
    if (voiceTarget) return "Voice: this conversation"
    if (agentActions.sessionId) return "Voice: another conversation"
    return "Voice: no conversation"
  }
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
  // Conversation id -> cursor position of a draft received from another view
  // while it was not displayed here; applied once when it is displayed.
  property var draftCursors: ({})
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
  readonly property string composerFocusId: online
    && (htmlActive ? htmlComposerFocused : composerReachable && composer.activeFocus)
    && root.Window.window && root.Window.window.active ? displayedId : ""

  // Trusted HTML session surface (integrations/session-apps/). A host with
  // embedded Chromium sets `htmlSurface`; the conversation then shows the
  // HTML chat, or the conversation's own session application, in place of
  // the QML transcript and composer below. This item stays the model in both
  // cases: the same rows, host-owned draft, pending send/choice, recording
  // and the draft handover functions used by pop-out windows. The QML
  // presentation remains the trusted recovery ("Classic view"), and is used
  // automatically while the HTML surface is not loaded or has failed.
  property bool htmlSurface: false
  property bool classicView: false
  readonly property bool htmlActive: htmlSurface && nativeWidgets && !classicView
    && htmlLoader.status === Loader.Ready && htmlLoader.item !== null && htmlLoader.item.operational
    && !htmlLoader.item.failed
  // Reported by the trusted HTML chat only (never by a session application).
  readonly property bool htmlComposerFocused: htmlActive && htmlLoader.item.composerFocused
  // Host-side draft changes (agent drafts, recording, a completed send,
  // handover, tab switch) advance this. Edits typed into the HTML composer
  // do not; see ChatState.draftEditAllowed().
  property int draftRevision: 0
  property bool applyingPageDraft: false
  // The listener owns every conversation's draft (last write received wins).
  // `sharedDrafts` is this UI's mirror of it (Client.serverDrafts): showing a
  // conversation reads it. Each real edit is written back through
  // `draftWritten`, naming the conversation it was typed for. Loading or
  // showing a draft is not an edit and writes nothing (`loadingDraft`).
  property var sharedDrafts: null
  property bool loadingDraft: false
  signal draftWritten(string id, string text, bool recording)
  // Conversations whose shown text is not saved in the listener, with the
  // reason (Client.unsavedDrafts). Save writes it again; Discard shows the
  // listener's version. Such a conversation does not move to another view
  // or close until one of them is chosen.
  property var unsavedDrafts: ({})
  readonly property string displayedUnsaved: root.unsavedDrafts[root.displayedId] || ""
  signal draftSaveRequested(string id)
  signal draftDiscardRequested(string id)
  function recordingInto(id) { return root.ownRecording !== null && root.ownRecording.id === id }
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
    if (root.htmlActive) {
      if (root.online && root.visible && root.session) htmlLoader.item.focusComposer()
      return
    }
    if (root.online && root.composerReachable && root.session) composer.forceActiveFocus(Qt.ShortcutFocusReason)
  }

  function releaseComposerFocus() {
    if (root.htmlActive) htmlLoader.item.releaseComposerFocus()
    composer.focus = false
  }

  // The displayed conversation's draft, for the HTML composer.
  function pageDraft() {
    return {sessionId: root.displayedId, text: composer.text, cursor: composer.cursorPosition,
      revision: root.draftRevision}
  }

  // The HTML composer's cursor moved without an edit.
  function setPageCursor(cursor) {
    composer.cursorPosition = Math.max(0, Math.min(cursor, composer.length))
  }

  // Replace the displayed draft with text typed in the HTML composer. The
  // caller (ChatBridge.qml) has already checked the session and revision.
  // Runs synchronously, so no host-side change interleaves.
  // A draft change the listener accepted from another editor (or an older
  // UI state being corrected). Shown without writing it back (no echo); the
  // cursor stays where it was, within the new text.
  function serverDraft(id, text, source) {
    if (typeof id !== "string" || typeof text !== "string") return
    if (text === "") delete root.drafts[id]
    else root.drafts[id] = text
    if (root.displayedId === id && composer.text !== text) {
      const cursor = composer.cursorPosition
      root.loadingDraft = true
      composer.text = text
      root.loadingDraft = false
      composer.cursorPosition = Math.min(cursor, composer.length)
    }
    // The listener's provenance: an agent's source, or none after the
    // person edited it.
    if (source && text !== "") root.draftSources = Object.assign({}, root.draftSources, {[id]: source})
    else root.forgetDraftSource(id)
  }

  // An edit typed for a conversation this view no longer shows (it arrived
  // after a switch). It still belongs to that conversation: the listener
  // keeps it there; the shown conversation is untouched.
  function writeDraftFor(id, text) {
    if (typeof id !== "string" || id === "" || typeof text !== "string") return false
    if (id === root.displayedId) {
      root.replaceDraftFromPage(text, text.length)
      return true
    }
    if (text === "") delete root.drafts[id]
    else root.drafts[id] = text
    root.draftWritten(id, text, root.recordingInto(id))
    return true
  }

  function replaceDraftFromPage(text, cursor) {
    root.applyingPageDraft = true
    composer.text = text
    composer.cursorPosition = Math.max(0, Math.min(cursor, composer.length))
    root.applyingPageDraft = false
  }

  // A choice selected in the HTML chat: the same path as AgentChoices below.
  function requestChoice(id, revision, index) {
    root.inputError = ""
    root.pendingChoice = {id: id, revision: revision, index: index}
    root.choiceRequested(id, revision, index)
  }

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
    // A listener that applies recorded words itself (`applied`) sends them as
    // an ordinary draft change; the panel only acknowledges the chunk.
    if (request.applied === true) {
      return {outcome: "appended", length: typeof request.length === "number" ? request.length : 0}
    }
    const displayed = root.displayedId === request.id
    const current = displayed ? composer.text : (root.drafts[request.id] || "")
    const separator = current === "" || /\s$/.test(current) ? "" : " "
    const addition = separator + request.text
    if (displayed) composer.insert(composer.length, addition)
    else {
      root.drafts[request.id] = current + addition
      root.draftWritten(request.id, current + addition, true)
    }
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
      root.draftWritten(id, next, false)
    }
    return {outcome: outcome, reason: ""}
  }

  // Moving a conversation between this view and another one (the sidebar and
  // a pop-out window). Exactly one view owns a conversation's composer at a
  // time; the host calls these synchronously, so no keystroke can interleave.

  // Why this view's composer for `id` cannot move right now, or "". Pending
  // acknowledgements and the recording are correlated with this view, so
  // they must settle before the composer leaves it.
  function transferBlocker(id) {
    if (root.pendingSubmission && root.pendingSubmission.id === id) {
      return "A message from this conversation is still being sent. Try again once it is confirmed."
    }
    if (root.pendingChoice && root.pendingChoice.id === id) {
      return "A choice in this conversation is still being confirmed. Try again once it is answered."
    }
    if (root.ownRecording && root.ownRecording.id === id) {
      return "Recording into this conversation is still running. Stop it and wait for the text first."
    }
    if (root.unsavedDrafts[id] !== undefined) {
      return "This conversation's text is not saved yet. Save or discard it first."
    }
    return ""
  }

  // The unsent text owned here for `id`, with its agent provenance, the
  // cursor (only meaningful while displayed) and any recording notice.
  function exportDraft(id) {
    const displayed = root.displayedId === id
    return {
      text: displayed ? composer.text : (root.drafts[id] || ""),
      cursor: displayed ? composer.cursorPosition : -1,
      source: root.draftSources[id],
      notice: root.recordingNotices[id] || ""
    }
  }

  // Take ownership of a draft exported by another view. Returns whether this
  // view now holds exactly that text, so the caller clears the old owner only
  // after a confirmed handover.
  function importDraft(id, draft) {
    if (!draft || typeof draft.text !== "string") return false
    if (draft.source !== undefined) root.draftSources = Object.assign({}, root.draftSources, {[id]: draft.source})
    else root.forgetDraftSource(id)
    root.setRecordingNotice(id, draft.notice || "")
    if (root.displayedId === id) {
      composer.text = draft.text
      composer.cursorPosition = draft.cursor >= 0 ? Math.min(draft.cursor, composer.length) : composer.length
    } else {
      root.drafts[id] = draft.text
      if (draft.cursor >= 0) root.draftCursors[id] = draft.cursor
    }
    return root.exportDraft(id).text === draft.text
  }

  // Forget `id`'s draft here after another view confirmed it holds the text.
  function clearDraft(id) {
    delete root.drafts[id]
    delete root.draftCursors[id]
    root.forgetDraftSource(id)
    root.setRecordingNotice(id, "")
    if (root.displayedId === id) composer.text = ""
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
    const origin = message.origin
    const appMessage = !!origin && origin.kind === "application-message"
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
    const appVerified = appMessage && typeof origin.name === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(origin.name)
      && Number.isSafeInteger(origin.version) && origin.version > 0 && origin.depth === 1
      && typeof origin.applicationId === "string" && uuid.test(origin.applicationId)
      && typeof origin.receiptId === "string" && uuid.test(origin.receiptId)
      && typeof origin.bundle === "string" && /^[0-9a-f]{64}$/.test(origin.bundle)
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
      // The person's own committed edits in this conversation's session
      // application, delivered by the host as a turn; not another agent.
      fromApplication: message.origin ? message.origin.kind === "application-event" : false,
      fromAppMessage: appMessage,
      fromAgent: message.origin !== undefined && message.origin !== null,
      // App labels derive only from host metadata, never a body prefix or an
      // arbitrary title. Malformed app provenance stays explicitly non-human.
      originTitle: appMessage ? (appVerified ? origin.name + " · v" + origin.version : "unverified application origin")
        : message.origin ? message.origin.title || "" : "",
      originReceiptId: appVerified ? origin.receiptId : "",
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
      // Showing a conversation reads its draft; it never writes one.
      // With the listener's mirror, a conversation it has no draft for is
      // empty; a view's own older copy never comes back.
      const shown = root.sharedDrafts ? (root.sharedDrafts[id] || "") : (root.drafts[id] || "")
      root.loadingDraft = true
      composer.text = shown
      root.loadingDraft = false
      // A draft handed over from another view keeps its cursor position.
      if (root.draftCursors[id] !== undefined) {
        composer.cursorPosition = Math.min(root.draftCursors[id], composer.length)
        delete root.draftCursors[id]
      }
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
    visible: !root.htmlActive
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
      required property bool fromApplication
      required property bool fromAppMessage
      required property string originReceiptId
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
              : bubble.kind === "user" ? (bubble.fromAppMessage ? "Application · " + bubble.originTitle + (bubble.originReceiptId ? " · receipt " + bubble.originReceiptId.slice(0, 8) : "") : bubble.fromApplication ? "Your edits in this conversation's app" : bubble.fromAgent ? (bubble.fromWake ? "Scheduled wake · " : bubble.fromExternal ? "External agent (unverified) · " : "Agent · ") + (bubble.originTitle || "another conversation") : "You")
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
    visible: message !== "" && root.session !== null && !root.htmlActive
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
    visible: root.session !== null && !root.atLatest && !root.htmlActive
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
    visible: !root.htmlActive
    spacing: 8 * root.unit

    AgentChoices {
      objectName: "agentChoices"
      width: parent.width
      maximumHeight: root.choiceHeightLimit
      choices: root.displayedChoices
      sessionId: root.ownActions ? root.session.id : ""
      stopRunId: root.ownStopRunId
      voiceTarget: root.voiceTarget
      voiceStatus: root.voiceStatus
      online: root.online
      listening: !root.paused
      pending: root.pendingChoice !== null || root.pendingSubmission !== null
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.proseFontFamily
      unit: root.unit
      onChoiceRequested: (id, revision, index) => root.requestChoice(id, revision, index)
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
        enabled: root.composerReachable && !root.htmlActive
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
          if (!root.applyingPageDraft) root.draftRevision++
          if (root.displayedId) root.drafts[root.displayedId] = text
          if (text === "") root.forgetDraftSource(root.displayedId)
          // An edit of the shown conversation (typing here or in the HTML
          // chat, an agent draft, recorded words): the listener keeps it.
          if (root.displayedId && !root.loadingDraft) root.draftWritten(root.displayedId, text, root.recordingInto(root.displayedId))
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

    // Text the listener has not saved (see unsavedDrafts).
    Column {
      objectName: "unsavedDraft"
      width: parent.width
      visible: root.displayedUnsaved !== ""
      spacing: 4 * root.unit
      Text {
        width: parent.width
        text: root.displayedUnsaved
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: "#ef5350"
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
      }
      Row {
        spacing: 8 * root.unit
        PanelAction {
          objectName: "unsavedDraftSave"
          enabled: root.online
          text: "Save"
          foreground: root.foreground
          selection: root.selection
          fontFamily: root.fontFamily
          unit: root.unit
          onTriggered: root.draftSaveRequested(root.displayedId)
        }
        PanelAction {
          objectName: "unsavedDraftDiscard"
          text: "Discard"
          foreground: root.foreground
          selection: root.selection
          fontFamily: root.fontFamily
          unit: root.unit
          onTriggered: root.draftDiscardRequested(root.displayedId)
        }
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
        visible: root.running && root.ownStopRunId === ""
        enabled: root.online
        text: "Stop"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.stopRequested(root.session.id)
      }
      // Back from the recovery view to the trusted HTML surface.
      PanelAction {
        objectName: "htmlViewSession"
        visible: root.htmlSurface && root.nativeWidgets && root.classicView
        text: "HTML view"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.classicView = false
      }
      PanelAction {
        objectName: "dismissSession"
        enabled: root.online && root.session !== null && !root.recordingBusy && root.displayedUnsaved === ""
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

  // ---- Optional app-chat consent (trusted native UI only) -----------------
  // This component is mounted and its command/reply signal wired by the HTML
  // surface adapter. Until then it is inert; no app code or generic HTML
  // composer bridge receives these methods. It never reads or changes a draft.
  property bool appChatPermissionTransportReady: false
  readonly property var appChatApplication: session && session.application ? session.application : null
  readonly property var appChatAccess: appChatApplication && appChatApplication.chatAccess ? appChatApplication.chatAccess : null
  readonly property bool appChatReadRequested: appChatAccess !== null && Array.isArray(appChatAccess.requested)
    && appChatAccess.requested.indexOf("chat.read") >= 0
  readonly property bool appChatSendRequested: appChatAccess !== null && Array.isArray(appChatAccess.requested)
    && appChatAccess.requested.indexOf("chat.send") >= 0
  readonly property var appChatSendAccess: appChatAccess && appChatAccess.send ? appChatAccess.send : null
  readonly property string appChatIdentity: session && appChatApplication && appChatAccess
    ? session.id + ":" + appChatApplication.id + ":" + appChatApplication.version + ":" + appChatAccess.revision : ""
  property string appChatDisclosureIdentity: ""
  readonly property bool appChatDisclosureOpen: appChatIdentity !== "" && appChatDisclosureIdentity === appChatIdentity
  property string appChatSendDisclosureIdentity: ""
  readonly property bool appChatSendDisclosureOpen: appChatIdentity !== "" && appChatSendDisclosureIdentity === appChatIdentity
  property var appChatPermissionPending: null
  property string appChatPermissionError: ""
  property int appChatPermissionTimeoutMilliseconds: 10000
  readonly property bool appChatCanChange: root.visible && root.online && root.appChatPermissionTransportReady
    && (root.appChatReadRequested || root.appChatSendRequested) && root.appChatIdentity !== "" && root.appChatPermissionPending === null
  signal appChatPermissionRequested(var request)

  // A different conversation, replacement, reopen or permission update cannot
  // inherit an open confirmation or be changed by an earlier request's reply.
  onAppChatIdentityChanged: {
    root.appChatDisclosureIdentity = ""
    root.appChatSendDisclosureIdentity = ""
    root.appChatPermissionPending = null
    root.appChatPermissionError = ""
    appChatPermissionDeadline.stop()
  }

  function reviewAppChatAccess() {
    if (!root.appChatCanChange || !root.appChatReadRequested) return false
    root.appChatDisclosureIdentity = root.appChatIdentity
    root.appChatSendDisclosureIdentity = ""
    root.appChatPermissionError = ""
    return true
  }

  function reviewAppChatSending() {
    if (!root.appChatCanChange || !root.appChatSendRequested || !root.appChatSendAccess) return false
    root.appChatSendDisclosureIdentity = root.appChatIdentity
    root.appChatDisclosureIdentity = ""
    root.appChatPermissionError = ""
    return true
  }

  function requestAppChatRead(allowed) { return root.requestAppChatPermission("read", allowed) }
  function requestAppChatSend(allowed) { return root.requestAppChatPermission("send", allowed) }

  function requestAppChatPermission(kind, allowed) {
    if (typeof allowed !== "boolean" || !root.appChatCanChange) return false
    if (kind === "read") {
      if (!root.appChatReadRequested || (allowed && !root.appChatDisclosureOpen)) return false
    } else if (kind === "send") {
      if (!root.appChatSendRequested || !root.appChatSendAccess || (allowed && !root.appChatSendDisclosureOpen)) return false
    } else return false
    // Each kind has its own exact-identity disclosure. Neither permits the
    // other; renewals need a new review and revocations never need disclosure.
    const request = {
      action: "set-application-chat-" + kind,
      requestId: "app-chat-" + kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      id: root.session.id,
      applicationId: root.appChatApplication.id,
      version: root.appChatApplication.version,
      revision: root.appChatAccess.revision,
      allowed: allowed
    }
    root.appChatPermissionPending = {requestId: request.requestId, action: request.action, identity: root.appChatIdentity}
    root.appChatPermissionError = ""
    appChatPermissionDeadline.restart()
    root.appChatPermissionRequested(request)
    return true
  }

  function receiveAppChatPermissionResult(message) {
    const pending = root.appChatPermissionPending
    if (!pending || !message || message.action !== pending.action
      || message.requestId !== pending.requestId || pending.identity !== root.appChatIdentity
      || (message.type !== "result" && message.type !== "error")) return false
    appChatPermissionDeadline.stop()
    root.appChatPermissionPending = null
    // Never optimistically change the descriptor. Its next snapshot/patch is
    // the authority, including when it arrives before this acknowledgement.
    root.appChatDisclosureIdentity = ""
    root.appChatSendDisclosureIdentity = ""
    root.appChatPermissionError = message.type === "error"
      ? String(message.message || "Permission was not changed.").slice(0, 500) : ""
    return true
  }

  Timer {
    id: appChatPermissionDeadline
    interval: root.appChatPermissionTimeoutMilliseconds
    onTriggered: {
      if (!root.appChatPermissionPending) return
      root.appChatPermissionPending = null
      root.appChatDisclosureIdentity = ""
      root.appChatSendDisclosureIdentity = ""
      root.appChatPermissionError = "No confirmation received. Permission may have changed; check its current status before trying again."
    }
  }

  component AppChatPermissionButton: Button {
    id: permissionButton
    property var scrollHost: null
    onActiveFocusChanged: if (activeFocus && scrollHost) scrollHost.reveal(permissionButton)
    width: parent ? Math.min(implicitWidth, parent.width) : implicitWidth
    padding: 8 * root.unit
    focusPolicy: Qt.StrongFocus
    font.family: root.fontFamily
    font.pixelSize: 12 * root.textScale
    contentItem: Text {
      text: permissionButton.text
      font: permissionButton.font
      color: root.foreground
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      horizontalAlignment: Text.AlignHCenter
      verticalAlignment: Text.AlignVCenter
    }
    background: Rectangle {
      implicitWidth: 80 * root.unit
      implicitHeight: 32 * root.unit
      color: root.selection
      opacity: permissionButton.enabled ? 1 : 0.45
      border.color: permissionButton.activeFocus ? root.accent : "transparent"
      border.width: permissionButton.activeFocus ? 2 : 0
      radius: 3 * root.unit
    }
  }

  readonly property Component appChatPermissionControl: Component {
    Rectangle {
      objectName: "appChatPermissionControl"
      color: root.overlayColor
      visible: root.appChatReadRequested || root.appChatSendRequested
      // The disclosure scrolls instead of covering the trusted Chat/app bar
      // or taking the whole available conversation height at large text scale.
      implicitHeight: visible ? Math.min(appChatPermissionContent.implicitHeight + 16 * root.unit,
        Math.max(0, root.height * 0.55)) : 0
      clip: true
      Flickable {
        id: appChatPermissionScroll
        objectName: "appChatPermissionScroll"
        anchors.fill: parent
        anchors.margins: 8 * root.unit
        contentWidth: width
        contentHeight: appChatPermissionContent.implicitHeight
        function reveal(item) {
          const point = item.mapToItem(contentItem, 0, 0)
          const next = point.y < contentY ? point.y
            : point.y + item.height > contentY + height ? point.y + item.height - height : contentY
          contentY = Math.max(0, Math.min(next, contentHeight - height))
        }
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar {}
        Column {
          id: appChatPermissionContent
          width: parent.width
          spacing: 6 * root.unit
          Text {
            objectName: "appChatPermissionStatus"
            width: parent.width
            text: (root.appChatApplication ? root.appChatApplication.name + " · v" + root.appChatApplication.version : "")
              + (root.appChatReadRequested ? " — Chat reading " + (root.appChatAccess && root.appChatAccess.read ? "allowed" : "off") : "")
              + (!root.online ? " · Disconnected" : "")
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.family: root.fontFamily
            font.pixelSize: 12 * root.textScale
            color: root.foreground
          }
          Text {
            objectName: "appChatPermissionDisclosure"
            width: parent.width
            visible: root.appChatDisclosureOpen
            text: "Allow this app to read recent text from this conversation, including earlier messages and live replies? Drafts, tools and attachments are excluded.\n\n"
              + "The app can copy text into its saved state or agent-visible actions. Revoking stops future reads but cannot erase copies. In-flight reads may finish. Access ends when app code changes, the conversation is reopened, or Companion restarts. Sending requires separate permission."
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.family: root.proseFontFamily
            font.pixelSize: 12 * root.textScale
            color: root.foreground
          }
          Flow {
            width: parent.width
            visible: root.appChatReadRequested
            spacing: 8 * root.unit
            AppChatPermissionButton {
              objectName: "appChatReviewRead"
              scrollHost: appChatPermissionScroll
              visible: !root.appChatDisclosureOpen && !(root.appChatAccess && root.appChatAccess.read)
              enabled: root.appChatCanChange
              text: "Review chat access"
              onClicked: root.reviewAppChatAccess()
            }
            AppChatPermissionButton {
              objectName: "appChatAllowRead"
              scrollHost: appChatPermissionScroll
              visible: root.appChatDisclosureOpen && !(root.appChatAccess && root.appChatAccess.read)
              enabled: root.appChatCanChange
              text: "Allow reading"
              onClicked: root.requestAppChatRead(true)
            }
            AppChatPermissionButton {
              objectName: "appChatDeclineRead"
              scrollHost: appChatPermissionScroll
              visible: root.appChatDisclosureOpen
              enabled: root.appChatPermissionPending === null
              text: "Not now"
              onClicked: root.appChatDisclosureIdentity = ""
            }
            AppChatPermissionButton {
              objectName: "appChatRevokeRead"
              scrollHost: appChatPermissionScroll
              visible: root.appChatAccess !== null && root.appChatAccess.read === true
              enabled: root.appChatCanChange
              text: "Revoke reading"
              onClicked: root.requestAppChatRead(false)
            }
          }
          Text {
            objectName: "appChatSendStatus"
            width: parent.width
            visible: root.appChatSendRequested
            text: "App sending " + (!root.appChatSendAccess ? "unavailable on this host"
              : root.appChatSendAccess.allowed ? (root.appChatSendAccess.remaining > 0 ? "allowed" : "exhausted") + " · " + root.appChatSendAccess.remaining + " of 5 attempts remaining" : "off")
              + (root.appChatSendAccess && root.appChatSendAccess.busy ? " · app message active" : "")
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.family: root.fontFamily
            font.pixelSize: 12 * root.textScale
            color: root.foreground
          }
          Text {
            objectName: "appChatSendDisclosure"
            width: parent.width
            visible: root.appChatSendDisclosureOpen
            text: "Allow this exact app code to send up to 5 messages to this conversation's agent, without asking you for each message? These are labelled app messages, not authenticated human input or new authorization. Reading and drafts are not granted.\n\n"
              + "One app message can be active at a time, with at least two seconds between admissions. Failed or uncertain attempts can consume quota; they are never retried automatically. Revoking or replacing code withdraws unstarted app messages, but already-running work may have effects and continues until finished or stopped. Use the conversation's Stop control to halt it; Stop also revokes sending.\n\n"
              + "A new grant replaces the old quota and withdraws unstarted app messages. Existing application-edit notifications remain separate; this quota covers app chat sends only. Consent ends on code replacement, close/reopen or Companion restart. Merely hiding this view does not revoke backend consent."
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.family: root.proseFontFamily
            font.pixelSize: 12 * root.textScale
            color: root.foreground
          }
          Flow {
            width: parent.width
            visible: root.appChatSendRequested
            spacing: 8 * root.unit
            AppChatPermissionButton {
              objectName: "appChatReviewSend"
              scrollHost: appChatPermissionScroll
              visible: !root.appChatSendDisclosureOpen
              enabled: root.appChatCanChange && root.appChatSendAccess !== null
              text: root.appChatSendAccess && root.appChatSendAccess.allowed ? "Review new sending grant" : "Review app sending"
              onClicked: root.reviewAppChatSending()
            }
            AppChatPermissionButton {
              objectName: "appChatAllowSend"
              scrollHost: appChatPermissionScroll
              visible: root.appChatSendDisclosureOpen
              enabled: root.appChatCanChange && root.appChatSendAccess !== null
              text: "Allow 5 app messages"
              onClicked: root.requestAppChatSend(true)
            }
            AppChatPermissionButton {
              objectName: "appChatDeclineSend"
              scrollHost: appChatPermissionScroll
              visible: root.appChatSendDisclosureOpen
              enabled: root.appChatPermissionPending === null
              text: "Not now"
              onClicked: root.appChatSendDisclosureIdentity = ""
            }
            AppChatPermissionButton {
              objectName: "appChatRevokeSend"
              scrollHost: appChatPermissionScroll
              visible: root.appChatSendAccess !== null && root.appChatSendAccess.allowed === true
              enabled: root.appChatCanChange
              text: "Revoke sending"
              onClicked: root.requestAppChatSend(false)
            }
          }
          Text {
            objectName: "appChatPermissionFeedback"
            width: parent.width
            visible: text !== ""
            text: root.appChatPermissionPending ? "Waiting for permission confirmation…" : root.appChatPermissionError
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.family: root.proseFontFamily
            font.pixelSize: 12 * root.textScale
            color: root.muted
          }
        }
      }
    }
  }
  // ---- End app-chat consent ------------------------------------------------

  // Loaded only when a host enables it; the portable Quickshell panel never
  // resolves this path or the WebEngine modules it imports.
  Loader {
    id: htmlLoader
    objectName: "htmlSurfaceLoader"
    anchors.fill: parent
    active: root.htmlSurface && root.nativeWidgets
    visible: root.htmlActive
    source: active ? Qt.resolvedUrl("../session-apps/SessionSurface.qml") : ""
    onLoaded: item.view = root
  }
}
