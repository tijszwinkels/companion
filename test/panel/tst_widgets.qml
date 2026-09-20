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

    // Hold each input response until the test explicitly completes it. Layout
    // remains synchronous so these checks isolate accepted input and its owner.
    function delayedSurface() {
      const widget = createTemporaryObject(surfaceComponent, parent, {reference: reference(25, true)})
      mouseMove(widget, 40, 60)
      const calls = []
      widget.transport = function(path, body, done, url) {
        if (path === "/input") calls.push({body: body, done: done, url: url || widget.viewUrl})
        else if (done) done({height: 170})
      }
      return {widget: widget, calls: calls}
    }

    function test_accepted_mouse_release_drains_after_hide_data() {
      return [{tag: "not running", property: "running"}, {tag: "invisible", property: "visible"}, {tag: "disabled", property: "enabled"}]
    }

    function test_accepted_mouse_release_drains_after_hide(data) {
      const fixture = delayedSurface()
      const widget = fixture.widget
      const calls = fixture.calls
      mousePress(widget, 40, 60)
      mouseRelease(widget, 40, 60)
      compare(calls.length, 1)
      compare(calls[0].body.type, "mousePressed")
      widget[data.property] = false
      calls[0].done({})
      compare(calls.length, 2, "The accepted release must reach transport even while hidden")
      compare(calls[1].body.type, "mouseReleased")
      calls[1].done({})
      widget[data.property] = true
      compare(calls.length, 2, "Showing the widget must not replay completed input")
    }

    function test_accepted_text_and_key_up_drain_after_hide() {
      const fixture = delayedSurface()
      fixture.widget.forceActiveFocus()
      keyPress(Qt.Key_Left)
      keyClick(Qt.Key_A)
      keyRelease(Qt.Key_Left)
      compare(fixture.calls.length, 1)
      compare(fixture.calls[0].body.phase, "keyDown")
      fixture.widget.running = false
      fixture.calls[0].done({})
      compare(fixture.calls.length, 2, "Accepted text must not disappear on hide")
      compare(fixture.calls[1].body, {type: "text", text: "a"})
      fixture.calls[1].done({})
      compare(fixture.calls.length, 3)
      compare(fixture.calls[2].body.phase, "keyUp")
      fixture.calls[2].done({})
    }

    function test_hidden_surface_rejects_new_input_data() {
      return [{tag: "not running", property: "running"}, {tag: "invisible", property: "visible"}, {tag: "disabled", property: "enabled"}]
    }

    function test_hidden_surface_rejects_new_input(data) {
      const fixture = delayedSurface()
      // A caller may override running; visibility/enabled still govern admission.
      fixture.widget.running = true
      fixture.widget[data.property] = false
      fixture.widget.sendInput({type: "text", text: "hidden input"})
      fixture.widget.sendInput({type: "key", key: "Enter", phase: "keyUp", modifiers: 0})
      compare(fixture.calls.length, 0)
      fixture.widget[data.property] = true
      compare(fixture.calls.length, 0, "Hidden input must not be deferred until show")
    }

    function test_accepted_input_keeps_original_view_when_reference_changes() {
      const fixture = delayedSurface()
      const originalUrl = fixture.widget.viewUrl
      mousePress(fixture.widget, 40, 60)
      mouseRelease(fixture.widget, 40, 60)
      const replacement = reference(25, true)
      replacement.viewUrl = originalUrl.replace(/a{64}$/, "b".repeat(64))
      fixture.widget.reference = replacement
      fixture.widget.sendInput({type: "text", text: "replacement"})
      compare(fixture.calls.length, 1, "A stale callback must not overlap the replacement queue")
      fixture.calls[0].done({})
      compare(fixture.calls.length, 2)
      compare(fixture.calls[1].url, originalUrl)
      compare(fixture.calls[1].body.type, "mouseReleased")
      fixture.calls[1].done(null) // The old capability may have been revoked by close.
      compare(fixture.calls.length, 3)
      compare(fixture.calls[2].url, replacement.viewUrl)
      compare(fixture.calls[2].body.text, "replacement")
      fixture.calls[2].done({})
      compare(fixture.calls.length, 3, "Never retry an old capability against the replacement")
    }

    function test_stale_copy_cannot_change_clipboard_after_reference_round_trip() {
      const fixture = delayedSurface()
      const original = fixture.widget.reference
      const clipboard = findChild(fixture.widget, "widgetClipboard")
      clipboard.text = "current selection"
      fixture.widget.sendInput({type: "copy"})
      fixture.widget.reference = null
      fixture.widget.reference = original
      fixture.calls[0].done({result: "stale selection"})
      compare(clipboard.text, "current selection")
    }

    function test_destroyed_surface_does_not_start_more_input() {
      const fixture = delayedSurface()
      fixture.widget.sendInput({type: "text", text: "in flight"})
      fixture.widget.sendInput({type: "text", text: "queued"})
      fixture.widget.destroy()
      wait(0)
      fixture.calls[0].done({})
      compare(fixture.calls.length, 1)
    }

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
