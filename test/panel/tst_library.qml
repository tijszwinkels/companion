import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 1120
  height: 820
  Component { id: stateComponent; Panel.AgentSessionState {} }
  Component {
    id: panelComponent
    Rectangle {
      width: 600
      height: 820
      color: "#161e2b"
      property alias panel: body
      Panel.PanelContent {
        id: body
        anchors.fill: parent
        online: true; paused: false; speaking: false; processing: 0
        foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
        fontFamily: "sans-serif"
        onPreviousRequested: showingPrevious = true
        onSessionSelected: id => { showingPrevious = false; selectedSessionId = id }
      }
    }
  }
  Component {
    id: viewerComponent
    Panel.ScreenshotViewer {
      width: 1120
      height: 820
      source: Qt.resolvedUrl("fixtures/window.svg")
      title: "What do you think of this design?"
      background: "#161e2b"; foreground: "#dce5ef"; muted: "#8ba0b8"; accent: "#9fc0f7"; selection: "#293a51"
      fontFamily: "sans-serif"
    }
  }
  function conversation() {
    return {id: "saved-1", title: "What do you think of this design?", status: "completed", error: "", updatedAt: 1789760000000,
      messages: [{id: "user", kind: "user", text: "What do you think of this design?", toolName: "", input: "", state: "done",
        screenshot: true, screenshotUrl: Qt.resolvedUrl("fixtures/window.svg").toString()}]}
  }
  TestCase {
    name: "CompanionSessionLibrary"
    when: windowShown

    function test_close_on_right_click_and_stable_hover_cross() {
      const host = createTemporaryObject(panelComponent, scene)
      const panel = host.panel
      panel.sessions = [conversation()]
      const tab = findChild(panel, "tab-saved-1")
      const cross = findChild(tab, "closeSessionTab")
      let closed = ""
      panel.dismissSessionRequested.connect(function(id) { closed = id })
      mouseMove(host, 590, 790)
      tryCompare(cross, "opacity", 0)
      mouseMove(tab, 24, 32)
      tryCompare(cross, "opacity", 1)
      mouseMove(cross, 10, 10)
      wait(200)
      compare(tab.hovered, true)
      compare(cross.opacity, 1)
      mouseClick(cross, 10, 10)
      compare(closed, "saved-1")
      closed = ""
      mouseClick(tab, 20, 35, Qt.RightButton)
      compare(closed, "saved-1")
      closed = ""
      panel.online = false
      mouseClick(tab, 20, 35, Qt.RightButton)
      compare(closed, "")
    }

    function test_previous_page_reopens_explicitly_and_drafts_survive() {
      const host = createTemporaryObject(panelComponent, scene)
      const panel = host.panel
      const saved = conversation()
      panel.sessions = [saved]
      panel.selectedSessionId = saved.id
      const composer = findChild(panel, "sessionComposer")
      composer.text = "My unfinished follow-up"
      panel.sessions = []
      panel.selectedSessionId = ""
      panel.previousSessions = [saved]
      mouseClick(findChild(panel, "previousSessionsButton"))
      compare(panel.showingPrevious, true)
      compare(panel.selectedSession, null)
      let reopened = ""
      panel.reopenSessionRequested.connect(function(id) { reopened = id })
      tryVerify(function() { return findChild(panel, "previous-saved-1") !== null })
      mouseClick(findChild(panel, "previous-saved-1"), 40, 35)
      compare(reopened, saved.id)
      panel.sessions = [saved]
      panel.showingPrevious = false
      panel.selectedSessionId = saved.id
      compare(composer.text, "My unfinished follow-up")
      panel.controlError = "Could not save session history"
      compare(findChild(panel, "sessionControlError").visible, true)
      compare(findChild(panel, "sessionControlError").text, panel.controlError)
    }

    function test_history_snapshots_stay_closed_and_restore_selects_known_id() {
      const state = createTemporaryObject(stateComponent, scene)
      let revealed = 0
      state.revealRequested.connect(function() { revealed++ })
      state.update(conversation())
      state.remove("saved-1")
      state.showingPrevious = true
      state.previousSessions = [conversation()]
      state.replace([])
      compare(revealed, 1)
      compare(state.sessions.length, 0)
      compare(state.showingPrevious, true)
      state.restore(conversation())
      compare(state.selectedId, "saved-1")
      compare(state.showingPrevious, false)
      compare(revealed, 2)
      compare(state.sessions[0].messages.length, 1)
      state.replace(state.sessions)
      compare(revealed, 2)
    }

    function test_thumbnail_opens_original_and_missing_image_keeps_question() {
      const host = createTemporaryObject(panelComponent, scene)
      const panel = host.panel
      const saved = conversation()
      panel.sessions = [saved]
      panel.selectedSessionId = saved.id
      let source = ""
      panel.screenshotRequested.connect(function(url, title) { source = url.toString() })
      tryVerify(function() { return findChild(panel, "screenshotThumbnail") !== null })
      const thumbnail = findChild(panel, "screenshotThumbnail")
      wait(150)
      mouseClick(thumbnail, 100, 60)
      compare(source, saved.messages[0].screenshotUrl)
      saved.messages[0].screenshotUrl = ""
      panel.sessions = [JSON.parse(JSON.stringify(saved))]
      compare(thumbnail.visible, false)
      compare(findChild(findChild(panel, "bubble-user"), "messageText").text, saved.messages[0].text)
    }

    function test_viewer_fits_zooms_pans_and_dismisses() {
      const viewer = createTemporaryObject(viewerComponent, scene)
      tryCompare(viewer, "imageReady", true)
      const viewport = findChild(viewer, "screenshotViewport")
      verify(viewer.imageWidth <= viewport.width)
      verify(viewer.imageHeight <= viewport.height)
      compare(viewer.zoom, 1)
      let dismissed = 0
      viewer.dismissed.connect(function() { dismissed++ })
      mouseClick(findChild(viewer, "zoomIn"))
      verify(viewer.zoom > 1)
      verify(viewport.contentWidth > viewport.width)
      const oldX = viewport.contentX
      mouseDrag(viewport, viewport.width / 2, viewport.height / 2, -60, -40)
      tryVerify(function() { return viewport.contentX > oldX })
      mouseWheel(viewport, viewport.width / 2, viewport.height / 2, 0, 120)
      verify(viewer.zoom > 1.25)
      mouseClick(findChild(viewer, "fitScreenshot"))
      compare(viewer.zoom, 1)
      compare(viewport.contentX, 0)
      viewer.forceActiveFocus()
      keyClick(Qt.Key_Plus)
      verify(viewer.zoom > 1)
      keyClick(Qt.Key_0)
      compare(viewer.zoom, 1)
      keyClick(Qt.Key_Escape)
      compare(dismissed, 1)
      mouseClick(findChild(viewer, "closeScreenshot"))
      compare(dismissed, 2)
      mouseClick(viewer, 8, 400)
      compare(dismissed, 3)
      mouseClick(findChild(viewer, "viewerImage"), 100, 100)
      compare(dismissed, 3, "Image clicks do not dismiss")
    }

    function test_unavailable_screenshot_still_dismisses() {
      const viewer = createTemporaryObject(viewerComponent, scene)
      tryCompare(viewer, "imageReady", true)
      ignoreWarning(/.*Cannot open:.*missing-screenshot.png/)
      viewer.source = Qt.resolvedUrl("fixtures/missing-screenshot.png")
      tryCompare(findChild(viewer, "viewerImage"), "status", Image.Error)
      compare(viewer.imageReady, false)
      let dismissed = false
      viewer.dismissed.connect(function() { dismissed = true })
      viewer.forceActiveFocus()
      keyClick(Qt.Key_Escape)
      compare(dismissed, true)
    }

    function test_visual_previews() {
      const host = createTemporaryObject(panelComponent, scene)
      const panel = host.panel
      const saved = conversation()
      saved.messages.push({id: "answer", kind: "assistant", text: "## Calm and clear\nThe hierarchy works well. The three steps are easy to follow, and the softer colors keep the page comfortable to read.\n\nTry giving **Resume later** a little more space.", toolName: "", input: "", state: "done", screenshot: false})
      panel.sessions = [saved]
      panel.selectedSessionId = saved.id
      wait(200)
      grabImage(host).save("/tmp/companion-session-preview.png")
      panel.history = [{id: "phrase", utterance: "Can you explain how this works?", outcome: "processing"}]
      const strip = findChild(panel, "activityStrip")
      const phrase = findChild(strip, "phraseActivity")
      tryCompare(phrase, "arrived", true)
      grabImage(host).save("/tmp/companion-activity-processing-preview.png")
      panel.history = [{id: "phrase", utterance: "Can you explain how this works?", intent: "CONTINUE_OPEN_AGENT_CONVERSATION", outcome: "sent"}]
      wait(50)
      grabImage(host).save("/tmp/companion-activity-result-preview.png")
      mouseClick(findChild(strip, "toggleActivity"))
      tryCompare(strip, "height", 28)
      grabImage(host).save("/tmp/companion-activity-collapsed-preview.png")
      panel.previousSessions = [saved, Object.assign({}, saved, {id: "saved-2", title: "Explain this terminal error", status: "cancelled", updatedAt: 1789673000000})]
      panel.showingPrevious = true
      wait(100)
      grabImage(host).save("/tmp/companion-history-preview.png")
      host.visible = false
      const viewer = createTemporaryObject(viewerComponent, scene)
      tryCompare(viewer, "imageReady", true)
      grabImage(viewer).save("/tmp/companion-screenshot-preview.png")
    }
  }
}
