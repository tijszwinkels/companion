import QtQuick

// Pop-out windows of real Companion conversations, owned by the native host.
//
// Responsibilities:
// - Open, focus and close one ordinary window per popped-out conversation
//   (at most eight). The window is a view: closing it never closes the
//   conversation, and the listener stays the single source of its state.
// - Move the conversation's composer between the sidebar and its window.
//   Exactly one view owns a conversation's draft at a time. The handover is
//   synchronous and checked: the old owner is cleared only after the new one
//   confirms it holds the same text and provenance. Pending sends, choices
//   and recordings are correlated with the view that started them, so a
//   move is refused (with a reason) until they settle.
// - Describe the visible windows for the atomic `panel-state` report:
//   [{id, active, composerFocused}], changed only by real view transitions,
//   never by streamed transcript updates.
// - Serve the agent tool's presentation requests (`agent-present`) and the
//   user's buttons through the same operations.
//
// Native activation is only requested. Whether the compositor granted it is
// observed through Window.active for a bounded time and reported as such.
Item {
  id: root
  required property var client
  required property var panel
  required property var host
  required property var theme
  property bool nativeWidgets: true
  // Show conversations in the trusted HTML session surface (see SessionView).
  property bool htmlSessions: false
  readonly property int maximumWindows: 8
  // How long to observe whether the compositor activated a window we asked
  // to focus, before reporting that it did not.
  readonly property int activationWaitMilliseconds: 1500

  // Conversation id -> PopoutWindow. Plain JS object: mutate and reassign.
  property var windows: ({})
  // Ids in the order they were popped out; the report keeps this order.
  property var order: []
  // Conversation id -> true while popped out. Bound into the sidebar.
  property var poppedIds: ({})
  // Visible windows for panel-state: [{id, active, composerFocused}].
  property var report: []
  readonly property string activeId: {
    const active = root.report.find(entry => entry.active)
    return active ? active.id : ""
  }
  // Unsent text of popped-out conversations closed elsewhere: [{key, title, text}].
  property var orphanDrafts: []
  // Conversation titles at the last sessionsChanged(), so the notice for a
  // conversation that disappeared can still name it.
  property var knownTitles: ({})
  // Titles of conversations that disappeared, for text that arrives for
  // them later (a late edit). Bounded: the most recent 32.
  property var removedTitles: ({})
  property int orphanSequence: 0
  // Quiet (focus:false) openings still settling. While above zero the host
  // holds back panel-state reports, so a window that Qt or the compositor
  // briefly activated never becomes a transient voice target.
  property int quietOpenings: 0
  // Agent request ids already answered or in progress (bounded).
  property var presentRequests: ({})

  Component {
    id: windowComponent
    PopoutWindow {}
  }

  Component {
    id: activationWatch
    // Polls `check()` until it is true or the deadline passes, then calls
    // `done(active)` once and destroys itself.
    Timer {
      property var check: null
      property var done: null
      property int remaining: 0
      interval: 50
      repeat: true
      running: true
      onTriggered: {
        let active = false
        try {
          active = check !== null && check() === true
        } catch (error) {
          // The window went away while waiting: it is not focused.
          active = false
        }
        remaining -= interval
        if (active || remaining <= 0) {
          stop()
          const callback = done
          done = null
          if (callback) callback(active)
          destroy()
        }
      }
    }
  }

  function isPopped(id) {
    return root.poppedIds[id] === true
  }

  function sessionExists(id) {
    return root.client.sessions.sessions.some(entry => entry.id === id)
  }

  function sessionTitle(id) {
    const session = root.client.sessions.sessions.find(entry => entry.id === id)
    return session ? session.title : "conversation"
  }

  // The view that owns `id`'s composer: its window, or the sidebar.
  function ownerView(id) {
    return root.windows[id] ? root.windows[id].view : root.panel.conversationView
  }

  // Every conversation view, for replies that each view filters itself
  // (pending send/choice acknowledgements, history pages, recording ends).
  function allViews() {
    const views = [root.panel.conversationView]
    for (const id of root.order) {
      if (root.windows[id]) views.push(root.windows[id].view)
    }
    return views
  }

  // Ask the compositor to activate `target`, then report what happened.
  // `done(focused)` is called once, after activation or the bounded wait.
  // For the main surface, `id` names the conversation that must be the one
  // actually shown there for the focus to count.
  function activate(target, done, id) {
    if (target === root.host) {
      root.host.show(true)
      activationWatch.createObject(root, {check: function() { return root.mainShows(id) },
        done: done, remaining: root.activationWaitMilliseconds})
      return
    }
    target.show()
    target.raise()
    target.requestActivate()
    activationWatch.createObject(root, {check: function() { return target.visible && target.active },
      done: done, remaining: root.activationWaitMilliseconds})
  }

  // The main surface is active and shows conversation `id` (not Activity,
  // Previous sessions or the browser). Without an id, only activation counts.
  function mainShows(id) {
    if (root.host.active !== true) return false
    return id === undefined || root.client.mainViewId === id
  }

  function refreshReport() {
    const next = []
    for (const id of root.order) {
      const window = root.windows[id]
      if (!window || !window.visible) continue
      const active = window.active === true
      next.push({id: id, active: active,
        composerFocused: active && window.view.composerFocusId === id})
    }
    if (JSON.stringify(next) === JSON.stringify(root.report)) return
    // Membership or activation changed: a voice navigation captured against
    // the previous arrangement must not apply to this one.
    root.client.sessions.invalidateNavigation()
    root.report = next
  }

  function setPopped(id, popped) {
    const next = Object.assign({}, root.poppedIds)
    if (popped) next[id] = true
    else delete next[id]
    root.poppedIds = next
  }

  // Pop `id` out of the sidebar into its own window, or find its window.
  // Returns {outcome, reason, window}; outcome is "shown" or "conflict" /
  // "unavailable". Focus is handled separately by the caller.
  function openWindow(id) {
    if (!root.sessionExists(id)) {
      return {outcome: "unavailable", reason: "That conversation is not open in Companion."}
    }
    if (root.windows[id]) return {outcome: "shown", reason: "", window: root.windows[id]}
    if (root.order.length >= root.maximumWindows) {
      return {outcome: "conflict",
        reason: "Companion already shows " + root.maximumWindows + " conversation windows. Return one first."}
    }

    const sidebar = root.panel.conversationView
    const blocker = sidebar.transferBlocker(id)
    if (blocker !== "") return {outcome: "conflict", reason: blocker}

    // Hand the draft over before the sidebar view lets go of it.
    const draft = sidebar.exportDraft(id)
    const window = windowComponent.createObject(root, {sessionId: id, controller: root})
    if (!window) return {outcome: "unavailable", reason: "The window could not be created."}
    if (!window.view.importDraft(id, draft)) {
      window.destroy()
      return {outcome: "conflict", reason: "The unsent text could not be moved; it stays in the sidebar."}
    }

    const windows = Object.assign({}, root.windows)
    windows[id] = window
    root.windows = windows
    root.order = root.order.concat([id])
    window.activeChanged.connect(root.refreshReport)
    window.visibleChanged.connect(root.refreshReport)
    // A window kept open only for its editor's unresolved input (its
    // conversation disappeared) closes once that input is resolved.
    window.view.unresolvedInputChanged.connect(function() { Qt.callLater(root.sessionsChanged) })
    window.view.composerFocusIdChanged.connect(root.refreshReport)

    // Marking it popped detaches the sidebar view (its session becomes
    // null); only then is the sidebar's copy cleared.
    root.setPopped(id, true)
    sidebar.clearDraft(id)

    window.show()
    root.refreshReport()
    return {outcome: "shown", reason: "", window: window}
  }

  // The Companion surface that has keyboard focus now: the main surface, a
  // pop-out window, or null (another application or nothing).
  function focusedSurface() {
    if (root.host.active === true) return root.host
    for (const id of root.order) {
      if (root.windows[id] && root.windows[id].active) return root.windows[id]
    }
    return null
  }

  // After an agent opened `window` with focus:false: Qt or the compositor may
  // activate a newly shown window. If it took focus from another Companion
  // surface, give that surface its focus back, so the user's typing and
  // voice target do not move. Focus held by another application cannot be
  // restored from here; the compositor's policy decides. `done(focused)`
  // reports whether `window` ended up focused, after a short bounded wait.
  // The caller has already counted this opening in quietOpenings; it is
  // released here once the outcome is known, and then reported once.
  function keepFocus(previous, window, done) {
    let restored = false
    const previousActive = function() {
      return previous === root.host ? root.host.active === true : previous.active === true
    }
    activationWatch.createObject(root, {check: function() {
      if (window.active) {
        if (previous !== null && !restored) {
          restored = true
          if (previous === root.host) root.host.activate()
          else previous.requestActivate()
        }
        // Nothing of ours to give focus back to: the window keeps it.
        return previous === null
      }
      return restored && previousActive()
    }, done: function() {
      root.quietOpenings -= 1
      root.refreshReport()
      done(window.active === true)
    }, remaining: 300})
  }

  // Return `id` to the sidebar and close its window. Returns {outcome,
  // reason}; outcome is "returned" or "conflict".
  function closeWindow(id) {
    const window = root.windows[id]
    if (!window) return {outcome: "returned", reason: ""}

    const blocker = window.view.transferBlocker(id)
    if (blocker !== "") return {outcome: "conflict", reason: blocker}

    const sidebar = root.panel.conversationView
    const draft = window.view.exportDraft(id)
    // The sidebar is detached from this conversation while it is popped out,
    // so the draft waits in its per-conversation store until displayed.
    if (!sidebar.importDraft(id, draft)) {
      return {outcome: "conflict", reason: "The unsent text could not be moved back; it stays in this window."}
    }
    root.forget(id)
    return {outcome: "returned", reason: ""}
  }

  // Drop a window without moving its draft (already moved or orphaned).
  function forget(id) {
    const window = root.windows[id]
    const windows = Object.assign({}, root.windows)
    delete windows[id]
    root.windows = windows
    root.order = root.order.filter(entry => entry !== id)
    root.setPopped(id, false)
    if (window) {
      window.activeChanged.disconnect(root.refreshReport)
      window.visibleChanged.disconnect(root.refreshReport)
      window.view.composerFocusIdChanged.disconnect(root.refreshReport)
      window.hide()
      window.destroy()
    }
    root.refreshReport()
  }

  // User button in the sidebar: pop out and focus the new window.
  function popOut(id) {
    const result = root.openWindow(id)
    if (result.outcome !== "shown") {
      root.showError(result.reason)
      return
    }
    root.activate(result.window, function() {})
  }

  // Select a popped tab, a Focus button or "go to session N".
  function focusWindow(id) {
    if (root.windows[id]) root.activate(root.windows[id], function() {})
  }

  // Return button, native close or agent. `options.focus` also selects the
  // conversation and shows the sidebar; a native close changes nothing else.
  function returnToSidebar(id, options) {
    const window = root.windows[id]
    const result = root.closeWindow(id)
    if (result.outcome !== "returned") {
      if (window) window.notice = result.reason
      else root.showError(result.reason)
      return result
    }
    if (options && options.focus) {
      // Like clicking its tab: this also leaves the panel browser.
      root.panel.sessionSelected(id)
      root.activate(root.host, function() {}, id)
    }
    return result
  }

  function showError(reason) {
    root.client.error = reason
    root.client.errorAction = "popout"
  }

  // companion_session_present. `message` is {requestId, id, presentation,
  // focus}; `answer(result)` is called exactly once with {outcome, reason,
  // focused?}. Never creates, reopens or closes a conversation.
  function present(message, answer) {
    const requestId = message.requestId
    if (typeof requestId !== "string" || requestId === "" || requestId.length > 128
        || root.presentRequests[requestId]) return
    const seen = Object.assign({}, root.presentRequests)
    seen[requestId] = true
    const keys = Object.keys(seen)
    if (keys.length > 32) delete seen[keys[0]]
    root.presentRequests = seen

    const id = message.id
    const presentation = message.presentation
    const focus = message.focus === true
    if (typeof id !== "string" || id === "" || typeof message.focus !== "boolean") {
      answer({outcome: "unavailable", reason: "The request did not name an open conversation."})
      return
    }
    if (presentation !== "window" && presentation !== "sidebar") {
      answer({outcome: "unsupported", reason: "Companion can show a conversation in a window or in the sidebar."})
      return
    }
    if (!root.sessionExists(id)) {
      answer({outcome: "unavailable", reason: "That conversation is not open in Companion."})
      return
    }

    if (presentation === "window") {
      const existing = root.windows[id] !== undefined
      const previous = root.focusedSurface()
      // Hold reports before the window is mapped; see quietOpenings.
      const quiet = !focus && !existing
      if (quiet) root.quietOpenings += 1
      const result = root.openWindow(id)
      if (result.outcome !== "shown") {
        if (quiet) root.quietOpenings -= 1
        answer({outcome: result.outcome, reason: result.reason})
        return
      }
      if (!focus && existing) {
        answer({outcome: "shown", reason: "", focused: result.window.active === true})
        return
      }
      if (!focus) {
        root.keepFocus(previous, result.window, function(focused) {
          answer({outcome: "shown", reason: "", focused: focused})
        })
        return
      }
      root.activate(result.window, function(focused) {
        answer({outcome: "shown", focused: focused,
          reason: focused ? "" : "The window is open; the desktop did not give it keyboard focus."})
      })
      return
    }

    const returned = root.returnToSidebar(id, {focus: false, source: "agent"})
    if (returned.outcome !== "returned") {
      answer({outcome: returned.outcome, reason: returned.reason})
      return
    }
    if (!focus) {
      answer({outcome: "returned", reason: "", focused: root.mainShows(id)})
      return
    }
    root.panel.sessionSelected(id)
    root.activate(root.host, function(focused) {
      answer({outcome: "returned", focused: focused,
        reason: focused ? "" : "The conversation is back in the sidebar; the desktop did not give it keyboard focus."})
    }, id)
  }

  // Closing a conversation, from any control (HTML or native rail, header,
  // footer, a pop-out window, app mode). Every view that may own part of its
  // state must agree: text not saved or only in an editor, a message or
  // choice still being confirmed, words still being recorded. Returns why
  // not, or "".
  function closeBlocker(id) {
    for (const view of root.allViews()) {
      const blocker = view.transferBlocker(id)
      if (blocker !== "") return blocker
      if (view.displayedId === id && view.recordingBusy) {
        return "Words are still being recorded into this conversation. Wait for the recording to finish."
      }
    }
    return ""
  }

  // The one place that asks the listener to close a conversation. A refusal
  // is shown (in the window too, when the conversation is popped out).
  function closeSession(id) {
    const blocker = root.closeBlocker(id)
    if (blocker !== "") {
      const reason = "The conversation was not closed. " + blocker
      root.client.error = reason
      root.client.errorAction = "close"
      if (root.windows[id]) root.windows[id].notice = reason
      return false
    }
    root.client.send({action: "close-agent", id: id})
    return true
  }

  function addOrphan(title, text, kind) {
    root.orphanSequence += 1
    root.orphanDrafts = root.orphanDrafts.concat([{key: "orphan-" + root.orphanSequence,
      title: title, text: text, kind: kind}])
  }

  // Conversations changed. A popped-out conversation that disappeared (closed
  // by an agent or another client, or while disconnected) loses its window;
  // its unsent text, as its text box shows it (including text not saved by
  // the listener), stays available in the sidebar with Copy and Dismiss.
  // Recovery never reopens the conversation or starts a turn.
  function sessionsChanged() {
    // Titles as they were before this change, for conversations that just
    // disappeared (bounded by the conversations the listener reported).
    const previousTitles = root.knownTitles
    const titles = {}
    for (const entry of root.client.sessions.sessions) titles[entry.id] = entry.title
    root.knownTitles = titles
    const removed = Object.assign({}, root.removedTitles)
    for (const id of Object.keys(previousTitles)) {
      if (titles[id] === undefined) removed[id] = previousTitles[id]
    }
    const removedIds = Object.keys(removed)
    for (const id of removedIds.slice(0, Math.max(0, removedIds.length - 32))) delete removed[id]
    root.removedTitles = removed

    for (const id of root.order.slice()) {
      if (root.sessionExists(id)) {
        // An answer shown in a visible window has been seen. Unread marks
        // are applied after this notification, so clear them afterwards.
        if (root.windows[id] && root.windows[id].visible) {
          Qt.callLater(function() {
            if (root.windows[id] && root.windows[id].visible) root.client.sessions.markRead(id)
          })
        }
        continue
      }
      const window = root.windows[id]
      if (!window) {
        root.forget(id)
        continue
      }
      // Its editor alone holds input the host does not have: keep the
      // window (and that editor) until the person copies, shortens or
      // discards it; sessionsChanged runs again then.
      const unresolved = window.view.unresolvedInput
      if (unresolved && unresolved.sessionId === id) {
        window.notice = "This conversation was closed elsewhere. Its editor still holds text ("
          + unresolved.length + " characters) that is kept nowhere else: copy or discard it, then close this window."
        continue
      }
      const draft = window.view.exportDraft(id)
      // The window's text box already shows any unconfirmed text; take it
      // from the Client too, so it is offered exactly once.
      root.client.takeUnconfirmedDraft(id)
      if (draft.text.trim() !== "") root.addOrphan(window.lastTitle, draft.text, "draft")
      root.forget(id)
    }

    root.offerAbsentDrafts()
  }

  // A conversation shown in the sidebar (or not shown at all) that no
  // longer exists: text this UI has not had confirmed by the listener (not
  // saved, or still unanswered) would otherwise only be hidden in memory.
  // Offer it once with Copy and Dismiss; nothing reopens the conversation.
  // Runs when the conversations change AND when such text appears later
  // (an edit delivered or refused after its conversation disappeared, in
  // either order). Text only the HTML editor holds stays in that editor's
  // own notice.
  function offerAbsentDrafts() {
    const unconfirmed = new Set(Object.keys(root.client.unsavedDrafts).concat(Object.keys(root.client.latestDraftEdits)))
    for (const id of unconfirmed) {
      if (root.sessionExists(id) || root.windows[id]) continue
      const text = root.client.takeUnconfirmedDraft(id)
      if (text.trim() !== "") root.addOrphan(root.removedTitles[id] || "conversation", text, "draft")
    }
  }

  function dismissOrphan(key) {
    root.orphanDrafts = root.orphanDrafts.filter(entry => entry.key !== key)
  }

  Connections {
    target: root.client.sessions
    function onSessionsChanged() { root.sessionsChanged() }
  }
  // After the change that made the text unconfirmed has finished (callLater),
  // so the Client's state is complete when it is taken.
  Connections {
    target: root.client
    function onUnconfirmedDraftsChanged() { Qt.callLater(root.offerAbsentDrafts) }
  }

  Component.onDestruction: {
    for (const id of root.order) {
      if (root.windows[id]) root.windows[id].destroy()
    }
  }
}
