import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// Activity previously nested a capped history ListView inside the page
// Flickable. A wheel over the cards scrolled only that inner list, so the page
// moved down to History only with the pointer over its heading. These checks
// send real Qt wheel events over the cards themselves.
Item {
  id: scene
  width: 1400
  height: 1300
  Component {
    id: stateComponent
    Panel.ActivityHistoryState {}
  }
  Component {
    id: viewComponent
    Rectangle {
      width: 600
      height: 900
      color: "#161e2b"
      property alias panel: panel
      Panel.PanelContent {
        id: panel
        anchors.fill: parent
        online: true; paused: false; speaking: false; processing: 0
        foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
        fontFamily: "sans-serif"
        activityHistoryAvailable: true
        historyDeletionAvailable: true
        textInputAvailable: true
        shortcutLabel: "Super + Alt + C · panel\nSuper + Alt + P · pause/resume"
        intents: [
          {name: "SEND_TEXT_TO_APPLICATION", label: "Type text", enabled: true, supportsInference: true, inferenceEnabled: true,
            shortcutEnabled: true, toggleable: true, inferenceAvailable: true, prefixAvailable: true, prefixes: ["insert"]},
          {name: "IGNORE", label: "Ignore", enabled: true, supportsInference: true, inferenceEnabled: true,
            shortcutEnabled: true, toggleable: false, inferenceAvailable: true, prefixAvailable: false, prefixes: []}
        ]
      }
    }
  }

  function entry(sequence) {
    return {
      id: "utterance-" + sequence, sequence: sequence, revision: 1,
      utterance: "Synthetic utterance " + sequence + (sequence % 3 ? "" : " with a longer body that wraps onto a second line in a narrow panel"),
      intent: "SEND_TEXT_TO_APPLICATION", outcome: "sent", observedAt: 1789817000000 + sequence * 1000,
      correct: null, actualIntent: null
    }
  }

  TestCase {
    name: "CompanionActivityScrolling"
    when: windowShown

    function makeHost(count, properties) {
      const state = createTemporaryObject(stateComponent, scene)
      state.reset("run")
      for (let index = 1; index <= count; index++)
        state.update("run", entry(index))
      const host = createTemporaryObject(viewComponent, scene, properties || {})
      host.panel.activityHistoryModel = state.model
      verify(waitForRendering(host))
      return {host: host, state: state, page: findChild(host, "fullActivityStatus"), list: findChild(host, "activityScroll")}
    }

    // The history card under a point inside the page viewport. The pointer
    // may fall in the small gap between two cards; that still counts.
    function cardAt(fixture, viewportY) {
      const gap = fixture.list.spacing
      for (const offset of [0, -gap, gap]) {
        const point = fixture.list.mapToItem(fixture.list.contentItem, fixture.list.width / 2, viewportY + offset)
        const item = fixture.list.itemAt(point.x, point.y)
        if (item && item.objectName.indexOf("history-") === 0)
          return item
      }
      return null
    }

    // Screen movement of the card under the pointer. Page coordinates alone
    // are not enough: a ListView refines its origin from estimated card heights.
    function cardShift(fixture, viewportY, notches) {
      const card = cardAt(fixture, viewportY)
      verify(card !== null, "The pointer is over a history card")
      const before = card.mapToItem(fixture.list, 0, 0).y
      wheelOnce(fixture, viewportY, notches)
      return card.mapToItem(fixture.list, 0, 0).y - before
    }

    function wheelOnce(fixture, viewportY, notches) {
      const point = fixture.list.mapToItem(fixture.host, fixture.list.width / 2, viewportY)
      mouseWheel(fixture.host, point.x, point.y, 0, 120 * notches, Qt.NoButton)
      // A wheel flick can start on the next frame; let it start and settle.
      wait(40)
      tryCompare(fixture.list, "moving", false)
    }

    function test_wheel_over_history_cards_moves_the_whole_page_both_ways() {
      const fixture = makeHost(130)
      const page = fixture.page
      const history = findChild(fixture.host, "historySection")
      verify(Math.abs(page.contentY) < 1, "The page opens at Listening")

      // Put the pointer over the first card and keep it there while scrolling.
      const pointerY = page.viewportHeight - 40
      let steps = 0
      while (cardAt(fixture, pointerY) === null && steps++ < 30)
        wheelOnce(fixture, pointerY, -1)
      verify(cardAt(fixture, pointerY) !== null, "The pointer is over a history card, not the heading")
      for (let notch = 0; notch < 6; notch++)
        verify(cardShift(fixture, pointerY, -1) < -100, "Each notch over a card moves the page down; notch " + notch)
      verify(history.mapToItem(fixture.list, 0, 0).y < 0, "The History heading has scrolled away")

      // Reach the end with the pointer still over cards, then the footer shows.
      for (let notch = 0; notch < 400 && !fixture.list.atYEnd; notch++)
        wheelOnce(fixture, pointerY / 2, -8)
      verify(fixture.list.atYEnd)
      compare(cardShift(fixture, pointerY / 2, -3), 0, "Stops at the end without bouncing")
      const help = findChild(fixture.host, "activityKeyboardHelp")
      verify(help.mapToItem(fixture.list, 0, help.height).y <= page.viewportHeight + 1, "Keyboard help is reachable")

      // And back up, over cards, all the way to Listening.
      verify(cardAt(fixture, pointerY / 2) !== null)
      verify(cardShift(fixture, pointerY / 2, 1) > 100, "Reversing direction over a card moves the page")
      for (let notch = 0; notch < 400 && !fixture.list.atYBeginning; notch++)
        wheelOnce(fixture, pointerY / 2, 8)
      verify(fixture.list.atYBeginning)
      verify(Math.abs(page.contentY) < 1)
      wheelOnce(fixture, pointerY / 2, 3)
      verify(Math.abs(page.contentY) < 1, "Stops at the top")
      compare(findChild(fixture.host, "listeningArea").mapToItem(fixture.list, 0, 0).y, 0)
    }

    function test_long_history_keeps_cards_virtualized() {
      const fixture = makeHost(400)
      function created() {
        let count = 0
        for (const child of fixture.list.contentItem.children) {
          if (child.objectName.indexOf("history-") === 0)
            count++
        }
        return count
      }
      verify(created() < 40, "Only nearby cards exist; created " + created())
      fixture.page.scrollTo(fixture.page.contentHeight / 2)
      verify(waitForRendering(fixture.host))
      verify(created() < 40, "Scrolling reuses a bounded set of cards; created " + created())
      compare(fixture.state.model.count, 400)
    }

    function test_draft_focus_and_new_rows_survive_scrolling() {
      const fixture = makeHost(60)
      const input = findChild(fixture.host, "activityTextInput")
      input.text = "Keep this unsent draft"
      fixture.host.panel.focusComposer()
      verify(input.activeFocus)
      wheelOnce(fixture, 200, -10)
      verify(fixture.page.contentY > 0)
      compare(input.text, "Keep this unsent draft")
      verify(input.activeFocus, "Wheel scrolling never takes the composer's focus")

      // A reader in the middle of History stays on the same cards when a
      // new utterance arrives at the top; a reader at the top stays there.
      fixture.page.scrollTo(3000)
      verify(waitForRendering(fixture.host))
      const card = cardAt(fixture, 100)
      verify(card !== null)
      const before = card.mapToItem(fixture.list, 0, 0).y
      fixture.state.update("run", entry(61))
      verify(waitForRendering(fixture.host))
      compare(card.mapToItem(fixture.list, 0, 0).y, before)
      fixture.page.scrollTo(0)
      fixture.state.update("run", entry(62))
      verify(waitForRendering(fixture.host))
      verify(Math.abs(fixture.page.contentY) < 1, "A reader at the top stays there")
      compare(fixture.state.model.get(0).entryId, "utterance-62", "Newest first ordering is unchanged")
    }

    function test_folding_sections_keeps_the_reader_in_place_and_keeps_rows() {
      const fixture = makeHost(80, {width: 420, height: 520})
      const history = findChild(fixture.host, "historySection")
      const list = fixture.list
      function pageY(item) { return item.mapToItem(list.contentItem, 0, 0).y - list.originY }
      fixture.page.scrollTo(pageY(history))
      verify(waitForRendering(fixture.host))
      const toggle = findChild(history, "sectionToggle")
      mouseClick(toggle)
      compare(history.expanded, false)
      verify(waitForRendering(fixture.host))
      verify(toggle.mapToItem(list, 0, 0).y >= -1 && toggle.mapToItem(list, 0, toggle.height).y <= fixture.page.viewportHeight + 1,
        "The heading just clicked stays visible")
      compare(fixture.state.model.count, 80, "Folding keeps every row")
      mouseClick(toggle)
      compare(history.expanded, true)
      verify(waitForRendering(fixture.host))
      verify(findChild(fixture.host, "history-utterance-80") !== null, "Cards return after unfolding")

      // Folding Listening while at the top keeps the top of the page in view.
      fixture.page.scrollTo(0)
      findChild(fixture.host, "listeningArea").expanded = false
      verify(waitForRendering(fixture.host))
      // Card-height estimates may refine the origin by a fraction of a pixel.
      verify(Math.abs(fixture.page.contentY) < 1, "Still at the top: " + fixture.page.contentY)
    }

    function test_empty_history_keeps_the_reader_in_place_and_explains_itself() {
      const fixture = makeHost(0, {width: 420, height: 520})
      const empty = findChild(fixture.host, "activityHistoryEmpty")
      verify(empty.visible)
      compare(empty.text, "Completed utterances will appear here.\nThis Companion run")
      fixture.host.panel.activityHistoryAvailable = false
      compare(empty.text, "Restart Companion to connect session history.")
      fixture.host.panel.activityHistoryAvailable = true

      // With no cards, a bare ListView would jump to its top whenever the
      // sections above History change size.
      fixture.page.scrollTo(300)
      verify(waitForRendering(fixture.host))
      const intents = findChild(fixture.host, "intentControls")
      const before = intents.mapToItem(fixture.list, 0, 0).y
      fixture.host.panel.paused = true
      verify(waitForRendering(fixture.host))
      verify(fixture.page.contentY >= 299, "Pausing did not scroll the reader to the top: " + fixture.page.contentY)
      verify(Math.abs(intents.mapToItem(fixture.list, 0, 0).y - before) < 1, "The intent cards stay where the reader was looking")

      // The first utterance replaces the placeholder without moving the page.
      fixture.state.update("run", entry(1))
      verify(waitForRendering(fixture.host))
      verify(findChild(fixture.host, "history-utterance-1") !== null)
      verify(Math.abs(intents.mapToItem(fixture.list, 0, 0).y - before) < 1)
    }

    function test_wheel_over_cards_at_every_surface_size_data() {
      return [
        {tag: "short-narrow", width: 380, height: 420, zoom: 100},
        {tag: "tall-wide", width: 1300, height: 1250, zoom: 100},
        {tag: "narrow-zoomed", width: 420, height: 700, zoom: 200},
        {tag: "wide-zoomed", width: 1100, height: 900, zoom: 150}
      ]
    }

    function test_wheel_over_cards_at_every_surface_size(data) {
      const fixture = makeHost(120, {width: data.width, height: data.height})
      fixture.host.panel.zoomPercent = data.zoom
      findChild(fixture.host, "listeningArea").expanded = false
      verify(waitForRendering(fixture.host))
      const history = findChild(fixture.host, "historySection")
      const list = fixture.list
      fixture.page.scrollTo(history.mapToItem(list.contentItem, 0, 0).y - list.originY)
      verify(waitForRendering(fixture.host))
      if (data.tag === "short-narrow" || data.tag === "tall-wide")
        grabImage(fixture.host).save("/tmp/companion-activity-scrolling-" + data.tag + ".png")
      const pointerY = fixture.page.viewportHeight * 0.6
      const card = cardAt(fixture, pointerY)
      verify(card !== null, "Pointer over a card")
      verify(card.width <= list.width)
      verify(cardShift(fixture, pointerY, -1) < -50, "Down over a card")
      verify(cardShift(fixture, pointerY, 1) > 50, "Up over a card")
      wheelOnce(fixture, pointerY, 30)
      verify(fixture.list.atYBeginning, "Back at Listening")
    }
  }
}
