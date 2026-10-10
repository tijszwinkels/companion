import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 600
  height: 900
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 600
      height: 900
      online: true
      paused: false
      speaking: false
      processing: 0
      foreground: "#e0e6f0"
      muted: "#959faa"
      accent: "#82aaff"
      selection: "#283348"
      fontFamily: "sans-serif"
    }
  }
  TestCase {
    name: "CompanionSelfWakes"
    when: windowShown
    function test_timer_cancel_and_background_update_keep_draft_and_selection() {
      const panel = createTemporaryObject(panelComponent, parent)
      const timer = {id: "timer", label: "Review check", state: "waiting", dueAt: Date.now() - 60000, transitionedAt: Date.now(), reason: "Waiting for capacity"}
      const session = {id: "owner", title: "Owner", status: "completed", model: "synthetic", error: "", messages: [], wakes: [timer]}
      panel.captureStorage = {enabled: false, pending: "", saved: true, warning: ""}
      session.messages = [
        {id: "capture", kind: "user", text: "Earlier live screenshot", toolName: "", input: "", state: "done", screenshot: true, screenshotSaved: false},
        {id: "wake", kind: "user", text: "Scheduled follow-up", toolName: "", input: "", state: "done", screenshot: false, origin: {kind: "scheduled-wake", title: "Review check"}}
      ]
      panel.sessions = [session]
      panel.selectedSessionId = "owner"
      verify(waitForRendering(panel))
      const captureBubble = findChild(panel, "bubble-capture")
      verify(findChild(captureBubble, "messageHeading").text.includes("screenshot not saved"))
      verify(findChild(findChild(panel, "bubble-wake"), "messageHeading").text.startsWith("Scheduled wake"))
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Keep my unsent words"
      const toggle = findChild(panel, "wakeToggle")
      verify(toggle.visible)
      verify(toggle.text.indexOf("1 pending") >= 0)
      mouseClick(toggle)
      verify(waitForRendering(panel))
      const cancel = findChild(panel, "cancelWakeButton")
      verify(cancel.visible)
      let cancelled = null
      panel.cancelWakeRequested.connect((id, timerId) => cancelled = [id, timerId])
      // A capture policy snapshot cannot hide timer cancellation or backfill
      // the older unsaved message when the user opts in.
      panel.captureStorage = {enabled: true, pending: "", saved: true, warning: ""}
      verify(findChild(captureBubble, "messageHeading").text.includes("screenshot not saved"))
      mouseClick(cancel)
      compare(cancelled, ["owner", "timer"])
      compare(composer.text, "Keep my unsent words")
      panel.sessions = [Object.assign({}, session, {wakes: [Object.assign({}, timer, {state: "cancelled"})]})]
      verify(waitForRendering(panel))
      compare(composer.text, "Keep my unsent words")
      compare(panel.selectedSessionId, "owner")
      verify(toggle.text.indexOf("0 pending") >= 0)
      verify(!findChild(panel, "cancelWakeButton").visible)
    }
  }
}
