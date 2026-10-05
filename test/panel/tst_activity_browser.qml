import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// The Activity page and selection markers alongside the panel browser. The
// browser covers the page area; the rail keeps marking the page underneath,
// which the browser's Chat control and the rail return to. Portable hosts have
// no Qt WebEngine, so the browser here fails to load and shows its message,
// exactly as in tst_panel_browser_entry.qml; the visibility and state logic
// under test lives in PanelContent. The native window suite repeats the key
// checks with the real browser.
Item {
  id: scene
  width: 700
  height: 700

  Component {
    id: stateComponent
    Panel.ActivityHistoryState {}
  }
  Component {
    id: contentComponent
    Panel.PanelContent {
      width: 420
      height: 560
      online: true; paused: false; speaking: false; processing: 0
      foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
      fontFamily: "sans-serif"
      activityHistoryAvailable: true
      browserAvailable: true
      browserSource: Qt.resolvedUrl("missing-panel-browser.qml")
      sessions: [{id: "one", title: "Synthetic chat", status: "idle", error: "", messages: []}]
      intents: [
        {name: "SEND_TEXT_TO_APPLICATION", label: "Type text", enabled: true, supportsInference: true, inferenceEnabled: true,
          shortcutEnabled: true, toggleable: true, inferenceAvailable: true, prefixAvailable: true, prefixes: ["insert"]},
        {name: "START_CODING_AGENT_SESSION", label: "Start a coding session", enabled: true, supportsInference: true,
          inferenceEnabled: true, shortcutEnabled: true, toggleable: true, inferenceAvailable: true, prefixAvailable: true,
          prefixes: ["new session"]},
        {name: "IGNORE", label: "Ignore", enabled: true, supportsInference: true, inferenceEnabled: true,
          shortcutEnabled: true, toggleable: false, inferenceAvailable: true, prefixAvailable: false, prefixes: []}
      ]
    }
  }

  function entry(sequence) {
    return {id: "utterance-" + sequence, sequence: sequence, revision: 1, utterance: "Synthetic utterance " + sequence,
      intent: "SEND_TEXT_TO_APPLICATION", outcome: "sent", observedAt: 1789817000000 + sequence * 1000,
      correct: null, actualIntent: null}
  }

  TestCase {
    name: "ActivityWithBrowser"
    when: windowShown

    function makePanel() {
      const state = createTemporaryObject(stateComponent, scene)
      state.reset("run")
      for (let index = 1; index <= 60; index++)
        state.update("run", entry(index))
      const panel = createTemporaryObject(contentComponent, scene, {activityHistoryModel: state.model})
      // Hosts apply rail choices; PanelContent only asks.
      panel.sessionSelected.connect(function(id) { panel.selectedSessionId = id })
      ignoreWarning(new RegExp("missing-panel-browser"))
      verify(waitForRendering(panel))
      return {panel: panel, state: state}
    }

    function test_rail_marks_the_page_under_the_browser() {
      const fixture = makePanel()
      const panel = fixture.panel
      const activityMarker = findChild(panel, "activitySelectionMarker")
      const tabMarker = findChild(findChild(panel, "tab-one"), "sessionSelectionMarker")
      verify(activityMarker.visible)
      verify(!tabMarker.visible)

      panel.openBrowser()
      verify(panel.browsing)
      verify(!findChild(panel, "fullActivityStatus").visible, "The browser covers Activity")
      verify(activityMarker.visible, "The rail still marks Activity, where Chat returns")
      verify(!findChild(panel, "previousSelectionMarker").visible)

      // Choosing a conversation in the rail leaves the browser and moves the marker.
      mouseClick(findChild(panel, "tab-one"))
      verify(!panel.browsing)
      compare(panel.selectedSessionId, "one")
      verify(tabMarker.visible)
      verify(!activityMarker.visible)
      panel.openBrowser()
      verify(tabMarker.visible, "The marker stays on the conversation under the browser")
      mouseClick(findChild(panel, "activityTab"))
      verify(!panel.browsing)
      verify(activityMarker.visible)
      verify(!tabMarker.visible)
      verify(findChild(panel, "fullActivityStatus").visible)
    }

    function test_activity_keeps_scroll_folds_and_draft_across_the_browser() {
      const fixture = makePanel()
      const panel = fixture.panel
      const page = findChild(panel, "fullActivityStatus")
      const list = findChild(page, "activityScroll")
      const input = findChild(panel, "activityTextInput")
      input.text = "Unsent Activity draft"
      findChild(panel, "listeningArea").expanded = false
      verify(waitForRendering(panel))

      // Read partway into History, with Intentions folded by a real click.
      const intentions = findChild(panel, "intentionsSection")
      page.scrollToItem(intentions)
      verify(waitForRendering(panel))
      mouseClick(findChild(intentions, "sectionToggle"))
      compare(intentions.expanded, false)
      verify(waitForRendering(panel))
      page.scrollTo(page.contentY + 400)
      verify(waitForRendering(panel))
      const point = list.mapToItem(list.contentItem, list.width / 2, 60)
      const card = list.itemAt(point.x, point.y)
      verify(card !== null && card.objectName.indexOf("history-") === 0, "Reading a history card")
      const cardY = card.mapToItem(list, 0, 0).y

      panel.openBrowser()
      verify(panel.browsing)
      // A new utterance arrives at the top of History while browsing.
      fixture.state.update("run", entry(61))
      wait(50)
      panel.closeBrowser()
      verify(!panel.browsing)
      verify(page.visible)
      verify(waitForRendering(panel))
      compare(intentions.expanded, false, "Folds survive the browser")
      compare(findChild(panel, "listeningArea").expanded, false)
      verify(Math.abs(card.mapToItem(list, 0, 0).y - cardY) < 1.5, "The same card is where it was: " + cardY + " -> " + card.mapToItem(list, 0, 0).y)
      compare(input.text, "Unsent Activity draft")
      compare(fixture.state.model.count, 61)

      // Wheel scrolling over the cards still moves the whole page.
      const before = card.mapToItem(list, 0, 0).y
      const wheelPoint = list.mapToItem(panel, list.width / 2, 60)
      mouseWheel(panel, wheelPoint.x, wheelPoint.y, 0, -120, Qt.NoButton)
      verify(waitForRendering(panel))
      verify(card.mapToItem(list, 0, 0).y < before - 50, "Wheel over a card scrolls the page after browsing")
    }
  }
}
