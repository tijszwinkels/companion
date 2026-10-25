import QtQuick
import QtWebEngine
import QtWebChannel
import Companion.Widgets 1.0
import "ChatState.mjs" as ChatState

// Companion's own HTML chat for one conversation view: transcript, composer,
// choices, Stop, Record and history paging, rendered by the trusted page
// built from chat/ (dist/chat.html).
//
// Trust boundary:
// - The page is Companion code from the fixed local bundle (ShellProfile).
//   It has no network, file or capability access of its own.
// - Its only native access is the `companion` QWebChannel object below. Every
//   method re-checks its request against the SessionView model (displayed
//   conversation, draft revision, choice revision, run ID) and calls the same
//   SessionView functions and signals as the QML presentation. The page never
//   receives capability URLs, other conversations or agent leases.
// - Transcript text is untrusted content. The page renders it as escaped
//   text/Markdown and its CSP permits only the bundle's own scripts.
// - Session applications never load here and never see this object.
//
// Model ownership: SessionView (`view`) keeps the draft, pending send/choice,
// recording and resident rows. This view only mirrors them into the page and
// forwards the page's requests, so pop-out handover, agent drafts and voice
// routing keep working unchanged.
Item {
  id: root
  property var view: null
  property bool running: true
  // The page did not load or its renderer stopped: SessionView falls back to
  // the QML presentation, which stays fully functional.
  property bool loadFailed: false
  readonly property bool failed: loadFailed || readyTimedOut || shellProfile.error !== ""
  property bool pageReady: false
  // Bounded start-up handshake. The page counts as operational only after
  // its script connected and called ready(). A page that loads but never
  // gets there (missing or broken script) is treated as failed after this
  // long, so the native presentation stays (or becomes) the visible one.
  property int readyTimeoutMilliseconds: 10000
  property bool operational: false
  // How often a page completed the handshake (each load calls ready()).
  property int readyCount: 0
  property bool readyTimedOut: false
  Timer {
    id: readyDeadline
    interval: root.readyTimeoutMilliseconds
    running: !root.operational && !root.readyTimedOut && shellProfile.documentUrl.toString() !== ""
    onTriggered: root.readyTimedOut = true
  }

  // The page's own report that its composer has keyboard focus. Only counted
  // while this browser has Qt focus in an active window (see SessionView).
  property bool pageComposerFocused: false
  readonly property bool composerFocused: pageReady && pageComposerFocused && browser.activeFocus
  readonly property alias browser: browser
  property int sequence: 0
  property var sentRows: ({})
  property string lastStatus: ""
  property bool rowsDirty: true
  property bool fullRows: true
  property string bundleDirectory: {
    const url = Qt.resolvedUrl("dist").toString()
    return url.startsWith("file://") ? decodeURIComponent(url.slice(7)) : ""
  }
  signal classicRequested()
  signal appRequested()
  signal interactionStarted()

  function focusComposer() {
    browser.forceActiveFocus(Qt.ShortcutFocusReason)
    if (root.pageReady) browser.runJavaScript("window.companionChat && window.companionChat.focusComposer()")
  }

  function releaseComposerFocus() {
    if (root.pageReady) browser.runJavaScript("window.companionChat && window.companionChat.blurComposer()")
    root.pageComposerFocused = false
  }

  function post(message) {
    root.sequence++
    message.seq = root.sequence
    const encoded = JSON.stringify(message)
    if (encoded.length > ChatState.maximumMessageCharacters) {
      console.warn("Companion chat: dropped an oversized page update; the page resynchronizes")
      root.sentRows = ({})
      root.fullRows = true
      return
    }
    bridge.message(encoded)
  }

  function cssColor(value) {
    return "rgba(" + Math.round(value.r * 255) + "," + Math.round(value.g * 255)
      + "," + Math.round(value.b * 255) + "," + value.a + ")"
  }

  // The displayed rows, in the same order as the QML transcript.
  function currentRows() {
    if (!root.view || !root.view.session) return []
    return root.view.shownRows.map(row => ChatState.chatRow(root.view.rowData(row)))
  }

  function publishRows() {
    if (!root.pageReady) return
    const diff = ChatState.diffRows(root.sentRows, root.currentRows(), root.fullRows)
    root.sentRows = diff.sent
    root.post({type: "rows", sessionId: root.view && root.view.session ? root.view.session.id : "",
      full: root.fullRows, order: diff.order, changed: diff.changed})
    root.fullRows = false
    root.rowsDirty = false
  }

  function currentStatus() {
    const view = root.view
    const session = view ? view.session : null
    if (!session) return {sessionId: ""}
    const draft = view.pageDraft()
    const history = {hasOlder: view.hasOlder, pending: view.historyPending !== "", error: view.historyError,
      canRetry: view.historyError !== "" && view.failedHistoryRequest !== null,
      changed: view.historyChanged, detached: view.historyDetached, atLatest: view.atLatest}
    const recordingHere = view.recordingHere
    return {
      sessionId: session.id,
      title: session.title || "",
      sessionStatus: session.status || "",
      running: view.running === true,
      online: view.online,
      paused: view.paused,
      draft: {text: draft.text, cursor: draft.cursor, revision: draft.revision, refused: draft.refused,
        source: view.displayedDraftSource, notice: view.displayedRecordingNotice},
      maximumMessageLength: view.maximumMessageLength,
      canSend: view.canSend,
      pendingSend: view.pendingSubmission !== null,
      pendingChoice: view.pendingChoice !== null,
      inputError: view.inputError,
      recording: {available: view.recordingAvailable, here: recordingHere, state: view.recordingState,
        canRecord: view.canRecord, busy: view.recordingBusy, stopPending: view.stopRecordingPending,
        canStop: recordingHere && view.online && view.recordingState !== "finishing"
          && !view.stopRecordingPending && view.ownRecording !== null && view.ownRecording.recordingId !== ""},
      choices: view.displayedChoices.map(choice => ({sessionId: choice.sessionId, revision: choice.revision,
        index: choice.index, label: choice.label || "", description: choice.description || "",
        available: choice.available === true, voiceAvailable: choice.voiceAvailable === true,
        voiceReason: choice.voiceReason || ""})),
      stopRunId: view.ownStopRunId,
      voiceTarget: view.voiceTarget,
      voiceStatus: view.voiceStatus,
      history: history,
      focusShortcut: view.focusShortcut,
      application: session.application ? {name: session.application.name, version: session.application.version} : null,
      theme: {foreground: root.cssColor(view.foreground), background: root.cssColor(view.background),
        accent: root.cssColor(view.accent), muted: root.cssColor(view.muted), selection: root.cssColor(view.selection),
        fontFamily: view.fontFamily, proseFontFamily: view.proseFontFamily, scale: view.textScale}
    }
  }

  function publishStatus() {
    if (!root.pageReady) return
    const status = JSON.stringify(root.currentStatus())
    if (status === root.lastStatus) return
    root.lastStatus = status
    root.post({type: "status", status: JSON.parse(status)})
  }

  // Coalesce model changes. Status (draft revision, pending, choices) goes
  // out at the end of the current event-loop pass, so the page learns about
  // host-side draft changes as early as possible. Rows are diffed and sent
  // at most every 30 ms while text streams; status always follows them.
  function schedule(rows) {
    if (rows) {
      root.rowsDirty = true
      if (!flush.running) flush.start()
      return
    }
    Qt.callLater(root.publishStatus)
  }

  Timer {
    id: flush
    interval: 30
    onTriggered: {
      if (root.rowsDirty) root.publishRows()
      root.publishStatus()
    }
  }

  // Bindings that only exist to notice model changes. Each reads the values
  // the page shows, so any change schedules an update.
  readonly property var rowsWatch: root.view ? [root.view.shownRows, root.view.session ? root.view.session.id : ""] : []
  onRowsWatchChanged: root.schedule(true)
  readonly property string statusWatch: root.view ? JSON.stringify([root.view.session ? root.view.session.status : "",
    root.view.displayedRefusedDraft,
    root.view.session && root.view.session.application ? root.view.session.application.version : 0,
    root.view.draftRevision, root.view.canSend, root.view.pendingSubmission !== null, root.view.pendingChoice !== null,
    root.view.inputError, root.view.recordingAvailable, root.view.recordingState, root.view.recordingBusy,
    root.view.canRecord, root.view.stopRecordingPending, root.view.displayedChoices, root.view.ownStopRunId,
    root.view.voiceStatus, root.view.voiceTarget, root.view.online, root.view.paused, root.view.hasOlder,
    root.view.historyPending, root.view.historyError, root.view.historyChanged, root.view.atLatest,
    root.view.displayedDraftSource, root.view.displayedRecordingNotice, String(root.view.foreground),
    String(root.view.background), root.view.textScale]) : ""
  onStatusWatchChanged: root.schedule(false)

  // The page's only native interface. Arguments come from page JavaScript:
  // every method validates them against the current model before acting.
  // Results are JSON strings, decoded by the page.
  QtObject {
    id: bridge
    WebChannel.id: "companion"
    signal message(string json)

    function sameSession(sessionId) {
      return root.view !== null && root.view.session !== null && typeof sessionId === "string"
        && sessionId === root.view.session.id && sessionId === root.view.displayedId
    }

    // The page loaded (or reloaded): send everything again.
    function ready() {
      if (root.readyTimedOut) return false
      root.readyCount++
      root.pageReady = true
      root.operational = true
      root.sentRows = ({})
      root.lastStatus = ""
      root.fullRows = true
      root.rowsDirty = true
      flush.stop()
      root.publishRows()
      root.publishStatus()
      return true
    }

    function editDraft(sessionId, base, text, cursor) {
      const view = root.view
      if (!view) return JSON.stringify({accepted: false, reason: "unavailable"})
      // Recording appends to this draft; typing meanwhile is not accepted
      // (the page shows the composer read-only), so words never interleave.
      // Every refusal keeps the person's text in the host (refusedDrafts).
      function refuse(reason) {
        if (typeof sessionId === "string" && typeof text === "string" && text.length <= 4 * view.maximumMessageLength
            && !(sessionId === view.displayedId && text === view.pageDraft().text)) {
          view.keepRefusedDraft(sessionId, text)
        }
        return JSON.stringify({accepted: false, reason: reason, draft: view.pageDraft()})
      }
      if (view.recordingBusy) return refuse("recording")
      // The listener's own limit is 8000; the page cannot send more than
      // twice that across the bridge, so oversize text is visibly refused.
      const check = ChatState.draftEditAllowed({sessionId: sessionId, base: base, text: text},
        view.displayedId, view.draftRevision, 2 * view.maximumMessageLength)
      if (!check.allowed) return refuse(check.reason)
      view.replaceDraftFromPage(text, typeof cursor === "number" ? cursor : text.length)
      return JSON.stringify({accepted: true})
    }

    // `text` is what the page shows. Sending requires it to be exactly the
    // host draft at the revision the page knows, so a refused or still
    // unapplied edit can never result in older text being sent.
    function send(sessionId, base, text) {
      const view = root.view
      if (!sameSession(sessionId) || base !== view.draftRevision || !view.canSend
          || typeof text !== "string" || text !== view.pageDraft().text || view.displayedRefusedDraft !== "") {
        return JSON.stringify({accepted: false})
      }
      view.submit()
      return JSON.stringify({accepted: view.pendingSubmission !== null})
    }

    function moveCursor(sessionId, base, cursor) {
      const view = root.view
      if (!sameSession(sessionId) || base !== view.draftRevision || typeof cursor !== "number"
          || !Number.isInteger(cursor) || cursor < 0 || cursor > view.pageDraft().text.length) {
        return false
      }
      view.setPageCursor(cursor)
      return true
    }

    function resolveRefused(sessionId, how) {
      if (!sameSession(sessionId)) return false
      return root.view.resolveRefusedDraft(sessionId, how)
    }

    function choose(sessionId, revision, index) {
      const view = root.view
      if (!sameSession(sessionId) || !view.online || view.pendingChoice !== null || view.pendingSubmission !== null) {
        return JSON.stringify({accepted: false})
      }
      const choice = view.displayedChoices.find(entry => entry.sessionId === sessionId
        && entry.revision === revision && entry.index === index && entry.available === true)
      if (!choice) return JSON.stringify({accepted: false})
      view.requestChoice(sessionId, revision, index)
      return JSON.stringify({accepted: true})
    }

    function stopRun(sessionId, runId) {
      const view = root.view
      if (!sameSession(sessionId) || !view.online || runId === "" || runId !== view.ownStopRunId) {
        return JSON.stringify({accepted: false})
      }
      view.stopRunRequested(sessionId, runId)
      return JSON.stringify({accepted: true})
    }

    // The conversation's own Stop, for a run without a run-scoped control.
    function stop(sessionId) {
      const view = root.view
      if (!sameSession(sessionId) || !view.online || !view.running || view.ownStopRunId !== "") {
        return JSON.stringify({accepted: false})
      }
      view.stopRequested(sessionId)
      return JSON.stringify({accepted: true})
    }

    function closeSession(sessionId) {
      const view = root.view
      if (!sameSession(sessionId) || !view.online || view.recordingBusy) return JSON.stringify({accepted: false})
      view.dismissRequested(sessionId)
      return JSON.stringify({accepted: true})
    }

    function toggleRecording(sessionId) {
      if (!sameSession(sessionId)) return JSON.stringify({accepted: false})
      root.view.toggleRecording()
      return JSON.stringify({accepted: true})
    }

    function history(sessionId, request) {
      const view = root.view
      if (!sameSession(sessionId) || !view.online) return JSON.stringify({accepted: false})
      if (request === "older") view.loadOlder()
      else if (request === "newer") view.loadNewer()
      else if (request === "latest") view.latestHistory()
      else if (request === "retry") view.retryHistory()
      else if (request === "refresh") view.refreshHistory()
      else return JSON.stringify({accepted: false})
      return JSON.stringify({accepted: true})
    }

    // Reading position: the page follows the live end unless the reader
    // scrolled away, exactly like the QML transcript's followEnd.
    function following(sessionId, atEnd) {
      if (sameSession(sessionId)) root.view.followEnd = atEnd === true && !root.view.historyDetached
      return true
    }

    function composerFocus(focused) {
      root.pageComposerFocused = focused === true
      if (focused === true) root.interactionStarted()
      return true
    }

    function copyText(text) {
      if (typeof text !== "string" || text.length > 262144) return false
      root.view.copyMessage(text)
      return true
    }

    function openLink(url) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 8192) return false
      Qt.openUrlExternally(url)
      return true
    }

    // Screenshots are referenced by resident row key; the page never names
    // a URL, so it cannot ask the host to open anything else.
    function openScreenshot(sessionId, key) {
      if (!sameSession(sessionId)) return false
      const row = root.view.shownRows.find(entry => entry.key === key)
      if (!row || !row.message.screenshot || !row.message.screenshotUrl) return false
      root.view.screenshotRequested(row.message.screenshotUrl, root.view.session.title)
      return true
    }

    function openOrigin(sessionId, key) {
      if (!sameSession(sessionId)) return false
      const row = root.view.shownRows.find(entry => entry.key === key)
      const origin = row ? row.message.origin : null
      if (!origin || origin.kind !== "agent" || !origin.sessionId || root.view.openableOrigins[origin.sessionId] !== true) return false
      root.view.originRequested(origin.sessionId, origin.sourceGroupId || "")
      return true
    }

    function classicView() {
      root.classicRequested()
      return true
    }

    function openApp() {
      root.appRequested()
      return true
    }
  }

  WebChannel {
    id: channel
    registeredObjects: [bridge]
  }

  WebEngineView {
    id: browser
    objectName: "trustedChatBrowser"
    anchors.fill: parent
    visible: root.running
    backgroundColor: "transparent"
    focus: true
    webChannel: channel
    profile: ShellProfile {
      id: shellProfile
      surface: "chat"
      bundleDirectory: root.bundleDirectory
    }
    url: shellProfile.documentUrl
    onActiveFocusChanged: {
      if (activeFocus) root.interactionStarted()
      else root.pageComposerFocused = false
    }

    settings.javascriptCanOpenWindows: false
    settings.javascriptCanAccessClipboard: false
    settings.javascriptCanPaste: false
    settings.localContentCanAccessFileUrls: false
    settings.localContentCanAccessRemoteUrls: false
    settings.dnsPrefetchEnabled: false
    settings.webRTCPublicInterfacesOnly: true
    settings.fullScreenSupportEnabled: false
    settings.screenCaptureEnabled: false
    settings.navigateOnDropEnabled: false
    settings.autoLoadIconsForPage: false
    settings.pdfViewerEnabled: false
    settings.errorPageEnabled: false
    settings.focusOnNavigationEnabled: false

    onNavigationRequested: request => {
      if (request.isMainFrame && request.url.toString() !== shellProfile.documentUrl.toString()) request.reject()
    }
    onNewWindowRequested: request => { /* Links open through the bridge's openLink. */ }
    onPermissionRequested: permission => permission.deny()
    onFileDialogRequested: request => request.reject()
    onJavaScriptDialogRequested: request => request.reject()
    onFullScreenRequested: request => request.reject()
    onContextMenuRequested: request => request.accepted = true
    onLoadingChanged: request => {
      // A reload is not marked here: Chromium's load notification can
      // arrive after the new page's ready(). Updates sent while a page
      // reloads are lost with the old document; the new page's ready()
      // resynchronizes everything.
      if (request.status === WebEngineView.LoadFailedStatus) root.loadFailed = true
    }
    onRenderProcessTerminated: (status, exitCode) => {
      root.pageReady = false
      root.loadFailed = true
    }
  }
}
