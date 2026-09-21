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

    function test_layout_failure_retries_without_user_input() {
      let attempts = 0
      const widget = createTemporaryObject(surfaceComponent, parent, {
        running: false,
        reference: reference(25, true),
        transport: function(path, body, done) {
          if (path.indexOf("/layout") === 0) {
            attempts++
            if (attempts === 1) done(null, "All widget renderers are busy; try again shortly")
            else done({height: 190}, "")
          } else done({}, "")
        }
      })
      widget.running = true
      compare(attempts, 1)
      verify(widget.error.length > 0)
      tryCompare(widget, "preferredHeight", 190, 2500)
      compare(widget.error, "")
      compare(attempts, 2)
      wait(350)
      compare(attempts, 2, "A successful retry stops layout polling")
    }

    function test_offline_escape_applies_to_the_observed_revision_only() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.selectedSessionId = "session"
      panel.sessions = [conversation(reference(100, false))]
      panel.online = false
      panel.backToChat()
      compare(panel.fullWidget, false)
      panel.online = true
      panel.sessions = [conversation(reference(100, false))]
      compare(panel.pinnedMessage, null, "An unchanged reconnect snapshot must not undo escape")
      for (const percent of [40, 60]) {
        const next = reference(percent, false)
        next.revision = percent / 20
        panel.sessions = [conversation(next)]
        verify(panel.pinnedMessage !== null, "A newer agent update can pin the widget again")
        compare(panel.pinnedMessage.widget.presentation.heightPercent, percent)
        panel.online = false
        panel.backToChat()
        panel.online = true
        compare(panel.pinnedMessage, null)
      }
    }

    function test_layout_retry_pauses_when_hidden_and_resets_for_new_view() {
      const calls = []
      const widget = createTemporaryObject(surfaceComponent, parent, {
        running: false,
        reference: reference(25, true),
        transport: function(path, body, done, url) {
          if (path.indexOf("/layout") === 0) calls.push({done: done, url: url})
          else done({}, "")
        }
      })
      widget.running = true
      compare(calls.length, 1)
      calls[0].done(null, "Temporary layout failure")
      widget.running = false
      wait(650)
      compare(calls.length, 1, "Hidden widgets must not retry")
      widget.running = true
      compare(calls.length, 2)
      const next = reference(25, true)
      next.viewUrl = next.viewUrl.replace("a".repeat(64), "b".repeat(64))
      widget.reference = next
      verify(calls.length >= 3)
      calls[1].done(null, "Old view failure")
      compare(widget.error, "", "Old layout completion cannot taint the replacement")
      const current = calls.filter(call => call.url === next.viewUrl)
      verify(current.length > 0)
      for (let index = 2; index < calls.length; index++) calls[index].done({height: 180}, "")
      compare(widget.preferredHeight, 180)
      compare(widget.layoutRetryNeeded, false)
    }

    function test_partial_pin_keeps_chat_reachable_data() {
      return [
        {tag: "99 percent with activity", percent: 99, replaceActivity: false, zoom: 100, panelHeight: 900},
        {tag: "99 percent without activity", percent: 99, replaceActivity: true, zoom: 100, panelHeight: 900},
        {tag: "99 percent at double text size", percent: 99, replaceActivity: false, zoom: 200, panelHeight: 900},
        {tag: "90 percent in shorter window", percent: 90, replaceActivity: true, zoom: 100, panelHeight: 600}
      ]
    }

    function test_partial_pin_keeps_chat_reachable(data) {
      const panel = createTemporaryObject(panelComponent, parent, {height: data.panelHeight, zoomPercent: data.zoom})
      panel.sessions = [conversation(reference(data.percent, data.replaceActivity))]
      panel.selectedSessionId = "session"
      const chat = findChild(panel, "sessionView")
      const composer = findChild(panel, "sessionComposer")
      const transcript = findChild(panel, "sessionTranscript")
      const send = findChild(panel, "sendSession")
      const area = findChild(panel, "pinnedWidgetArea")
      composer.text = "Keep my draft"
      compare(panel.fullWidget, false)
      verify(chat.visible)
      tryVerify(function() { return transcript.height >= 96 * chat.textScale - 1 }, 1000, "Keep a readable transcript above the input")
      verify(area.height > 0)
      verify(chat.y >= area.y + area.height)
      const composerTop = composer.mapToItem(chat, 0, 0).y
      const sendTop = send.mapToItem(chat, 0, 0).y
      verify(composerTop >= 0, "The input must stay within the chat clip")
      verify(sendTop >= 0 && sendTop + send.height <= chat.height)
      panel.focusComposer()
      tryCompare(panel, "composerFocusId", "session")
      composer.cursorPosition = composer.length
      keyClick(Qt.Key_X)
      verify(composer.text.endsWith("x"))

      // Choices and an error can grow the input section after the pin is shown.
      panel.agentActions = {sessionId: "session", stopRunId: "run", choices: [
        {sessionId: "session", revision: "choice", index: 0, label: "Yes", description: "Continue the work", available: true, voiceAvailable: true}
      ]}
      chat.inputError = "Please try again."
      tryVerify(function() { return transcript.height >= 96 * chat.textScale - 1 })
      verify(composer.mapToItem(chat, 0, 0).y >= 0)
      compare(panel.composerFocusId, "session")
      const draft = composer.text
      panel.sessions = [conversation(reference(100, data.replaceActivity))]
      compare(panel.fullWidget, true)
      compare(chat.visible, false)
      compare(panel.composerFocusId, "")
      panel.focusComposer()
      compare(panel.composerFocusId, "")
      panel.sessions = [conversation(reference(data.percent, data.replaceActivity))]
      tryVerify(function() { return transcript.height >= 96 * chat.textScale - 1 })
      compare(composer.text, draft)
    }

    function test_resize_cannot_leave_an_unreachable_composer_focused() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [conversation(reference(99, true))]
      panel.selectedSessionId = "session"
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Retain this draft"
      panel.focusComposer()
      tryCompare(panel, "composerFocusId", "session")
      panel.height = 140
      tryCompare(panel, "composerFocusId", "")
      tryCompare(composer, "enabled", false)
      panel.focusComposer()
      compare(panel.composerFocusId, "")
      panel.height = 900
      tryCompare(composer, "enabled", true)
      panel.focusComposer()
      tryCompare(panel, "composerFocusId", "session")
      compare(composer.text, "Retain this draft")
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

    function test_slow_popout_shows_progress_and_accepts_only_one_click() {
      const widget = createTemporaryObject(surfaceComponent, parent, {reference: reference(25, true)})
      const calls = []
      widget.transport = function(path, body, done) {
        if (path === "/popout") calls.push(done)
        else done({height: 170})
      }
      const button = findChild(widget, "widgetPopout")
      const status = findChild(widget, "widgetStatus")
      mouseMove(button)
      mouseClick(button)
      compare(calls.length, 1)
      compare(button.text, "…")
      compare(status.text, "Opening in Chromium…")
      mouseClick(button)
      widget.popout()
      compare(calls.length, 1, "A slow first launch must not invite duplicate browser creation")
      widget.forceActiveFocus()
      keyClick(Qt.Key_Escape)
      verify(button.activeFocus, "Escape must still leave widget input during browser startup")
      widget.running = false
      calls[0]({opened: true}, "")
      compare(widget.popoutPending, false, "An accepted launch can complete while hidden")
      compare(status.text, "")
      widget.popout()
      compare(calls.length, 1, "Hidden surfaces must not accept new launches")
    }

    function test_popout_error_survives_background_work_and_retry_clears_it() {
      const widget = createTemporaryObject(surfaceComponent, parent, {reference: reference(25, true)})
      const calls = []
      widget.transport = function(path, body, done) {
        if (path === "/popout") calls.push(done)
        else done({height: 170})
      }
      widget.popout()
      calls[0](null, "Chromium could not start")
      widget.refreshLayout()
      widget.sendInput({type: "text", text: "still interactive"})
      compare(findChild(widget, "widgetStatus").text, "Chromium could not start")
      widget.popout()
      compare(widget.popoutError, "")
      calls[1]({opened: true}, "")
      compare(widget.popoutPending, false)
      compare(findChild(widget, "widgetStatus").text, "")
    }

    function test_old_popout_completion_does_not_change_replacement_view() {
      const widget = createTemporaryObject(surfaceComponent, parent, {reference: reference(25, true)})
      const calls = []
      widget.transport = function(path, body, done, url) {
        if (path === "/popout") calls.push({done: done, url: url})
        else done({height: 170})
      }
      widget.popout()
      const replacement = reference(25, true)
      replacement.viewUrl = replacement.viewUrl.replace("a".repeat(64), "b".repeat(64))
      widget.reference = replacement
      compare(widget.popoutPending, false)
      widget.popout()
      calls[0].done(null, "Old view expired")
      compare(widget.popoutPending, true)
      compare(widget.popoutError, "")
      verify(calls[0].url !== calls[1].url)
      calls[1].done({opened: true}, "")
      compare(widget.popoutPending, false)
    }
  }
}
