import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 650
  height: 900
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 400
      height: 600
      online: true; paused: false; speaking: false; processing: 0
      foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
      fontFamily: "sans-serif"
      onSessionSelected: id => { showingPrevious = false; selectedSessionId = id }
      onPreviousRequested: showingPrevious = true
    }
  }

  TestCase {
    name: "CompanionTabSizes"
    when: windowShown

    function populate(panel) {
      const sessions = []
      for (let i = 0; i < 12; i++) {
        sessions.push({id: "s" + i, title: i === 0 ? "🌱 Garden plans for next spring" : "Question " + i,
          status: "completed", error: "", messages: []})
      }
      panel.sessions = sessions
    }

    function test_geometry_and_reader_independence_data() {
      return [{tag: "small-theme", unit: 0.8}, {tag: "default", unit: 1}, {tag: "large-theme", unit: 1.5}]
    }

    function test_geometry_and_reader_independence(data) {
      const panel = createTemporaryObject(panelComponent, scene, {unit: data.unit})
      populate(panel)
      const tab = findChild(panel, "tab-s0")
      const activity = findChild(panel, "activityTab")
      const previous = findChild(panel, "previousSessionsButton")
      const rail = findChild(panel, "tabRail")
      compare(tab.width, 60 * data.unit)
      compare(tab.height, 77.5 * data.unit)
      compare(activity.width, tab.width)
      compare(activity.height, 80 * data.unit)
      compare(previous.width, tab.width)
      compare(previous.height, 75 * data.unit)
      compare(rail.width, 80 * data.unit)
      compare(findChild(tab, "sessionGlyph").font.pixelSize, Math.round(18.75 * data.unit))
      compare(findChild(findChild(panel, "tab-s1"), "sessionGlyph").font.pixelSize, Math.round(12.5 * data.unit))
      compare(findChild(tab, "sessionCaption").font.pixelSize, Math.round(11.25 * data.unit))
      compare(findChild(panel, "activityTabLabel").font.pixelSize, Math.round(10 * data.unit))
      compare(findChild(panel, "activityTabBar").width, 3.75 * data.unit)
      compare(findChild(panel, "previousSessionsLabel").font.pixelSize, Math.round(11.25 * data.unit))
      compare(findChild(tab, "closeSessionTab").width, 27.5 * data.unit)
      compare(findChild(tab, "sessionTitleTooltip").contentItem.font.pixelSize, Math.round(13.75 * data.unit))
      const caption = findChild(tab, "sessionCaption")
      verify(caption.y + caption.height <= tab.height)
      verify(caption.y >= findChild(tab, "sessionGlyph").parent.y + findChild(tab, "sessionGlyph").parent.height)
      compare(panel.zoomPercent, 100)
      const chat = findChild(panel, "sessionView")
      compare(chat.unit, data.unit)
      compare(chat.textScale, data.unit)
      panel.zoomPercent = 200
      compare(chat.textScale, 2 * data.unit)
      compare(panel.width, 400)
      compare(rail.width, 80 * data.unit)
      compare(tab.width, 60 * data.unit)
      compare(findChild(tab, "sessionCaption").font.pixelSize, Math.round(11.25 * data.unit))
    }

    function test_scroll_and_controls_data() {
      return [{tag: "short", unit: 1, height: 400}, {tag: "short-large-theme", unit: 1.5, height: 400},
        {tag: "tiny", unit: 1, height: 240}]
    }

    function test_scroll_and_controls(data) {
      const panel = createTemporaryObject(panelComponent, scene, {height: data.height, unit: data.unit})
      populate(panel)
      const rail = findChild(panel, "tabRail")
      const list = findChild(panel, "sessionTabList")
      const activity = findChild(panel, "activityTab")
      const previous = findChild(panel, "previousSessionsButton")
      verify(list.height >= 77.5 * data.unit)
      verify(activity.y + activity.height < list.y)
      verify(list.y + list.height < previous.y)
      mouseClick(activity)
      compare(panel.selectedSessionId, "")
      verify(waitForRendering(panel))
      tryVerify(function() { return list.contentHeight > list.height })
      const before = list.contentY
      mouseWheel(list, list.width / 2, list.height / 2, 0, -120)
      tryVerify(function() { return list.contentY > before })
      // Reach the last session through the actual wheel input path.
      mouseWheel(list, list.width / 2, list.height / 2, 0, -12000, Qt.NoButton)
      tryVerify(function() { return list.atYEnd })
      tryCompare(list, "moving", false)
      const last = findChild(panel, "tab-s11")
      mouseClick(last, last.width / 2, last.height - 10)
      compare(panel.selectedSessionId, "s11")
      // In the fallback layout, scroll above the session list to reach Previous.
      if (rail.interactive) {
        mouseWheel(rail, 2, 10, 0, -120)
        tryVerify(function() { return rail.atYEnd })
        tryCompare(rail, "moving", false)
      }
      mouseClick(previous)
      compare(panel.showingPrevious, true)
      if (rail.interactive) {
        mouseWheel(rail, 2, 10, 0, 120)
        tryCompare(rail, "contentY", 0)
        tryCompare(rail, "moving", false)
      }
      mouseClick(activity)
      compare(panel.showingPrevious, false)
      compare(panel.selectedSessionId, "")
    }

    function test_close_keyboard_and_accessibility() {
      const panel = createTemporaryObject(panelComponent, scene)
      populate(panel)
      const tab = findChild(panel, "tab-s0")
      compare(tab.Accessible.role, Accessible.PageTab)
      verify(tab.Accessible.name.indexOf("Garden plans") >= 0)
      const close = findChild(tab, "closeSessionTab")
      compare(close.Accessible.role, Accessible.Button)
      let closed = ""
      panel.dismissSessionRequested.connect(function(id) { closed = id })
      close.forceActiveFocus(Qt.TabFocusReason)
      keyClick(Qt.Key_Return)
      compare(closed, "s0")
      closed = ""
      panel.online = false
      keyClick(Qt.Key_Space)
      compare(closed, "")
    }
  }
}
