import QtQuick
import QtTest
import "../../integrations/omarchy/plugin" as Adapter

Item {
  Component {
    id: playerComponent
    QtObject { property bool isPlaying: false }
  }

  Component {
    id: playbackComponent
    Adapter.PlaybackState { }
  }

  TestCase {
    name: "CompanionPlayback"
    when: windowShown

    function test_any_player_playing() {
      const first = createTemporaryObject(playerComponent, parent)
      const second = createTemporaryObject(playerComponent, parent)
      const playback = createTemporaryObject(playbackComponent, parent, {players: [first, second]})
      compare(playback.playing, false)

      first.isPlaying = true
      compare(playback.playing, true)
      second.isPlaying = true
      first.isPlaying = false
      compare(playback.playing, true)
      second.isPlaying = false
      compare(playback.playing, false)
    }

    function test_initial_playing_and_player_removal() {
      const player = createTemporaryObject(playerComponent, parent, {isPlaying: true})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player]})
      compare(playback.playing, true)
      playback.players = []
      compare(playback.playing, false)
      player.isPlaying = false
      player.isPlaying = true
      compare(playback.playing, false, "Removed players no longer affect playback")
      playback.players = [player]
      compare(playback.playing, true)
    }
  }
}
