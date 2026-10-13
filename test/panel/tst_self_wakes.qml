import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// The conversation header's timer control and overlay (TimerControl.qml) and
// its history entry in the conversation menu. All timers are synthetic; no
// timer is scheduled or cancelled outside these objects.
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
      background: "#1a1b26"
      fontFamily: "sans-serif"
    }
  }

  function timer(id, state, extra) {
    return Object.assign({id: id, label: "Timer " + id, state: state, dueAt: Date.now() + 18 * 60000,
      transitionedAt: Date.now() - 60000, reason: ""}, extra || {})
  }
  function conversation(wakes, extra) {
    const messages = []
    for (let index = 0; index < 40; index++) {
      messages.push({id: "m" + index, kind: index % 2 ? "assistant" : "user", text: "Message " + index + " " + "words ".repeat(20),
        toolName: "", input: "", state: "done", screenshot: false})
    }
    return Object.assign({id: "owner", title: "Owner", status: "completed", model: "synthetic", error: "", messages: messages, wakes: wakes}, extra || {})
  }

  TestCase {
    name: "CompanionSelfWakes"
    when: windowShown

    function open(panel, wakes) {
      panel.sessions = [conversation(wakes)]
      panel.selectedSessionId = "owner"
      verify(waitForRendering(panel))
    }
    // Popup content lives under the window's overlay, outside findChild's
    // reach from the panel; search the overlays' content items as well.
    function find(panel, name) {
      const direct = findChild(panel, name)
      if (direct) return direct
      for (const popup of [findChild(panel, "timerOverlay"), findChild(panel, "conversationMenu")]) {
        const found = search(popup.contentItem, name)
        if (found) return found
      }
      return null
    }
    function search(item, name) {
      if (!item) return null
      if (item.objectName === name) return item
      for (const child of item.children || []) {
        const found = search(child, name)
        if (found) return found
      }
      return null
    }
    function control(panel) { return findChild(panel, "timerButton") }
    function overlay(panel) { return findChild(panel, "timerOverlay") }
    function cancelButtons(panel) {
      const found = []
      const visit = item => {
        if (item.objectName === "cancelWakeButton" && item.visible) found.push(item)
        for (const child of item.children || []) visit(child)
      }
      visit(overlay(panel).contentItem)
      return found
    }

    function test_hidden_without_timers_or_only_finished_ones() {
      const panel = createTemporaryObject(panelComponent, parent)
      open(panel, [])
      verify(!control(panel).visible, "No timers: no clock")
      verify(!findChild(panel, "conversationMenuButton").visible, "Nothing for the menu either")
      open(panel, [timer("done", "completed"), timer("stop", "cancelled"), timer("old", "expired")])
      verify(!control(panel).visible, "Finished timers alone do not show the clock")
      verify(findChild(panel, "conversationMenuButton").visible, "History stays reachable")
      mouseClick(findChild(panel, "conversationMenuButton"))
      const entry = find(panel, "conversationMenu-timers")
      verify(entry !== null)
      mouseClick(entry)
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      verify(find(panel, "finishedTimer-done") !== null, "Opened from history, finished timers are expanded")
      compare(find(panel, "timerSummary").text, "0 pending · this conversation")
      compare(cancelButtons(panel).length, 0)
    }

    function test_counts_follow_true_states() {
      const panel = createTemporaryObject(panelComponent, parent)
      open(panel, [timer("a", "scheduled"), timer("b", "waiting", {dueAt: Date.now() - 120000, reason: "Waiting for capacity"}),
        timer("c", "dispatching"), timer("d", "completed")])
      const label = findChild(panel, "timerButtonLabel")
      compare(label.text, "◷ 2", "Only scheduled and waiting are pending")
      compare(control(panel).Accessible.name, "Timers: 2 pending · 1 running")
      compare(findChild(panel, "sessionWakeCount").text, "◷2", "The tab badge is unchanged")
      // Started/dispatching alone stay discoverable without a pending count.
      open(panel, [timer("c", "started"), timer("d", "completed")])
      compare(label.text, "◷ Running")
      compare(control(panel).Accessible.name, "Timers: 0 pending · 1 running")
      verify(!findChild(panel, "sessionWakeCount").visible)
      // Failures need attention whatever else is pending.
      open(panel, [timer("a", "scheduled"), timer("f", "failed", {reason: "The configured model was unavailable"}),
        timer("g", "blocked"), timer("h", "delivery-uncertain")])
      compare(label.text, "! Attention · 3")
      compare(control(panel).Accessible.name, "Timers: 1 pending · 3 need attention")
    }

    function test_overlay_lists_details_and_routes_cancel_without_side_effects() {
      const panel = createTemporaryObject(panelComponent, parent)
      open(panel, [timer("a", "scheduled", {label: "Check review progress"}),
        timer("b", "waiting", {dueAt: Date.now() - 120000, reason: "Waiting for capacity"}),
        timer("c", "started", {cancellationRequested: true}),
        timer("f", "failed", {reason: "The configured model was unavailable"}),
        timer("d", "completed")])
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Keep my unsent words"
      composer.forceActiveFocus()
      const transcript = findChild(panel, "sessionTranscript")
      tryVerify(() => transcript.atYEnd)
      const scroll = transcript.contentY
      let cancelled = []
      panel.cancelWakeRequested.connect((id, timerId) => cancelled.push([id, timerId]))

      mouseClick(control(panel))
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      verify(composer.activeFocus, "Opening keeps keyboard focus in the composer")
      compare(transcript.contentY, scroll, "The overlay does not push the transcript")
      compare(cancelled.length, 0, "Opening cancels nothing")
      const failed = find(panel, "timer-f")
      verify(findChild(failed, "timerLabel").text.startsWith("! Timer f · Failed"))
      compare(findChild(failed, "timerReason").text, "The configured model was unavailable")
      compare(findChild(find(panel, "timer-c"), "timerReason").text, "Cancellation requested")
      verify(findChild(find(panel, "timer-b"), "timerReason").text.includes("Waiting for capacity"))
      compare(cancelButtons(panel).length, 3, "Scheduled, waiting and started are cancellable")
      verify(find(panel, "finishedTimer-d") === null, "Finished timers start collapsed")
      verify(find(panel, "timerHistoryToggle").text.includes("Finished timers · 1"))

      mouseClick(findChild(find(panel, "timer-a"), "cancelWakeButton"))
      compare(JSON.stringify(cancelled), JSON.stringify([["owner", "a"]]))
      compare(composer.text, "Keep my unsent words")

      // Updates keep the overlay open and the failure visible.
      panel.sessions = [conversation([timer("a", "cancelled"), timer("f", "failed"), timer("c", "started")])]
      verify(waitForRendering(panel))
      verify(overlay(panel).opened)
      compare(findChild(panel, "timerButtonLabel").text, "! Attention · 1")

      keyClick(Qt.Key_Escape)
      tryVerify(() => !overlay(panel).opened)
      verify(composer.activeFocus, "Escape closes without moving focus")
      compare(composer.text, "Keep my unsent words")
      compare(cancelled.length, 1, "Closing cancels nothing")
      compare(findChild(panel, "timerButtonLabel").text, "! Attention · 1", "Viewing never clears a failure")

      // Offline: Cancel is disabled and sends nothing.
      panel.online = false
      mouseClick(control(panel))
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      const offlineCancel = findChild(find(panel, "timer-c"), "cancelWakeButton")
      verify(!offlineCancel.enabled)
      mouseClick(offlineCancel)
      compare(cancelled.length, 1)
      mouseClick(find(panel, "closeTimerOverlay"))
      tryVerify(() => !overlay(panel).opened)
    }

    function test_switching_conversations_closes_the_overlay() {
      const panel = createTemporaryObject(panelComponent, parent)
      panel.sessions = [conversation([timer("a", "scheduled")]), conversation([], {id: "other", title: "Other"})]
      panel.selectedSessionId = "owner"
      verify(waitForRendering(panel))
      mouseClick(control(panel))
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      panel.selectedSessionId = "other"
      tryVerify(() => !overlay(panel).opened)
      verify(!control(panel).visible)
    }

    // Opens the timers the way a reader can at this size: the clock button,
    // or the conversation menu's Timers entry when the header folded it.
    function openTimers(panel) {
      const button = control(panel)
      if (button.visible) {
        verify(reachable(panel, button), "Clock button is clickable")
        mouseClick(button)
      } else {
        const menuButton = findChild(panel, "conversationMenuButton")
        verify(menuButton.visible, "Folded header shows the menu button")
        verify(reachable(panel, menuButton), "Menu button is clickable")
        mouseClick(menuButton)
        tryVerify(() => findChild(panel, "conversationMenu").opened)
        verify(waitForRendering(panel))
        const entry = find(panel, "conversationMenu-open-timers")
        verify(entry !== null, "Folded menu lists the timers first")
        mouseClick(entry)
      }
      tryVerify(() => overlay(panel).opened, 1000, "Timers open")
      verify(waitForRendering(panel))
    }
    // The control's centre lies in the conversation area beside the rail.
    function reachable(panel, item) {
      const rail = findChild(panel, "tabRail")
      const centre = item.mapToItem(panel, item.width / 2, item.height / 2)
      return centre.x > rail.x + rail.width && centre.x < panel.width && centre.y > 0 && centre.y < panel.height
    }
    function verifyOverlayInside(panel, label) {
      const popup = overlay(panel)
      const rail = findChild(panel, "tabRail")
      const box = popup.contentItem.mapToItem(panel, 0, 0, popup.width, popup.height)
      verify(box.x >= rail.x + rail.width - 0.5 && box.x + box.width <= panel.width + 0.5, label + ": width " + JSON.stringify(box))
      verify(box.y >= -0.5 && box.y + box.height <= panel.height + 0.5, label + ": height " + JSON.stringify(box))
      const list = find(panel, "timerList")
      verify(list.height > 0, label + ": list height " + list.height)
      const close = find(panel, "closeTimerOverlay")
      const closeBox = close.mapToItem(panel, 0, 0, close.width, close.height)
      verify(closeBox.y >= 0 && closeBox.y + closeBox.height <= panel.height, label + ": close reachable")
      for (const cancel of cancelButtons(panel)) {
        const y = cancel.mapToItem(list.contentItem, 0, 0).y
        verify(y >= 0 && y + cancel.height <= list.contentHeight + 0.5, label + ": Cancel can scroll into view")
      }
    }
    function resize(panel, width, height) {
      panel.width = width
      panel.height = height
      panel.Window.window.width = width
      panel.Window.window.height = height
      verify(waitForRendering(panel))
    }

    // Review round 2 (Rowan): sizes the native host supports, at theme scales
    // 1–3, opened directly at that size and opened large then shrunk. Sizes
    // where the panel has no conversation area beside its rail at all (narrow
    // windows at scale 3) are outside what the header can offer and skipped.
    function test_timer_overlay_fits_a_size_and_scale_matrix() {
      const wakes = [timer("p0", "scheduled", {label: "A deliberately long timer label that wraps over several lines " + "x".repeat(40)}),
        timer("p1", "waiting", {reason: "Waiting for capacity"}), timer("f", "failed", {reason: "Long reason ".repeat(12)})]
      for (let index = 0; index < 8; index++) wakes.push(timer("h" + index, "completed", {label: "Finished " + index}))
      const window = parent.Window.window
      const original = {width: window.width, height: window.height}
      const skipped = []
      for (const unit of [1, 1.5, 2, 3]) {
        for (const size of [[600, 900], [420, 520], [360, 420], [600, 420]]) {
          for (const path of ["direct", "resize"]) {
            const label = size.join("×") + " @" + unit + " " + path
            const panel = createTemporaryObject(panelComponent, parent, {width: 600, height: 900, unit: unit})
            resize(panel, path === "direct" ? size[0] : 600, path === "direct" ? size[1] : 900)
            const area = size[0] - findChild(panel, "tabRail").width - 40 * unit
            if (area < 60 * unit) {
              skipped.push(label)
              panel.destroy()
              continue
            }
            open(panel, wakes)
            openTimers(panel)
            if (path === "resize") resize(panel, size[0], size[1])
            verifyOverlayInside(panel, label)
            mouseClick(find(panel, "closeTimerOverlay"))
            tryVerify(() => !overlay(panel).opened, 1000, label + ": closes")
            // With the overlay closed, the visible header control opens it
            // again at this size.
            openTimers(panel)
            verifyOverlayInside(panel, label + " reopened")
            keyClick(Qt.Key_Escape)
            tryVerify(() => !overlay(panel).opened)
            panel.destroy()
          }
        }
      }
      window.width = original.width
      window.height = original.height
      compare(skipped.join(", "), "420×520 @3 direct, 420×520 @3 resize, 360×420 @3 direct, 360×420 @3 resize", "Only panels without a conversation area are skipped")
    }

    function test_folded_header_menu_keeps_history_and_attention() {
      const panel = createTemporaryObject(panelComponent, parent, {width: 360, height: 420, unit: 2})
      open(panel, [timer("a", "scheduled"), timer("f", "failed"), timer("d", "completed")])
      verify(!control(panel).visible, "The clock folds into the menu")
      const menuButton = findChild(panel, "conversationMenuButton")
      verify(menuButton.Accessible.name.includes("Timers: 1 pending · 1 needs attention"))
      mouseClick(menuButton)
      tryVerify(() => findChild(panel, "conversationMenu").opened)
      verify(waitForRendering(panel))
      verify(find(panel, "conversationMenu-timers") !== null, "History stays in the menu")
      mouseClick(find(panel, "conversationMenu-timers"))
      tryVerify(() => overlay(panel).opened)
      verify(find(panel, "finishedTimer-d") !== null)
    }

    // Review round 1 (Rowan): an already open overlay shrunk to a short,
    // enlarged panel keeps a usable list and stays inside the panel.
    function test_short_high_scale_overlay_keeps_cancel_reachable() {
      const panel = createTemporaryObject(panelComponent, parent, {width: 600, height: 900, unit: 2})
      open(panel, [timer("a", "scheduled"), timer("b", "failed")])
      mouseClick(control(panel))
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      panel.width = 360
      panel.height = 420
      verify(waitForRendering(panel))
      const list = find(panel, "timerList")
      verify(list.height >= 48 * 2 - 0.5, "Timer list keeps a usable height: " + list.height)
      const box = overlay(panel).contentItem.mapToItem(panel, 0, 0, overlay(panel).width, overlay(panel).height)
      verify(box.y + box.height <= panel.height, "Timer overlay fits the panel " + JSON.stringify(box))
      const close = find(panel, "closeTimerOverlay")
      const closeBox = close.mapToItem(panel, 0, 0, close.width, close.height)
      verify(closeBox.y >= 0 && closeBox.y + closeBox.height <= panel.height)
      for (const cancel of cancelButtons(panel)) {
        const y = cancel.mapToItem(list.contentItem, 0, 0).y
        verify(y >= 0 && y + cancel.height <= list.contentHeight, "Cancel can scroll into view")
      }
    }

    function test_overlay_outside_press_keeps_draft_and_closes() {
      const panel = createTemporaryObject(panelComponent, parent)
      open(panel, [timer("a", "scheduled")])
      const composer = findChild(panel, "sessionComposer")
      composer.text = "Keep my draft"
      composer.forceActiveFocus()
      mouseClick(control(panel))
      tryVerify(() => overlay(panel).opened)
      mouseClick(composer)
      tryVerify(() => !overlay(panel).opened)
      compare(composer.text, "Keep my draft")
      verify(composer.activeFocus)
    }

    function test_scheduled_wake_messages_keep_their_heading() {
      const panel = createTemporaryObject(panelComponent, parent)
      const session = conversation([timer("timer", "waiting")])
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
      // A capture policy snapshot cannot backfill the older unsaved message.
      panel.captureStorage = {enabled: true, pending: "", saved: true, warning: ""}
      verify(findChild(captureBubble, "messageHeading").text.includes("screenshot not saved"))
    }
  }
}
