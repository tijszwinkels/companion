import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 600
  height: 900
  Component {
    id: panelComponent
    Panel.PanelContent {
      width: 600; height: 900
      online: true; paused: false; speaking: false; processing: 0
      animationsEnabled: false
      foreground: "#e0e6f0"; muted: "#959faa"; accent: "#82aaff"; selection: "#283348"
      fontFamily: "sans-serif"
    }
  }
  Component {
    id: surfaceComponent
    Panel.WidgetSurface {
      width: 420; height: 260
      foreground: "#e0e6f0"; muted: "#959faa"; accent: "#82aaff"; selection: "#283348"
      transport: function(path, body, done) { if (done) done({height: 170}) }
    }
  }
  function reference(percent, replaceActivity) {
    return {id: "12345678-1234-1234-1234-123456789abc", name: "todo", revision: 1,
      viewUrl: "http://127.0.0.1:9/view/" + "a".repeat(64),
      presentation: {placement: "pinned", heightPercent: percent, replaceActivity: replaceActivity}}
  }
  function conversation(widget) {
    return {id: "session", title: "Widgets", status: "running", messages: [{id: "visual", kind: "assistant", text: "To-do fallback", input: "", toolName: "", state: "done", screenshot: false, widget: widget}]}
  }
  TestCase {
    name: "CompanionWidgets"
    when: windowShown
    function test_sidebar_height_activity_full_height_and_draft_preservation() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [conversation(null)]
      panel.selectedSessionId = "session"
      const chat = findChild(panel, "sessionView")
      const composer = findChild(panel, "sessionComposer")
      const activity = findChild(panel, "activityStrip")
      composer.text = "Keep my unsent follow-up"
      panel.sessions = [conversation(reference(25, true))]
      const area = findChild(panel, "pinnedWidgetArea")
      verify(area.visible)
      compare(area.height, (900 - 40 - 44) * 0.25)
      compare(activity.visible, false)
      verify(chat.visible)
      panel.sessions = [conversation(reference(30, false))]
      compare(activity.visible, true)
      verify(activity.y >= area.y + area.height)
      panel.sessions = [conversation(reference(100, false))]
      compare(area.height, 900 - 40 - 44)
      compare(chat.visible, false)
      compare(activity.visible, false)
      compare(panel.composerFocusId, "")
      panel.focusComposer()
      compare(panel.composerFocusId, "")
      verify(findChild(panel, "widgetBackToChat").visible)
      verify(findChild(panel, "widgetStopSession").visible)
      panel.online = false
      mouseClick(findChild(panel, "widgetBackToChat"))
      compare(chat.visible, true, "Back to chat remains available without the widget service")
      compare(composer.text, "Keep my unsent follow-up")
      panel.online = true
      const inline = reference(25, true)
      inline.presentation.placement = "inline"
      panel.sessions = [conversation(inline)]
      compare(chat.visible, true)
      compare(composer.text, "Keep my unsent follow-up")
      tryVerify(function() { return findChild(panel, "messageText") !== null })
      verify(findChild(panel, "messageText").text.indexOf("To-do fallback") >= 0)
    }
    function test_widget_interaction_and_popout_are_separate_and_hover_fades() {
      const widget = createTemporaryObject(surfaceComponent, parent, {reference: reference(25, true)})
      const calls = []
      widget.transport = function(path, body, done) { calls.push({path: path, body: body}); if (done) done({}) }
      const popout = findChild(widget, "widgetPopout")
      mouseMove(parent, 550, 600)
      tryCompare(popout, "opacity", 0)
      mouseClick(widget, 40, 60)
      verify(calls.some(call => call.path === "/input" && call.body.type === "mousePressed"))
      compare(calls.filter(call => call.path === "/popout").length, 0)
      verify(widget.activeFocus)
      keyClick(Qt.Key_A)
      verify(calls.some(call => call.body && call.body.type === "text" && call.body.text === "a"))
      mouseMove(widget, 45, 65)
      tryCompare(popout, "opacity", 1)
      mouseClick(popout)
      compare(calls.filter(call => call.path === "/popout").length, 1)
      widget.unpin()
      compare(calls[calls.length - 1].path, "/present")
      compare(calls[calls.length - 1].body.presentation.placement, "inline")
      widget.textScale = 1.5
      verify(widget.viewport().indexOf("scale=1.5") >= 0)
      const invalid = reference(25, true)
      invalid.viewUrl = "file:///etc/passwd"
      widget.reference = invalid
      compare(widget.viewUrl, "")
    }
  }
}
