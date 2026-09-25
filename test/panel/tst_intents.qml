import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 600
  height: 1700
  function inventory() {
    return [
      {name: "SEND_TEXT_TO_APPLICATION", label: "Type text", enabled: true, toggleable: true, inferenceAvailable: true, prefixes: ["insert"], prefixAvailable: true},
      {name: "ENTER_TEXT_TO_APPLICATION", label: "Type text and Enter", enabled: true, toggleable: true, inferenceAvailable: false, prefixes: ["enter"], prefixAvailable: true},
      {name: "IGNORE", label: "Ignore", enabled: true, toggleable: false, inferenceAvailable: true, prefixes: [], prefixAvailable: false},
      {name: "START_CODING_AGENT_SESSION", label: "Start a coding session", enabled: true, toggleable: true, inferenceAvailable: true, prefixes: ["new session"], prefixAvailable: true},
      {name: "CONTINUE_OPEN_AGENT_CONVERSATION", label: "Continue the open agent conversation", enabled: true, toggleable: true, inferenceAvailable: false, prefixes: ["continue session"], prefixAvailable: false},
      {name: "QUICK_QUESTION", label: "Quick question", enabled: true, toggleable: true, inferenceAvailable: false, prefixes: ["quick question"], prefixAvailable: true}
    ].map(function(intent) {
      intent.supportsInference = !["ENTER_TEXT_TO_APPLICATION", "QUICK_QUESTION"].includes(intent.name)
      intent.inferenceEnabled = true
      intent.shortcutEnabled = true
      return intent
    })
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
        shortcutLabel: "Super + Alt + C · panel / D · conversation focus\nIn panel: Super + Alt + 0 · Activity / Tab · next tab\nIn panel: Alt + 1–9 · conversations\nSuper + Alt + P · pause/resume"
        intents: scene.inventory()
      }
    }
  }
  TestCase {
    name: "CompanionIntentControls"
    when: windowShown

    function showItem(host, item) {
      const page = findChild(host, "fullActivityStatus")
      const position = item.mapToItem(page.contentItem, 0, 0)
      page.contentY = Math.max(0, Math.min(page.contentHeight - page.viewportHeight, position.y + item.height - page.viewportHeight + 16))
      verify(waitForRendering(host))
    }

    function test_intent_and_shortcut_clicks_request_independent_backend_acknowledgements() {
      const host = createTemporaryObject(viewComponent, scene)
      const panel = host.panel
      const controls = findChild(findChild(panel, "fullActivityStatus"), "intentControls")
      let request = null
      panel.intentEnabledRequested.connect(function(name, enabled, mode) { request = {name: name, enabled: enabled, mode: mode} })
      const chip = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      showItem(host, chip)
      verify(chip.active)
      compare(controls.shortcuts.length, 4)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(request.name, "SEND_TEXT_TO_APPLICATION")
      compare(request.enabled, false)
      compare(request.mode, "inference")
      verify(chip.active, "Wait for the backend acknowledgement")
      const next = scene.inventory()
      next[0].inferenceEnabled = false
      panel.intents = next
      const disabled = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      compare(disabled.active, false)
      compare(disabled.stateText, "Off")
      compare(controls.shortcuts.length, 4, "Turning off recognition leaves the voice shortcut active")
      const shortcut = findChild(controls, "shortcut-SEND_TEXT_TO_APPLICATION")
      verify(shortcut.active)
      verify(shortcut.routeColor !== disabled.routeColor)
      showItem(host, shortcut)
      mouseClick(shortcut, shortcut.width / 2, shortcut.height / 2)
      compare(request.mode, "shortcut")
      compare(request.enabled, false)
      const shortcutOff = scene.inventory()
      shortcutOff[0].shortcutEnabled = false
      host.panel.intents = shortcutOff
      compare(controls.shortcuts.length, 3)
      verify(findChild(controls, "intent-SEND_TEXT_TO_APPLICATION").active, "Recognition stays on")
      host.panel.intents = next
      const updated = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      showItem(host, updated)
      mouseClick(updated, updated.width / 2, updated.height / 2)
      compare(request.enabled, true)
    }

    function test_transcription_cleanup_switch_is_hidden_without_support_and_follows_the_backend() {
      const host = createTemporaryObject(viewComponent, scene)
      const panel = host.panel
      const controls = findChild(findChild(panel, "fullActivityStatus"), "intentControls")
      const chip = findChild(controls, "transcriptionCleanupSwitch")
      compare(chip.visible, false, "An older listener without cleanup shows no switch")
      compare(chip.height, 0)

      let requests = []
      panel.transcriptionCleanupRequested.connect(function(enabled) { requests.push(enabled) })
      panel.transcriptionCleanup = {enabled: false}
      verify(chip.visible)
      compare(chip.cleanupEnabled, false)
      compare(findChild(controls, "transcriptionCleanupState").text, "Cleanup · Off · raw transcript")
      showItem(host, chip)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true])
      compare(chip.cleanupEnabled, false, "Wait for the backend acknowledgement")

      panel.transcriptionCleanup = {enabled: true}
      compare(chip.cleanupEnabled, true)
      verify(chip.active)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true, false])

      panel.online = false
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true, false], "Offline clicks send nothing")
    }

    function test_context_changes_update_labels_without_disabling_the_intent() {
      const host = createTemporaryObject(viewComponent, scene)
      const controls = findChild(findChild(host, "fullActivityStatus"), "intentControls")
      let chip = findChild(controls, "intent-CONTINUE_OPEN_AGENT_CONVERSATION")
      compare(chip.active, false)
      compare(chip.stateText, "Needs conversation context")
      const next = scene.inventory()
      next[4].prefixAvailable = true
      host.panel.intents = next
      chip = findChild(controls, "intent-CONTINUE_OPEN_AGENT_CONVERSATION")
      compare(chip.active, false, "The inference route still needs its own context")
      compare(findChild(controls, "shortcut-CONTINUE_OPEN_AGENT_CONVERSATION").active, true)
      compare(controls.shortcuts.length, 5)
    }

    function test_ignore_and_disconnected_controls_cannot_toggle_and_pause_dims_labels() {
      const host = createTemporaryObject(viewComponent, scene)
      const controls = findChild(findChild(host, "fullActivityStatus"), "intentControls")
      let requests = 0
      host.panel.intentEnabledRequested.connect(function() { requests++ })
      const ignore = findChild(controls, "intent-IGNORE")
      showItem(host, ignore)
      mouseClick(ignore, ignore.width / 2, ignore.height / 2)
      compare(requests, 0)
      host.panel.paused = true
      compare(findChild(controls, "intent-SEND_TEXT_TO_APPLICATION").active, false)
      compare(findChild(controls, "voice-insert").opacity, 0.45)
      host.panel.online = false
      const chip = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      showItem(host, chip)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, 0)
    }

    function test_older_backend_cannot_accidentally_toggle_both_modes() {
      const host = createTemporaryObject(viewComponent, scene)
      const legacy = scene.inventory()
      for (const intent of legacy) {
        delete intent.supportsInference
        delete intent.inferenceEnabled
        delete intent.shortcutEnabled
      }
      host.panel.intents = legacy
      const controls = findChild(host, "intentControls")
      compare(controls.separateModes, false)
      let requests = 0
      host.panel.intentEnabledRequested.connect(function() { requests++ })
      const chip = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      showItem(host, chip)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, 0)
    }

    function test_activity_preview_and_small_panel_scroll() {
      const host = createTemporaryObject(viewComponent, scene)
      verify(waitForRendering(host))
      const result = grabImage(host)
      result.save("/tmp/companion-intent-controls-preview.png")
      host.width = 320
      host.height = 400
      const page = findChild(host, "fullActivityStatus")
      const controls = findChild(page, "intentControls")
      tryVerify(function() { return page.contentHeight > page.viewportHeight })
      verify(page.clip)
      const textChip = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      verify(textChip.width <= controls.width)
    }

    function test_listening_controls_and_real_keyboard_footer_never_overlap_data() {
      return [
        {tag: "normal", width: 600, height: 900, unit: 1, font: "sans-serif"},
        {tag: "desktop-monospace", width: 600, height: 1700, unit: 1, font: "monospace"},
        {tag: "narrow", width: 420, height: 650, unit: 1, font: "monospace"},
        {tag: "small", width: 320, height: 400, unit: 1, font: "sans-serif"},
        {tag: "scaled", width: 750, height: 950, unit: 1.25, font: "monospace"}
      ]
    }

    function test_listening_controls_and_real_keyboard_footer_never_overlap(data) {
      const host = createTemporaryObject(viewComponent, scene, {width: data.width, height: data.height})
      host.panel.unit = data.unit
      host.panel.fontFamily = data.font
      verify(waitForRendering(host))
      const page = findChild(host, "fullActivityStatus")
      const stage = findChild(page, "listeningArea")
      const controls = findChild(page, "intentControls")
      const footer = findChild(page, "activityKeyboardHelp")
      const input = findChild(page, "activityTextArea")
      compare(stage.y, 0)
      compare(input.y + input.height, page.height)
      verify(page.viewportHeight + 12 * data.unit <= input.y)
      verify(stage.y + stage.height + 20 * data.unit <= controls.y)
      verify(controls.y + controls.height + 20 * data.unit <= footer.y)
      verify(footer.y + footer.height <= page.contentHeight + 1)
      verify(footer.height >= 4 * 10 * data.unit, "Measure every line of real keyboard help")
      for (const route of controls.routes) {
        const chip = findChild(controls, (route.mode === "inference" ? "intent-" : "shortcut-") + route.intent.name)
        const text = findChild(chip, "intentCardText")
        verify(text.height + 24 * data.unit <= chip.height, "Intent text fits its card")
      }
      if (data.tag === "desktop-monospace") grabImage(host).save("/tmp/companion-activity-layout-tall.png")
      if (data.tag === "small") grabImage(host).save("/tmp/companion-activity-layout-small.png")
    }

    function test_live_phrase_stays_in_its_area_above_shortcuts() {
      const host = createTemporaryObject(viewComponent, scene, {height: 1300})
      host.panel.fontFamily = "monospace"
      host.panel.history = [{id: "layout-phrase", utterance: "Please explain what is visible on my screen, then help me choose what to do next.", outcome: "processing", intent: null}]
      const page = findChild(host, "fullActivityStatus")
      const stage = findChild(page, "listeningArea")
      const phrase = findChild(stage, "phraseActivity")
      tryCompare(phrase, "arrived", true)
      verify(stage.clip, "Live phrases cannot paint over adjacent controls")
      grabImage(host).save("/tmp/companion-activity-layout-processing.png")
      host.panel.history = [{id: "layout-phrase", utterance: phrase.phrase, outcome: "skipped", intent: "CONTINUE_OPEN_AGENT_CONVERSATION"}]
      tryCompare(phrase, "showingResult", true)
      grabImage(host).save("/tmp/companion-activity-layout-result.png")
    }
  }
}
