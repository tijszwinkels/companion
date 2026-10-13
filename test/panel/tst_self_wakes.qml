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

    function test_long_lists_stay_bounded_in_a_small_enlarged_panel() {
      const panel = createTemporaryObject(panelComponent, parent, {width: 340, height: 460, unit: 1.6})
      const wakes = []
      for (let index = 0; index < 3; index++) {
        wakes.push(timer("p" + index, "scheduled", {label: "A deliberately long timer label that wraps over several lines " + index + " ".repeat(1) + "x".repeat(40)}))
      }
      for (let index = 0; index < 20; index++) wakes.push(timer("h" + index, index % 3 ? "completed" : "cancelled", {label: "Finished " + index}))
      wakes.push(timer("f", "blocked", {reason: "Long reason ".repeat(20)}))
      open(panel, wakes)
      const button = control(panel)
      verify(button.visible)
      const buttonBox = button.mapToItem(panel, 0, 0, button.width, button.height)
      verify(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= panel.width, "The clock fits the narrow header")
      mouseClick(button)
      tryVerify(() => overlay(panel).opened)
      verify(waitForRendering(panel))
      mouseClick(find(panel, "timerHistoryToggle"))
      const popup = overlay(panel)
      const box = popup.contentItem.mapToItem(panel, 0, 0, popup.width, popup.height)
      const rail = findChild(panel, "tabRail")
      verify(box.x >= rail.x + rail.width && box.x + box.width <= panel.width + 1, "Overlay stays beside the tab rail: " + JSON.stringify(box))
      verify(box.y + box.height <= panel.height, "Overlay fits the height: " + JSON.stringify(box))
      const close = find(panel, "closeTimerOverlay")
      const closeBox = close.mapToItem(panel, 0, 0, close.width, close.height)
      verify(closeBox.y >= 0 && closeBox.y + closeBox.height <= panel.height, "Close stays reachable")
      verify(close.width >= 28 * 1.6 - 0.5, "Close keeps an accessible size")
      const list = find(panel, "timerList")
      verify(list.contentHeight > list.height, "The list scrolls inside the overlay")
      // Every Cancel can be scrolled into view.
      for (const cancel of cancelButtons(panel)) {
        const y = cancel.mapToItem(list.contentItem, 0, 0).y
        verify(y >= 0 && y + cancel.height <= list.contentHeight)
      }
      mouseClick(close)
      tryVerify(() => !popup.opened)
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
