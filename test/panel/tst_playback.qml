import QtQuick
import QtTest
import "../../integrations/omarchy/plugin" as Adapter
import "../../integrations/panel" as Panel

Item {
  Component {
    id: playerComponent
    QtObject {
      property bool isPlaying: false
      property bool canPause: true
      property int pauseRequests: 0
      // The reply is deliberately separate from the request, like real MPRIS.
      function pause() { pauseRequests++ }
    }
  }

  Component {
    id: playbackComponent
    Adapter.PlaybackState { }
  }

  Component {
    id: focusComponent
    Panel.ComposerFocus {
      available: true
      mapped: true
      sessionId: "question-1"
      onFocusRequested: actualFocus = true
      onReleaseRequested: actualFocus = false
    }
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

    function test_pause_requests_only_playing_players_that_support_pause() {
      const first = createTemporaryObject(playerComponent, parent, {isPlaying: true})
      const second = createTemporaryObject(playerComponent, parent, {isPlaying: true})
      const stopped = createTemporaryObject(playerComponent, parent)
      const unsupported = createTemporaryObject(playerComponent, parent, {isPlaying: true, canPause: false})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [first, second, stopped, unsupported]})
      playback.pausePlaying()
      compare(first.pauseRequests, 1)
      compare(second.pauseRequests, 1)
      compare(stopped.pauseRequests, 0)
      compare(unsupported.pauseRequests, 0)
      compare(playback.playing, true, "A pause request is not a playback acknowledgement")
      first.isPlaying = false
      second.isPlaying = false
      compare(playback.playing, true, "An unpausable player still prevents automatic listening")
      playback.players = [first, second, stopped]
      compare(playback.playing, false)
      playback.pausePlaying()
      compare(first.pauseRequests, 1, "Already paused players are left alone")
    }

    function test_focus_acquisition_pauses_once_but_release_and_cancellation_do_not() {
      const player = createTemporaryObject(playerComponent, parent, {isPlaying: true})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player]})
      const focus = createTemporaryObject(focusComponent, parent)
      focus.focusRequested.connect(function() { playback.pausePlaying() })
      focus.toggle("0xabc", false)
      compare(player.pauseRequests, 1)
      focus.toggle("0xabc", true)
      compare(player.pauseRequests, 1, "Returning to the application does not pause again")
      focus.available = false
      focus.toggle("0xabc", false)
      compare(player.pauseRequests, 1)
      focus.mapped = false
      focus.available = true
      focus.toggle("0xabc", false)
      compare(player.pauseRequests, 1, "Wait for the panel to map")
      focus.toggle("0xabc", false)
      focus.mapped = true
      compare(player.pauseRequests, 1, "Cancelled focus does not pause media")
      focus.toggle("0xabc", false)
      compare(player.pauseRequests, 2)
    }
  }
}
