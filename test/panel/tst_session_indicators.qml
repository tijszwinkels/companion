import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 600
  height: 800
  Component { id: stateComponent; Panel.AgentSessionState {} }
  Component {
    id: panelComponent
    Rectangle {
      width: 600
      height: 800
      color: "#161e2b"
      property alias panel: body
      Panel.PanelContent {
        id: body
        anchors.fill: parent
        online: true; paused: false; speaking: false; processing: 0
        foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
        fontFamily: "sans-serif"
      }
    }
  }

  function session(id, status, turn) {
    return {id: id, title: "🌱 Garden ideas", status: status, completedTurnId: turn,
      messages: [], model: "fixture", error: "", updatedAt: 123}
  }

  TestCase {
    name: "CompanionSessionIndicators"
    when: windowShown

    function test_hidden_completion_is_unread_until_conversation_is_viewed() {
      const state = createTemporaryObject(stateComponent, scene)
      state.update(session("one", "running", ""))
      state.update(session("one", "completed", "turn-1"))
      compare(state.unreadIds.one, true, "Selected but hidden is unread")
      state.selectedId = ""
      state.panelVisible = true
      compare(state.unreadIds.one, true, "Activity does not read conversations")
      state.showingPrevious = true
      state.selectedId = "one"
      compare(state.unreadIds.one, true, "The library does not read conversations")
      state.showingPrevious = false
      verify(!state.unreadIds.one)
      state.panelVisible = false
      state.replace([session("one", "completed", "turn-1")])
      state.update(session("one", "completed", "turn-1"))
      verify(!state.unreadIds.one, "Duplicate snapshots never resurrect read marks")
    }

    function test_visible_completion_counts_as_read_without_composer_focus() {
      const state = createTemporaryObject(stateComponent, scene, {panelVisible: true})
      state.update(session("one", "running", ""))
      state.update(session("one", "completed", "turn-1"))
      verify(!state.unreadIds.one)
      state.selectedId = ""
      state.update(session("one", "running", "turn-1"))
      state.update(session("one", "completed", "turn-2"))
      compare(state.unreadIds.one, true)
      state.selectedId = "one"
      verify(!state.unreadIds.one)
    }

    function test_leaving_previous_reads_only_the_chosen_destination() {
      for (const destination of ["", "two"]) {
        const state = createTemporaryObject(stateComponent, scene, {panelVisible: true})
        state.replace([session("one", "running", ""), session("two", "running", "")])
        state.select("one")
        state.showingPrevious = true
        state.update(session("one", "completed", "turn-1"))
        state.update(session("two", "completed", "turn-2"))
        verify(state.unreadIds.one)
        verify(state.unreadIds.two)

        const viewed = []
        state.viewedIdChanged.connect(function() { viewed.push(state.viewedId) })
        state.select(destination)

        compare(state.viewedId, destination)
        verify(state.unreadIds.one, "The retained conversation was never viewed")
        verify(!viewed.includes("one"), "No intermediate view may consume an unread mark")
        compare(Boolean(state.unreadIds.two), destination !== "two")
      }
    }

    function test_new_and_restored_sessions_do_not_read_the_previous_selection() {
      for (const action of ["update", "restore"]) {
        const state = createTemporaryObject(stateComponent, scene, {panelVisible: true})
        state.replace([session("one", "running", "")])
        state.showingPrevious = true
        state.update(session("one", "completed", "turn-1"))
        verify(state.unreadIds.one)

        state[action](session("new", "running", ""))

        compare(state.viewedId, "new")
        compare(state.showingPrevious, false)
        verify(state.unreadIds.one, "Opening another conversation does not read the retained one")
      }
    }

    function test_reconnect_recovers_success_even_when_next_queued_turn_is_running() {
      const state = createTemporaryObject(stateComponent, scene)
      state.replace([session("one", "running", "")])
      state.replace([session("one", "running", "missed-turn")])
      compare(state.unreadIds.one, true)
      state.update(session("one", "error", "missed-turn"))
      compare(state.unreadIds.one, true, "A later error does not erase an unread success")
      state.panelVisible = true
      verify(!state.unreadIds.one)
      state.panelVisible = false
      state.replace([session("one", "cancelled", "missed-turn")])
      verify(!state.unreadIds.one)
      state.replace([session("one", "completed", "new-turn")])
      compare(state.unreadIds.one, true)
    }

    function test_old_backend_failure_and_restore_do_not_invent_completions() {
      const state = createTemporaryObject(stateComponent, scene)
      state.update(session("one", "completed", undefined))
      state.update(session("one", "error", undefined))
      state.update(session("one", "cancelled", undefined))
      compare(Object.keys(state.unreadIds).length, 0)
      state.update(session("one", "completed", "turn-1"))
      state.remove("one")
      verify(!state.unreadIds.one)
      state.restore(session("one", "completed", undefined))
      verify(!state.unreadIds.one)
      state.update(session("one", "completed", "turn-2"))
      state.replace([])
      verify(!state.unreadIds.one, "Closing while disconnected also forgets unread state")
      verify(!state.completedTurns.one)
    }

    function test_emoji_tokens_stay_whole_and_plain_titles_keep_the_number() {
      const host = createTemporaryObject(panelComponent, scene)
      host.panel.sessions = [session("one", "completed", "")]
      const tab = findChild(host, "tab-one")
      for (const emoji of ["🌱", "👩🏽‍💻", "🇳🇱", "❤️", "1️⃣"]) {
        tab.title = emoji + " Garden ideas"
        compare(tab.glyph, emoji)
        compare(tab.caption, "Garden ideas")
      }
      tab.title = "Ordinary question"
      compare(tab.glyph, "Q1")
      compare(tab.caption, "Ordinary question")
      tab.title = "🌱"
      compare(tab.glyph, "🌱")
      compare(tab.caption, "")
    }

    function test_wake_badge_has_its_own_row_data() {
      const rows = []
      for (const unit of [0.8, 1, 1.5]) {
        for (const emoji of [true, false]) {
          for (const count of [0, 1, 12]) {
            rows.push({tag: unit + "-" + emoji + "-" + count, unit: unit, emoji: emoji, count: count})
          }
        }
      }
      return rows
    }

    function test_wake_badge_has_its_own_row(data) {
      const host = createTemporaryObject(panelComponent, scene)
      host.panel.unit = data.unit
      const item = session("wake", "completed", "")
      item.title = data.emoji ? "🌱 Garden ideas" : "Ordinary question"
      item.wakes = Array.from({length: data.count}, (_, i) => ({id: "timer-" + i, state: "scheduled"}))
      host.panel.sessions = [item]
      const tab = findChild(host, "tab-wake")
      tab.number = 16
      const wake = findChild(tab, "sessionWakeCount")
      const glyph = findChild(tab, "sessionGlyph")
      const caption = findChild(tab, "sessionCaption")
      verify(waitForRendering(host))
      compare(wake.visible, data.count > 0)
      compare(wake.text, "◷" + data.count)
      compare(tab.width, 60 * data.unit)
      if (data.count > 0) {
        verify(wake.y >= glyph.parent.y + glyph.parent.height, "Timer row is below the badge/number area")
        verify(wake.y + wake.height <= caption.y, "Timer row cannot overlap the title")
        verify(wake.x >= 0 && wake.x + wake.width <= tab.width, "Timer count fits inside the tab")
        verify(caption.height >= 2 * caption.font.pixelSize, "Keep space for the two-line title")
        verify(tab.height > 62 * tab.tabUnit, "Reserve real room for the timer row")
      } else {
        compare(tab.height, 62 * tab.tabUnit, "No timers means unchanged compact geometry")
        compare(caption.y, 33 * tab.tabUnit)
      }
      tab.wakeCount = 0
      compare(wake.visible, false)
      compare(tab.height, 62 * tab.tabUnit, "Cancelling the last timer removes the extra row")
    }

    function test_hover_shows_full_plain_title_and_yields_to_close_tip() {
      const host = createTemporaryObject(panelComponent, scene)
      const item = session("one", "completed", "")
      item.title = "🌱 A complete session title <b>not markup</b>"
      host.panel.sessions = [item]
      const tab = findChild(host, "tab-one")
      const tooltip = findChild(tab, "sessionTitleTooltip")
      mouseMove(tab, tab.width / 2, tab.height - 12)
      tryCompare(tooltip, "visible", true)
      compare(tooltip.text, item.title)
      compare(tooltip.contentItem.textFormat, Text.PlainText)
      verify(tooltip.width <= 350 * tab.unit)
      verify(tooltip.contentItem.height > 0)
      const close = findChild(tab, "closeSessionTab")
      tryVerify(function() { return close.opacity > 0.5 })
      mouseMove(close, close.width / 2, close.height / 2)
      tryCompare(tooltip, "visible", false)
      mouseMove(host, host.width - 10, host.height - 10)
      compare(tooltip.visible, false)
    }

    function test_running_animation_stops_hidden_offline_and_on_completion() {
      const host = createTemporaryObject(panelComponent, scene)
      host.panel.sessions = [session("one", "starting", "")]
      host.panel.unreadSessionIds = {one: true}
      const tab = findChild(host, "tab-one")
      const ring = findChild(tab, "sessionRunningRing")
      compare(tab.spinning, true)
      compare(findChild(tab, "sessionUnreadDot").visible, true)
      const rotation = ring.rotation
      tryVerify(function() { return ring.rotation !== rotation })
      host.panel.animationsEnabled = false
      compare(tab.spinning, false)
      const paused = ring.rotation
      wait(60)
      compare(ring.rotation, paused)
      host.panel.animationsEnabled = true
      host.panel.online = false
      compare(tab.spinning, false)
      host.panel.online = true
      host.visible = false
      compare(tab.spinning, false)
      host.visible = true
      compare(tab.spinning, true)
      host.panel.sessions = [session("one", "completed", "turn")]
      const finished = findChild(host, "tab-one")
      compare(finished.spinning, false)
      compare(findChild(finished, "sessionRunningRing").visible, false)
    }

    function test_selected_tab_has_a_right_edge_marker_distinct_from_hover_running_and_unread() {
      const host = createTemporaryObject(panelComponent, scene)
      const running = session("one", "running", "")
      const unread = session("two", "completed", "turn")
      unread.title = "🐛 Login fix"
      const plain = session("three", "completed", "")
      plain.title = "Original question"
      host.panel.sessions = [running, unread, plain]
      host.panel.unreadSessionIds = {two: true}
      host.panel.selectedSessionId = "two"
      verify(waitForRendering(host))
      const tabs = ["one", "two", "three"].map(id => findChild(host, "tab-" + id))
      const markers = tabs.map(tab => findChild(tab, "sessionSelectionMarker"))
      compare(markers.map(marker => marker.visible), [false, true, false])
      const marker = markers[1]
      compare(marker.x + marker.width, tabs[1].width, "The marker sits on the right edge")
      verify(marker.width >= 3 && marker.height >= tabs[1].height / 2)
      compare(marker.color.toString(), host.panel.accent.toString())
      compare(findChild(tabs[1], "sessionUnreadDot").visible, true, "Selection keeps the unread cue")
      compare(findChild(tabs[0], "sessionRunningRing").visible, true, "Running keeps its ring without a marker")
      compare(findChild(host, "activitySelectionMarker").visible, false)

      // Rendered pixels: the marker's accent line is present on the selected
      // tab only, including while another tab is hovered.
      mouseMove(tabs[2], tabs[2].width / 2, tabs[2].height - 8)
      tryVerify(function() { return tabs[2].hovered })
      compare(markers[2].visible, false, "Hover is not selection")
      const image = grabImage(host)
      function sample(tab) {
        const point = tab.mapToItem(host, tab.width - 1.5 * tab.tabUnit, tab.height / 2)
        return image.pixel(Math.round(point.x), Math.round(point.y))
      }
      compare(sample(tabs[1]).toString(), host.panel.accent.toString())
      verify(sample(tabs[2]).toString() !== host.panel.accent.toString())
      verify(sample(tabs[0]).toString() !== host.panel.accent.toString())

      // The marker never takes clicks: selecting through it and closing
      // through the hover control still work.
      let selected = ""
      let closed = ""
      host.panel.sessionSelected.connect(function(id) { selected = id })
      host.panel.dismissSessionRequested.connect(function(id) { closed = id })
      mouseClick(tabs[1], tabs[1].width - 1.5 * tabs[1].tabUnit, tabs[1].height - 10 * tabs[1].tabUnit)
      compare(selected, "two")
      const close = findChild(tabs[1], "closeSessionTab")
      mouseMove(tabs[1], tabs[1].width / 2, tabs[1].height / 2)
      tryVerify(function() { return close.opacity > 0.5 })
      mouseClick(close, close.width / 2, close.height / 2)
      compare(closed, "two")

      host.panel.selectedSessionId = "three"
      compare(markers.map(item => item.visible), [false, false, true], "The marker follows selection")
      host.panel.selectedSessionId = ""
      compare(markers.map(item => item.visible), [false, false, false])
      compare(findChild(host, "activitySelectionMarker").visible, true, "Activity uses the same marker")
      host.panel.showingPrevious = true
      compare(findChild(host, "activitySelectionMarker").visible, false)
      compare(findChild(host, "previousSelectionMarker").visible, true)
      host.panel.showingPrevious = false
      host.panel.selectedSessionId = "two"
      verify(waitForRendering(host))
      grabImage(host).save("/tmp/companion-session-selection-marker.png")
    }

    function test_visual_preview() {
      const host = createTemporaryObject(panelComponent, scene)
      const active = session("one", "running", "")
      const done = session("two", "completed", "turn")
      done.title = "🐛 Login fix"
      const read = session("three", "completed", "turn")
      read.title = "🧭 Next steps"
      const plain = session("four", "completed", "")
      plain.title = "Original question"
      host.panel.sessions = [active, done, read, plain]
      host.panel.unreadSessionIds = {two: true}
      host.panel.selectedSessionId = "one"
      verify(waitForRendering(host))
      let saved = false
      host.grabToImage(function(result) {
        saved = result.saveToFile("/tmp/companion-session-indicators.png")
      })
      tryVerify(function() { return saved })
    }

    function test_streaming_renaming_and_removing_other_tabs_preserve_tab_objects() {
      const host = createTemporaryObject(panelComponent, scene)
      host.panel.sessions = [session("one", "running", ""), session("two", "running", "")]
      const first = findChild(host, "tab-one")
      const second = findChild(host, "tab-two")
      const ring = findChild(first, "sessionRunningRing")
      const rotation = ring.rotation
      const renamed = session("one", "running", "")
      renamed.title = "🐛 Updated title"
      renamed.messages = [{id: "answer", kind: "assistant", text: "A token", state: "running"}]
      host.panel.sessions = [renamed, session("two", "running", "")]
      compare(findChild(host, "tab-one"), first)
      compare(findChild(first, "sessionRunningRing"), ring)
      compare(ring.rotation, rotation, "A token must not reset the animation")
      compare(first.title, renamed.title)
      host.panel.sessions = [session("two", "running", ""), renamed]
      compare(findChild(host, "tab-one"), first)
      compare(first.number, 2)
      compare(findChild(host, "tab-two"), second)
      host.panel.sessions = [session("two", "running", "")]
      compare(findChild(host, "tab-two"), second)
      compare(second.number, 1)
      let selected = ""
      host.panel.sessionSelected.connect(function(id) { selected = id })
      mouseClick(second, 20, 35)
      compare(selected, "two")
    }
  }
}
