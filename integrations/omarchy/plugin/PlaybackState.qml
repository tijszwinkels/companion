import QtQuick

// Aggregate player-reported state only. Keeping the player list injectable lets
// tests exercise changes and disappearing players without a desktop or D-Bus.
Item {
  id: root

  property var players: []
  property bool playing: false

  function update() {
    root.playing = root.players.some(player => player && player.isPlaying)
  }

  // Pause, never toggle: a stopped player must not start making sound when the
  // user summons the composer. Keep reporting actual state until players reply;
  // requesting a pause does not establish that playback has stopped.
  function pausePlaying() {
    for (const player of root.players) {
      if (player && player.isPlaying && player.canPause) {
        player.pause()
      }
    }
  }

  Component.onCompleted: root.update()
  onPlayersChanged: root.update()

  Instantiator {
    model: root.players
    delegate: Connections {
      required property var modelData
      target: modelData
      function onIsPlayingChanged() { root.update() }
    }
  }
}
