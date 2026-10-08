import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  // Wide enough for the widest responsive-grid screenshot.
  width: 1400
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
  // Every processor the router currently registers, in a synthetic state:
  // the approved preview was only a sample and must not limit the real list.
  function fullInventory() {
    const rows = [
      ["SEND_TEXT_TO_APPLICATION", "Type text", true, ["insert"]],
      ["ENTER_TEXT_TO_APPLICATION", "Type text and Enter", false, ["enter"]],
      ["START_CODING_AGENT_SESSION", "Start a coding session", true, ["new session"]],
      ["QUICK_QUESTION", "Quick question", false, ["quick question"]],
      ["START_CLAUDE_CODE_SESSION", "Start a Claude Code session", false, ["new claude session"]],
      ["START_PI_SESSION", "Start a Pi session", false, ["new pi session"]],
      ["CONTINUE_OPEN_AGENT_CONVERSATION", "Continue the open agent conversation", true, ["continue session"]],
      ["GO_TO_SESSION", "Go to session 1–16", false, ["go to session"]],
      ["CLOSE_AGENT_SESSION", "Close session", false, ["close session"]],
      ["LABEL_PREVIOUS_CORRECT", "Label previous correct", false, ["label previous correct"]],
      ["LABEL_PREVIOUS_INCORRECT", "Label previous incorrect", false, ["label previous incorrect"]],
      ["IGNORE", "Ignore", true, []]
    ]
    return rows.map(function(row) {
      const context = row[0] === "CONTINUE_OPEN_AGENT_CONVERSATION"
      return {
        name: row[0], label: row[1], enabled: true, supportsInference: row[2],
        inferenceEnabled: row[0] !== "START_CODING_AGENT_SESSION", shortcutEnabled: row[0] !== "QUICK_QUESTION",
        toggleable: row[0] !== "IGNORE", inferenceAvailable: row[2] && !context,
        prefixes: row[3], prefixAvailable: row[3].length > 0 && !context,
        acceptsEmptyPrefix: ["GO_TO_SESSION", "CLOSE_AGENT_SESSION", "LABEL_PREVIOUS_CORRECT", "LABEL_PREVIOUS_INCORRECT"].includes(row[0]) || undefined
      }
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
      // Let sections that just changed size finish their layout first.
      verify(waitForRendering(host))
      const page = findChild(host, "fullActivityStatus")
      const list = findChild(page, "activityScroll")
      const position = item.mapToItem(list.contentItem, 0, 0).y - list.originY
      page.scrollTo(position + item.height - page.viewportHeight + 16)
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

    function test_capture_storage_switch_reports_unavailable_pending_and_unsaved_states() {
      const host = createTemporaryObject(viewComponent, scene)
      const panel = host.panel
      const controls = findChild(findChild(panel, "fullActivityStatus"), "intentControls")
      const chip = findChild(controls, "captureStorageSwitch")
      const state = findChild(controls, "captureStorageState")
      const warning = findChild(controls, "captureStorageWarning")
      let requests = []
      panel.captureStorageRequested.connect(function(enabled) { requests.push(enabled) })

      // An older listener reports nothing: unavailable, never "off".
      verify(chip.visible)
      compare(chip.actionable, false)
      verify(state.text.startsWith("Unavailable"))
      showItem(host, chip)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [], "No setting is sent to a listener that does not support it")

      panel.captureStorage = {enabled: false, pending: "", saved: true, warning: ""}
      compare(state.text, "Off · new captures are not saved; labeling is unavailable")
      compare(chip.Accessible.checked, false)
      verify(findChild(controls, "captureStorageExplanation").text.includes("Native agent/model-provider retention is separate"))
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true])
      compare(chip.storageEnabled, false, "Wait for the backend acknowledgement")

      panel.captureStorage = {enabled: false, pending: "enabling", saved: true, warning: ""}
      compare(state.text, "Turning on…")
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true], "No second request while one is pending")

      panel.captureStorage = {enabled: true, pending: "", saved: true, warning: ""}
      compare(state.text, "On · new captures are saved")
      compare(chip.Accessible.checked, true)
      // Keyboard users reach and toggle the same control.
      chip.forceActiveFocus(Qt.TabFocusReason)
      keyClick(Qt.Key_Space)
      compare(requests, [true, false])

      panel.captureStorage = {enabled: false, pending: "disabling", saved: true, warning: ""}
      compare(state.text, "Turning off…")
      compare(chip.storageEnabled, false, "Off applies at once; only the acknowledgement is pending")

      const unsaved = "Capture storage is off for now, but this choice could not be saved. After a restart Companion may save captures again."
      panel.captureStorage = {enabled: false, pending: "", saved: false, warning: unsaved}
      verify(warning.visible)
      compare(warning.text, unsaved)
      verify(chip.Accessible.name.includes(unsaved))

      panel.online = false
      compare(state.text, "Disconnected")
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, [true, false], "Offline clicks send nothing")
    }

    function test_context_changes_update_labels_without_disabling_the_intent() {
      const host = createTemporaryObject(viewComponent, scene)
      const controls = findChild(findChild(host, "fullActivityStatus"), "intentControls")
      let chip = findChild(controls, "intent-CONTINUE_OPEN_AGENT_CONVERSATION")
      compare(chip.active, false)
      compare(chip.stateText, "On", "Missing context is not the same as switched off")
      compare(chip.contextText, "Needs conversation context")
      verify(chip.waiting)
      compare(findChild(chip, "intentModeContext").visible, true)
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
      compare(findChild(findChild(controls, "intent-SEND_TEXT_TO_APPLICATION"), "intentModeState").text, "● On",
        "Older listeners' combined enabled flag still labels the mode")
      let requests = 0
      host.panel.intentEnabledRequested.connect(function() { requests++ })
      const chip = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      showItem(host, chip)
      mouseClick(chip, chip.width / 2, chip.height / 2)
      compare(requests, 0)
    }

    function test_each_activity_is_one_card_with_only_its_supported_modes() {
      const host = createTemporaryObject(viewComponent, scene, {width: 1400, height: 1200})
      host.panel.intents = scene.fullInventory()
      host.panel.transcriptionCleanup = {enabled: false}
      verify(waitForRendering(host))
      const controls = findChild(host, "intentControls")
      const cards = findChild(controls, "activityCards")
      const names = []
      for (const child of cards.children) {
        if (child.objectName && child.objectName.indexOf("activity-") === 0)
          names.push(child.objectName.slice("activity-".length))
      }
      compare(names, scene.fullInventory().map(intent => intent.name), "One card per registered activity, in router order")
      for (const intent of scene.fullInventory()) {
        const card = findChild(controls, "activity-" + intent.name)
        compare(findChild(card, "activityTitle").text, intent.label)
        compare(findChild(card, "intent-" + intent.name) !== null, intent.supportsInference, intent.name + " recognition")
        compare(findChild(card, "shortcut-" + intent.name) !== null, intent.prefixes.length > 0, intent.name + " shortcut")
      }
      const shortcut = findChild(controls, "shortcut-SEND_TEXT_TO_APPLICATION")
      const phrase = findChild(shortcut, "intentCardShortcuts")
      verify(phrase.visible && phrase.height > 0, "Phrases stay visible on the voice shortcut")
      compare(phrase.children[0].children[0].text, "insert …")
      compare(findChild(findChild(controls, "shortcut-GO_TO_SESSION"), "intentCardShortcuts").children[0].children[0].text, "go to session")
      verify(findChild(controls, "intent-SEND_TEXT_TO_APPLICATION").routeColor !== shortcut.routeColor, "Color identifies the mode")
      compare(findChild(findChild(controls, "intent-SEND_TEXT_TO_APPLICATION"), "intentModeState").text, "● On")
      compare(findChild(findChild(controls, "intent-START_CODING_AGENT_SESSION"), "intentModeState").text, "○ Off")
      compare(findChild(findChild(controls, "intent-IGNORE"), "intentModeState").text, "● Always on")
      const waiting = findChild(controls, "intent-CONTINUE_OPEN_AGENT_CONVERSATION")
      compare(findChild(waiting, "intentModeState").text, "● On")
      compare(findChild(waiting, "intentModeContext").text, "Needs conversation context")
      verify(waiting.color !== findChild(controls, "intent-START_CODING_AGENT_SESSION").color, "Missing context looks different from Off")
      const cleanup = findChild(controls, "transcriptionCleanupSwitch")
      verify(cleanup.visible)
      verify(cleanup.mapToItem(controls, 0, 0).y >= cards.mapToItem(controls, 0, cards.height).y, "Cleanup stays apart from the activity cards")
    }

    function test_card_title_and_padding_never_toggle_and_modes_toggle_only_themselves() {
      const host = createTemporaryObject(viewComponent, scene, {width: 900, height: 1200})
      host.panel.intents = scene.fullInventory()
      const controls = findChild(host, "intentControls")
      const requests = []
      host.panel.intentEnabledRequested.connect(function(name, enabled, mode) { requests.push([name, enabled, mode]) })
      const card = findChild(controls, "activity-SEND_TEXT_TO_APPLICATION")
      showItem(host, card)
      const title = findChild(card, "activityTitle")
      mouseClick(title, title.width / 2, title.height / 2)
      mouseClick(card, card.width - 3, 3)
      mouseClick(card, 3, card.height - 3)
      compare(requests.length, 0, "The title and card padding are not controls")

      const inference = findChild(card, "intent-SEND_TEXT_TO_APPLICATION")
      const shortcut = findChild(card, "shortcut-SEND_TEXT_TO_APPLICATION")
      mouseClick(inference, inference.width - 4, inference.height / 2)
      compare(requests, [["SEND_TEXT_TO_APPLICATION", false, "inference"]])
      compare(inference.routeEnabled, true, "No optimistic change before the backend replies")
      compare(shortcut.routeEnabled, true)
      mouseClick(shortcut, 6, shortcut.height - 4)
      compare(requests[1], ["SEND_TEXT_TO_APPLICATION", false, "shortcut"])

      const next = scene.fullInventory()
      next[0].inferenceEnabled = false
      host.panel.intents = next
      const updated = findChild(controls, "intent-SEND_TEXT_TO_APPLICATION")
      compare(findChild(updated, "intentModeState").text, "○ Off")
      compare(findChild(findChild(controls, "shortcut-SEND_TEXT_TO_APPLICATION"), "intentModeState").text, "● On",
        "The other mode keeps its own backend state")

      const ignore = findChild(controls, "intent-IGNORE")
      showItem(host, ignore)
      mouseClick(ignore, ignore.width / 2, ignore.height / 2)
      compare(requests.length, 2, "The required fallback cannot be switched off")

      host.panel.paused = true
      compare(findChild(updated, "intentModeState").text, "○ Off", "Pausing keeps the explicit labels")
      compare(findChild(controls, "shortcut-SEND_TEXT_TO_APPLICATION").active, false)
      host.panel.paused = false
      host.panel.online = false
      const shortcutOffline = findChild(controls, "shortcut-SEND_TEXT_TO_APPLICATION")
      showItem(host, shortcutOffline)
      mouseClick(shortcutOffline, shortcutOffline.width / 2, shortcutOffline.height / 2)
      compare(requests.length, 2, "Disconnected cards send nothing")
    }

    function test_responsive_columns_follow_width_and_reader_zoom_data() {
      return [
        {tag: "narrow", width: 360, zoom: 100, columns: 1},
        {tag: "default", width: 600, zoom: 100, columns: 2},
        {tag: "wide", width: 1400, zoom: 100, columns: 5},
        {tag: "wide-zoomed", width: 1400, zoom: 200, columns: 2},
        {tag: "narrow-zoomed", width: 420, zoom: 200, columns: 1}
      ]
    }

    function test_responsive_columns_follow_width_and_reader_zoom(data) {
      const host = createTemporaryObject(viewComponent, scene, {width: data.width, height: 1200})
      host.panel.intents = scene.fullInventory()
      host.panel.transcriptionCleanup = {enabled: true}
      host.panel.zoomPercent = data.zoom
      verify(waitForRendering(host))
      const controls = findChild(host, "intentControls")
      compare(controls.columns, data.columns)
      const rows = {}
      for (const intent of scene.fullInventory()) {
        const card = findChild(controls, "activity-" + intent.name)
        verify(card.width >= Math.min(controls.width, controls.minimumCardWidth) - 0.5, intent.name + " keeps a readable width")
        verify(card.x + card.width <= controls.width + 0.5)
        const title = findChild(card, "activityTitle")
        verify(title.contentWidth <= title.width + 0.5, "Titles wrap inside their card")
        rows[card.y] = (rows[card.y] || 0) + 1
      }
      for (const y in rows)
        verify(rows[y] <= data.columns)
      compare(rows[0], Math.min(data.columns, scene.fullInventory().length), "The first row uses every column")
      const cleanup = findChild(controls, "transcriptionCleanupSwitch")
      verify(cleanup.width <= controls.width + 0.5)
      if (data.tag === "wide" || data.tag === "narrow" || data.tag === "wide-zoomed") {
        findChild(host, "listeningArea").expanded = false
        findChild(host, "voiceSection").expanded = false
        showItem(host, findChild(controls, "activity-IGNORE"))
        grabImage(host).save("/tmp/companion-activity-cards-" + data.tag + ".png")
      }
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
      const list = findChild(page, "activityScroll")
      function pageY(item) { return item.mapToItem(list.contentItem, 0, 0).y - list.originY }
      compare(pageY(stage), 0)
      compare(input.y + input.height, page.height)
      verify(page.viewportHeight + 12 * data.unit <= input.y)
      verify(pageY(stage) + stage.height + 20 * data.unit <= pageY(controls))
      verify(pageY(controls) + controls.height + 20 * data.unit <= pageY(footer))
      verify(pageY(footer) + footer.height <= page.contentHeight + 1)
      verify(footer.height >= 4 * 10 * data.unit, "Measure every line of real keyboard help")
      for (const route of controls.routes) {
        const chip = findChild(controls, (route.mode === "inference" ? "intent-" : "shortcut-") + route.intent.name)
        const text = findChild(chip, "intentCardText")
        verify(text.y + text.height + 8 * data.unit <= chip.height + 0.5, "Mode text fits its control")
        const card = findChild(controls, "activity-" + route.intent.name)
        const inside = chip.mapToItem(card, 0, 0)
        verify(inside.x >= 0 && inside.x + chip.width <= card.width + 0.5, "Mode control stays inside its activity card")
        verify(inside.y >= 0 && inside.y + chip.height + 8 * data.unit <= card.height + 0.5, "Mode control stays inside its activity card")
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
