import QtQuick

// Aggregate player-reported state only. Keeping the player list injectable lets
// tests exercise changes and disappearing players without a desktop or D-Bus.
Item {
  id: root

  property var players: []
  required property int pausedState
  property bool playing: false
  property var interruptedPlayers: []
  property int restoreTimeoutMs: 5000

  function update() {
    root.playing = root.players.some(player => player && player.isPlaying)
    const restore = []
    // A stopped/removed player, or one resumed by the user after our pause,
    // no longer belongs to this focus interaction. Never restart it later.
    root.interruptedPlayers = root.interruptedPlayers.filter(entry => {
      const player = entry.player
      if (!player || !root.players.includes(player)) return false
      if (player.playbackState === root.pausedState) {
        entry.pauseObserved = true
        if (entry.restoreRequested) {
          if (player.canPlay) restore.push(player)
          return false
        }
        return true
      }
      return player.isPlaying && !entry.pauseObserved
    })
    restoreExpiry.running = root.interruptedPlayers.some(entry => entry.restoreRequested)
    // Clear ownership before sending Play, which may synchronously change state.
    for (const player of restore) player.play()
  }

  // Pause, never toggle: a stopped player must not start making sound when the
  // user summons the composer. Keep reporting actual state until players reply;
  // requesting a pause does not establish that playback has stopped.
  function pausePlaying() {
    // Re-entering before Pause replies cancels the pending restoration.
    for (const entry of root.interruptedPlayers) entry.restoreRequested = false
    restoreExpiry.stop()
    const additions = root.players
      .filter(player => player && player.isPlaying && player.canPause
        && !root.interruptedPlayers.some(entry => entry.player === player))
      .map(player => ({player: player, pauseObserved: false, restoreRequested: false}))
    // Record ownership before calling Pause, which may update state immediately.
    root.interruptedPlayers = root.interruptedPlayers.concat(additions)
    for (const entry of additions) entry.player.pause()
  }

  function resumePaused() {
    // Quickshell ignores Play while its cached state is still Playing. Wait for
    // Paused if focus was released before the outstanding Pause was acknowledged.
    for (const entry of root.interruptedPlayers) entry.restoreRequested = true
    root.update()
  }

  Timer {
    id: restoreExpiry
    interval: root.restoreTimeoutMs
    // A player that ignores Pause must not turn a later manual pause into Play.
    onTriggered: root.interruptedPlayers = root.interruptedPlayers.filter(entry => !entry.restoreRequested)
  }

  Component.onCompleted: root.update()
  Component.onDestruction: root.resumePaused()
  onPlayersChanged: root.update()

  Instantiator {
    model: root.players
    delegate: Connections {
      required property var modelData
      target: modelData
      function onPlaybackStateChanged() { root.update() }
    }
  }
}
