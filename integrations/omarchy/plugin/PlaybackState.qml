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
