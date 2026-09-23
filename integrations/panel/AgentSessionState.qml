import QtQuick

// Portable client state for snapshots and incremental message updates. Retain
// known IDs across reconnects so token updates never reopen a dismissed panel.
QtObject {
  id: root
  property var sessions: []
  property var previousSessions: []
  property bool showingPrevious: false
  property string selectedId: ""
  readonly property string conversationId: !showingPrevious && sessions.some(entry => entry.id === selectedId) ? selectedId : ""
  property var knownIds: ({})
  property string orderRevision: ""
  property bool controlsAvailable: false
  property var modelCatalog: ({models: []})
  // Keep the last successful catalog across reconnects. Track discovery for
  // this connection separately: a failure should not retry on every tab switch.
  property bool modelsLoaded: false
  property bool modelsRequested: false
  property bool modelsLoading: false
  property string modelsError: ""
  // A request in flight must not select a tab after the user changes pages or
  // hides/reopens this UI. Each client instance has an independent token.
  property string navigationToken: Date.now().toString() + "-" + Math.random().toString()
  function invalidateNavigation() { navigationToken = Date.now().toString() + "-" + Math.random().toString() }
  onSelectedIdChanged: invalidateNavigation()
  onShowingPreviousChanged: invalidateNavigation()
  onPanelVisibleChanged: invalidateNavigation()
  signal controlRequested(var request)

  function ensureModels() {
    if (!root.modelsRequested) root.refreshModels()
  }

  function refreshModels() {
    if (!root.controlsAvailable || root.modelsLoading) return
    root.modelsRequested = true
    root.modelsLoading = true
    root.modelsError = ""
    root.controlRequested({action: "agent-models"})
  }

  function disconnectControls() {
    root.controlsAvailable = false
    root.modelsLoading = false
    root.modelsRequested = false
    root.invalidateNavigation()
  }

  function controlReceived(message) {
    if (message.type === "agent-order") {
      const byId = {}
      for (const entry of root.sessions) byId[entry.id] = entry
      // Full membership must agree. A later snapshot repairs a protocol gap;
      // never silently drop conversations on a malformed/incomplete event.
      if (!Array.isArray(message.ids) || message.ids.length !== root.sessions.length
        || new Set(message.ids).size !== message.ids.length || message.ids.some(id => !byId[id])) return
      root.sessions = message.ids.map(id => byId[id])
      root.orderRevision = message.revision
    } else if (message.type === "agent-select") {
      if (root.panelVisible && message.token === root.navigationToken
        && message.orderRevision === root.orderRevision && root.sessions.some(entry => entry.id === message.id)) {
        root.select(message.id)
      }
    } else if ((message.type === "result" || message.type === "error") && message.action === "agent-models") {
      root.modelsLoading = false
      root.modelsError = message.type === "error" ? message.message : ""
      if (!root.modelsError) {
        root.modelCatalog = message.result
        root.modelsLoaded = true
      }
    }
  }

  function move(id, beforeId) {
    if (!root.controlsAvailable || !root.orderRevision) return
    root.controlRequested({action: "move-agent", id: id, beforeId: beforeId, revision: root.orderRevision})
  }
  // Read/unread belongs to the displayed page, not keyboard/composer focus.
  // Retain it across socket reconnects, but never write it into transcripts.
  property bool panelVisible: false
  readonly property string viewedId: panelVisible ? conversationId : ""
  property var completedTurns: ({})
  property var unreadIds: ({})
  onViewedIdChanged: markRead(viewedId)
  signal revealRequested()

  function select(id) {
    // Previous sessions retains the old selection. Change the destination
    // before revealing it, so that old conversation is never briefly read.
    root.selectedId = id
    root.showingPrevious = false
  }

  function markRead(id) {
    if (!root.unreadIds[id]) return
    const unread = Object.assign({}, root.unreadIds)
    delete unread[id]
    root.unreadIds = unread
  }

  function observeCompletions(entries) {
    const unread = Object.assign({}, root.unreadIds)
    let changed = false
    for (const entry of entries) {
      const turn = entry.completedTurnId
      if (!turn || root.completedTurns[entry.id] === turn) continue
      root.completedTurns[entry.id] = turn
      if (entry.id !== root.viewedId) {
        unread[entry.id] = true
        changed = true
      }
    }
    if (changed) root.unreadIds = unread
  }

  function forget(id) {
    root.markRead(id)
    delete root.completedTurns[id]
  }

  function announce(entries) {
    let newest = ""
    for (const entry of entries) {
      if (!root.knownIds[entry.id]) {
        root.knownIds[entry.id] = true
        // An agent tool opened this tab without asking for focus. Show it in
        // the rail, but never move the user's selection or reveal the panel.
        if (entry.openInBackground !== true) newest = entry.id
      }
    }
    if (newest) {
      root.select(newest)
      root.revealRequested()
    }
  }

  function replace(entries) {
    root.sessions = entries || []
    if (!root.sessions.some(entry => entry.id === root.selectedId)) {
      root.selectedId = ""
    }
    root.announce(root.sessions)
    // A tab may have been closed while disconnected. Forget its unread state.
    for (const id of Object.keys(root.completedTurns)) {
      if (!root.sessions.some(entry => entry.id === id)) root.forget(id)
    }
    root.observeCompletions(root.sessions)
  }

  function update(patch) {
    const entries = root.sessions.slice()
    const index = entries.findIndex(entry => entry.id === patch.id)
    if (index < 0) {
      entries.push(patch)
    } else {
      const messages = entries[index].messages.slice()
      for (const message of patch.messages) {
        const position = messages.findIndex(entry => entry.id === message.id)
        if (position < 0) {
          messages.push(message)
        } else {
          messages[position] = message
        }
      }
      entries[index] = Object.assign({}, patch, {messages: messages})
    }
    root.sessions = entries
    root.announce([patch])
    root.observeCompletions([patch])
  }

  // `reveal: false` comes from an agent reopening a saved conversation without
  // focus. Older listeners omit it, which keeps the existing select-and-reveal.
  function restore(session, reveal) {
    root.forget(session.id)
    root.sessions = root.sessions.filter(entry => entry.id !== session.id).concat([session])
    root.knownIds[session.id] = true
    if (reveal === false) return
    root.select(session.id)
    root.revealRequested()
  }

  // An explicitly focused agent draft selects its conversation like a click.
  function reveal(id) {
    if (!root.sessions.some(entry => entry.id === id)) return
    root.select(id)
    root.revealRequested()
  }

  function remove(id) {
    root.forget(id)
    root.sessions = root.sessions.filter(entry => entry.id !== id)
    if (root.selectedId === id) {
      root.selectedId = ""
    }
  }
}
