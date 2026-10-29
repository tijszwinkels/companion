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
  readonly property bool failed: loadFailed || unresponsive || shellProfile.error !== ""
  property bool pageReady: false
  // Bounded handshake. The page counts as operational only after its script
  // connected and called ready(); see the liveness check below for how a
  // page that never gets there, or stops answering after a reload, fails.
  property int readyTimeoutMilliseconds: 10000
  property bool operational: false
  // How often a page completed the handshake (each load calls ready()).
  property int readyCount: 0
  // The most characters one Copy hands to the clipboard. Text the host keeps
  // for recovery is at most SessionView.maximumRefusedDraftLength (262144),
  // so it always copies in one piece. Longer text only the page holds is
  // copied in numbered parts of at most this size; nothing is cut off.
  property int copyLimit: 1048576
  // The page document that last completed the handshake (see ready()).
  property string loadedDocumentId: ""
  // Liveness of the current document, checked by the host itself rather
  // than inferred from load notifications (whose order relative to ready()
  // is not guaranteed): about every second the page is asked whether its
  // bridge is connected. Missed or negative answers are counted; at
  // readyTimeoutMilliseconds worth of them - at start-up or after any
  // reload, e.g. into a failing script - the view counts as failed and the
  // native presentation becomes the visible one. A later positive answer
  // recovers it. Counting probes rather than wall-clock time keeps a
  // suspended machine or a dropped callback (navigation discards pending
  // ones) from failing a working page.
  readonly property int probeIntervalMilliseconds: 1000
  property int missedProbes: 0
  property bool probing: false
  property var lifetime: ({active: true})
  readonly property bool unresponsive: missedProbes * probeIntervalMilliseconds >= readyTimeoutMilliseconds
  Component.onDestruction: lifetime.active = false
  Timer {
    id: liveness
    interval: root.probeIntervalMilliseconds
    repeat: true
    running: shellProfile.documentUrl.toString() !== ""
    onTriggered: {
      if (root.probing) {
        // The previous question was never answered.
        root.missedProbes++
      }
      root.probing = true
      const lifetime = root.lifetime
      // The frame-level call guards against a QML context that disappears
      // while Chromium answers (see NativeWidgetView.qml).
      browser.mainFrame.runJavaScript("!!(window.companionChat && window.companionChat.connected === true)", 0, function(alive) {
        if (!lifetime.active) return
        root.probing = false
        if (alive === true) root.missedProbes = 0
        else root.missedProbes++
      })
    }
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

  // Read text only the page holds for a conversation (store.held()); the
  // callback runs once, with "" when the page does not answer in time.
  Component {
    id: deadlineComponent
    Timer {}
  }
  function collectPageHeldText(id, timeout, done) {
    let finished = false
    const deadline = deadlineComponent.createObject(root, {interval: timeout, running: true})
    function finish(text) {
      if (finished) return
      finished = true
      deadline.destroy()
      done(typeof text === "string" ? text : "")
    }
    deadline.triggered.connect(function() { finish("") })
    const lifetime = root.lifetime
    browser.mainFrame.runJavaScript("window.companionChat && window.companionChat.heldText ? window.companionChat.heldText("
      + JSON.stringify(id) + ") : ''", 0, function(text) {
      if (!lifetime.active) return
      finish(text)
    })
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
    if (!session) return {sessionId: "", copyLimit: root.copyLimit}
    const draft = view.pageDraft()
    const history = {hasOlder: view.hasOlder, pending: view.historyPending !== "", error: view.historyError,
      canRetry: view.historyError !== "" && view.failedHistoryRequest !== null,
      changed: view.historyChanged, detached: view.historyDetached, atLatest: view.atLatest}
    const recordingHere = view.recordingHere
    return {
      sessionId: session.id,
      title: session.title || "",
      sessionStatus: session.status || "",
      sessionError: typeof session.error === "string" ? session.error.slice(0, 2000) : "",
      running: view.running === true,
      online: view.online,
      paused: view.paused,
      draft: {text: draft.text, cursor: draft.cursor, revision: draft.revision, refused: draft.refused,
        source: view.displayedDraftSource, notice: view.displayedRecordingNotice},
      maximumMessageLength: view.maximumMessageLength,
      // The longest draft the bridge accepts from the page (editDraft).
      editLimit: 2 * view.maximumMessageLength,
      copyLimit: root.copyLimit,
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
        fontFamily: view.fontFamily, proseFontFamily: view.proseFontFamily, scale: view.textScale,
        unit: view.unit}
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
    root.view.displayedRefusedDraft, root.copyLimit,
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
    // `documentId` is constant for one loaded page. The page also calls
    // ready() to resynchronize after a sequence gap; only a new id is a new
    // document (a reload), which loses text that page held.
    function ready(documentId) {
      const newDocument = typeof documentId !== "string" || documentId === "" || documentId !== root.loadedDocumentId
      root.loadedDocumentId = typeof documentId === "string" ? documentId : ""
      // A new document holds nothing yet. Text an earlier document held
      // (only when the host's bounded recovery was full) is gone: say so.
      if (newDocument && root.view && Object.keys(root.view.pageHeldDrafts).length > 0) {
        root.view.pageHeldDrafts = ({})
        root.view.inputError = "Typed text that could not be kept was lost when the chat page reloaded."
      }
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
      // `kept` tells the page whether the host now holds the text. If not
      // (beyond the bound, or no free slot), the page must keep it itself.
      function refuse(reason) {
        let kept = false
        if (typeof sessionId === "string" && typeof text === "string") {
          kept = sessionId === view.displayedId && text === view.pageDraft().text
            || view.keepRefusedDraft(sessionId, text)
        }
        return JSON.stringify({accepted: false, reason: reason, kept: kept, draft: view.pageDraft()})
      }
      if (typeof sessionId !== "string" || typeof text !== "string") return refuse("invalid")
      // The listener's own limit is 8000; the page cannot send more than
      // twice that across the bridge, so oversize text is visibly refused.
      if (text.length > 2 * view.maximumMessageLength) return refuse("too-long")
      // The last edit received wins: an edit based on an older draft is no
      // longer refused. An edit typed before a switch still names its own
      // conversation and goes there, not to the one now shown.
      if (sessionId !== view.displayedId) {
        return JSON.stringify({accepted: view.writeDraftFor(sessionId, text)})
      }
      if (view.recordingBusy) return refuse("recording")
      view.replaceDraftFromPage(text, typeof cursor === "number" ? cursor : text.length)
      return JSON.stringify({accepted: true})
    }

    // `text` is what the page shows. Sending requires it to be exactly the
    // host draft at the revision the page knows, so a refused or still
    // unapplied edit can never result in older text being sent.
    function send(sessionId, base, text) {
      const view = root.view
      if (!sameSession(sessionId) || !view.canSend || typeof text !== "string" || text.trim() === ""
          || text.length > view.maximumMessageLength || view.displayedRefusedDraft !== "") {
        return JSON.stringify({accepted: false})
      }
      // Send exactly what the page shows, even if another editor changed the
      // draft meanwhile (last write wins): it becomes the draft, then is sent.
      if (text !== view.pageDraft().text) view.replaceDraftFromPage(text, text.length)
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

    function holdText(sessionId, held) {
      if (!root.view || typeof sessionId !== "string" || typeof held !== "boolean") return false
      root.view.setPageHeldDraft(sessionId, held)
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

    // Copies at most `copyLimit` characters per call (the page splits
    // longer retained text into numbered parts, see Chat.tsx CopyActions).
    // The answer says what happened, so the page can show it.
    function copyText(text) {
      if (typeof text !== "string" || text === "") {
        return JSON.stringify({accepted: false, length: 0, reason: "Nothing to copy."})
      }
      if (text.length > root.copyLimit) {
        return JSON.stringify({accepted: false, length: text.length,
          reason: "At most " + root.copyLimit + " characters can be copied at once."})
      }
      root.view.copyMessage(text)
      return JSON.stringify({accepted: true, length: text.length, reason: ""})
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
