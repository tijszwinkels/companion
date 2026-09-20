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
        newest = entry.id
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

  function restore(session) {
    root.forget(session.id)
    root.sessions = root.sessions.filter(entry => entry.id !== session.id).concat([session])
    root.knownIds[session.id] = true
    root.select(session.id)
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
