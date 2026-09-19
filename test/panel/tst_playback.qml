import QtQuick
import QtTest
import "../../integrations/omarchy/plugin" as Adapter
import "../../integrations/panel" as Panel

Item {
  Component {
    id: playerComponent
    QtObject {
      // Match MPRIS states: Stopped = 0, Playing = 1, Paused = 2.
      property int playbackState: 0
      readonly property bool isPlaying: playbackState === 1
      property bool canPause: true
      property bool canPlay: true
      property int pauseRequests: 0
      property int playRequests: 0
      property var commands: []
      // The reply is deliberately separate from the request, like real MPRIS.
      function pause() { pauseRequests++; commands = commands.concat("pause") }
      function play() {
        // Quickshell suppresses Play when its cached state is already Playing.
        if (isPlaying) return
        playRequests++
        commands = commands.concat("play")
      }
    }
  }

  Component {
    id: playbackComponent
    Adapter.PlaybackState { pausedState: 2 }
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

      first.playbackState = 1
      compare(playback.playing, true)
      second.playbackState = 1
      first.playbackState = 2
      compare(playback.playing, true)
      second.playbackState = 2
      compare(playback.playing, false)
    }

    function test_initial_playing_and_player_removal() {
      const player = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player]})
      compare(playback.playing, true)
      playback.players = []
      compare(playback.playing, false)
      player.playbackState = 2
      player.playbackState = 1
      compare(playback.playing, false, "Removed players no longer affect playback")
      playback.players = [player]
      compare(playback.playing, true)
    }

    function test_pause_requests_only_playing_players_that_support_pause() {
      const first = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const second = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const stopped = createTemporaryObject(playerComponent, parent)
      const unsupported = createTemporaryObject(playerComponent, parent, {playbackState: 1, canPause: false})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [first, second, stopped, unsupported]})
      playback.pausePlaying()
      compare(first.pauseRequests, 1)
      compare(second.pauseRequests, 1)
      compare(stopped.pauseRequests, 0)
      compare(unsupported.pauseRequests, 0)
      compare(playback.playing, true, "A pause request is not a playback acknowledgement")
      first.playbackState = 2
      second.playbackState = 2
      compare(playback.playing, true, "An unpausable player still prevents automatic listening")
      playback.players = [first, second, stopped]
      compare(playback.playing, false)
      playback.pausePlaying()
      compare(first.pauseRequests, 1, "Already paused players are left alone")
    }

    function test_focus_acquisition_pauses_once_but_release_and_cancellation_do_not() {
      const player = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player]})
      const focus = createTemporaryObject(focusComponent, parent)
      focus.focusRequested.connect(function() { playback.pausePlaying() })
      focus.releaseRequested.connect(function() { playback.resumePaused() })
      focus.toggle("0xabc", false)
      compare(player.pauseRequests, 1)
      player.playbackState = 2
      focus.toggle("0xabc", true)
      compare(player.pauseRequests, 1, "Returning to the application does not pause again")
      compare(player.playRequests, 1)
      player.playbackState = 1
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

    function test_restore_only_players_interrupted_by_companion_once() {
      const first = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const second = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const alreadyPaused = createTemporaryObject(playerComponent, parent, {playbackState: 2})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [first, second, alreadyPaused]})
      playback.pausePlaying()
      first.playbackState = 2
      second.playbackState = 2
      playback.pausePlaying()
      compare(first.pauseRequests, 1, "Repeated acquisition keeps the original restore list")
      playback.resumePaused()
      compare(first.playRequests, 1)
      compare(second.playRequests, 1)
      compare(alreadyPaused.playRequests, 0)
      playback.resumePaused()
      compare(first.playRequests, 1, "Focus and window callbacks cannot restore twice")
      compare(playback.playing, false, "Wait for actual resumed playback to report Playing")
      first.playbackState = 1
      compare(playback.playing, true)
    }

    function test_user_media_changes_and_removed_players_cancel_restoration() {
      const stopped = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const resumed = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const removed = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const replacement = createTemporaryObject(playerComponent, parent, {playbackState: 2})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [stopped, resumed, removed]})
      playback.pausePlaying()
      stopped.playbackState = 2
      resumed.playbackState = 2
      removed.playbackState = 2
      stopped.playbackState = 0
      resumed.playbackState = 1
      resumed.playbackState = 2
      playback.players = [stopped, resumed, replacement]
      playback.resumePaused()
      for (const player of [stopped, resumed, removed, replacement]) compare(player.playRequests, 0)
    }

    function test_quick_release_waits_for_pause_before_play_and_honors_capabilities() {
      const player = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const cannotResume = createTemporaryObject(playerComponent, parent, {playbackState: 1, canPlay: false})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player, cannotResume]})
      playback.pausePlaying()
      playback.resumePaused()
      compare(player.commands.join(","), "pause")
      player.playbackState = 2
      cannotResume.playbackState = 2
      compare(player.commands.join(","), "pause,play")
      compare(cannotResume.playRequests, 0)
      compare(playback.interruptedPlayers.length, 0)
      playback.resumePaused()
      compare(player.playRequests, 1, "A duplicate release cannot send another Play")
    }

    function test_refocusing_cancels_pending_restore_and_unanswered_pause_expires() {
      const player = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player], restoreTimeoutMs: 40})
      playback.pausePlaying()
      playback.resumePaused()
      playback.pausePlaying()
      player.playbackState = 2
      compare(player.playRequests, 0, "Returning to the composer keeps the pending pause")
      playback.resumePaused()
      compare(player.playRequests, 1)
      player.playbackState = 1
      playback.pausePlaying()
      playback.resumePaused()
      tryCompare(playback, "interruptedPlayers", [])
      player.playbackState = 2
      compare(player.playRequests, 1, "An unrelated later pause must not resume playback")
    }

    function test_outside_focus_loss_restores_without_a_second_shortcut() {
      const player = createTemporaryObject(playerComponent, parent, {playbackState: 1})
      const playback = createTemporaryObject(playbackComponent, parent, {players: [player]})
      const focus = createTemporaryObject(focusComponent, parent)
      focus.focusRequested.connect(function() { playback.pausePlaying() })
      focus.actualFocusChanged.connect(function() {
        if (!focus.actualFocus) playback.resumePaused()
      })
      focus.toggle("0xabc", false)
      player.playbackState = 2
      focus.actualFocus = false
      compare(player.playRequests, 1)
      compare(focus.grabRequested, false)
    }
  }
}
