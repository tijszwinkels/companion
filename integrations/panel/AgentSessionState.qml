import QtQuick

// Portable client state for snapshots and incremental message updates. Retain
// known IDs across reconnects so token updates never reopen a dismissed panel.
QtObject {
  id: root
  property var sessions: []
  property var previousSessions: []
  property bool showingPrevious: false
  property string selectedId: ""
  property var knownIds: ({})
  signal revealRequested()

  function announce(entries) {
    let newest = ""
    for (const entry of entries) {
      if (!root.knownIds[entry.id]) {
        root.knownIds[entry.id] = true
        newest = entry.id
      }
    }
    if (newest) {
      root.showingPrevious = false
      root.selectedId = newest
      root.revealRequested()
    }
  }

  function replace(entries) {
    root.sessions = entries || []
    if (!root.sessions.some(entry => entry.id === root.selectedId)) {
      root.selectedId = ""
    }
    root.announce(root.sessions)
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
  }

  function restore(session) {
    root.sessions = root.sessions.filter(entry => entry.id !== session.id).concat([session])
    root.knownIds[session.id] = true
    root.showingPrevious = false
    root.selectedId = session.id
    root.revealRequested()
  }

  function remove(id) {
    root.sessions = root.sessions.filter(entry => entry.id !== id)
    if (root.selectedId === id) {
      root.selectedId = ""
    }
  }
}
