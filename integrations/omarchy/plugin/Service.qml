import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import Quickshell.Services.Mpris
import "../../panel" as Panel

// This adapter owns Omarchy/Hyprland behavior. Companion only sees the portable
// JSON protocol documented in src/desktop/README.md.
Item {
  id: root

  property var shell: null
  property bool online: false
  property bool paused: false
  property string pauseReason: ""
  property bool mediaPauseAvailable: false
  property bool speaking: false
  property bool soundsEnabled: false
  property bool soundsAvailable: false
  property int processing: 0
  property var history: []
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
  property string pendingUtterance: ""
  property var intents: []
  // {enabled: bool}, or null when the listener has no transcription cleanup.
  property var transcriptionCleanup: null
  // Null when the listener does not report capture storage: unavailable.
  property var captureStorage: null
  property var agentActions: ({})
  property string lastError: ""
  property string lastErrorAction: ""
  property bool opened: false
  property var rows: []
  property int selectedIndex: 0
  property string targetAddress: ""
  property string targetComposerId: ""
  property var pickerScreen: null
  property bool panelOpened: false
  property var pendingAgentInput: null
  property var pendingHistoryInsert: null
  property var pendingAgentChoice: null
  property string lastApplication: ""
  readonly property bool panelKeyboardFocused: native.ready ? native.status.active === true : sidePanel.keyboardFocused
  readonly property bool panelInputFocused: native.ready ? native.status.inputFocused === true || root.panelComposerId !== "" : sidePanel.inputFocused
  readonly property string panelComposerId: native.ready ? native.status.composerFocusId || "" : sidePanel.composerFocusId
  function isNativeWindow(window) {
    return window && ((window.wayland && window.wayland.appId === "companion")
      || window.lastIpcObject?.class === "companion")
  }
  readonly property var transport: connection.item
  onPanelOpenedChanged: Qt.callLater(root.reportPanelState)
  onOnlineChanged: {
    if (online) {
      if (native.ready) Qt.callLater(root.reportObserverState)
      Qt.callLater(root.reportPanelState)
      Qt.callLater(root.reportMediaPlayback)
    }
  }

  PlaybackState {
    id: playback
    players: Mpris.players ? Mpris.players.values : []
    pausedState: MprisPlaybackState.Paused
    onPlayingChanged: root.reportMediaPlayback()
  }

  NativeBridge {
    id: native
    onReadyChanged: {
      // Hand off selection exactly once. Subsequent observer snapshots must
      // never reclaim the native UI's voice destination or clear its focus.
      root.panelOpened = false
      root.pendingHistoryInsert = null
      playback.resumePaused()
      if (ready) {
        root.reportObserverState()
        native.send({action: "claim"})
      }
    }
    onEvent: message => {
      if (message.type === "pause-media") playback.pausePlaying()
      else if (message.type === "resume-media") playback.resumePaused()
      else if (message.type === "restore-focus") root.finishFocusRestore(message.address)
      else if (message.type === "history-paste") root.historyAction("paste", message.id, {})
      else if (message.type === "activity-text") root.historyAction("submit-utterance", message.id, {text: message.text})
    }
    onStatusChanged: root.finishNativeInsert()
  }

  Connections {
    target: Hyprland
    function onActiveToplevelChanged() {
      const window = Hyprland.activeToplevel
      if (root.isNativeWindow(window)) return
      const address = window ? window.address : ""
      if (address) root.lastApplication = address.startsWith("0x") ? address : "0x" + address
      root.finishNativeInsert()
    }
  }

  Timer {
    id: insertDeadline
    interval: 2000
    onTriggered: {
      if (root.pendingHistoryInsert) {
        root.failInsertion("Application focus was not restored; try again.")
      }
    }
  }

  function reportMediaPlayback() {
    if (root.mediaPauseAvailable) {
      root.send({action: "media-playback", playing: playback.playing})
    }
  }

  Panel.AgentSessionState {
    id: agentSessions
    panelVisible: root.panelOpened && sidePanel.visible
    onRevealRequested: if (!native.ready) root.panelOpened = true
    onConversationIdChanged: Qt.callLater(root.reportPanelState)
    onPanelVisibleChanged: Qt.callLater(root.reportPanelState)
    onNavigationTokenChanged: Qt.callLater(root.reportPanelState)
    onControlRequested: request => {
      if (!root.send(request)) {
        const failure = {type: "error", action: request.action, message: "Companion is disconnected."}
        agentSessions.controlReceived(failure)
        root.lastError = failure.message
        root.lastErrorAction = request.action
      }
    }
  }

  Panel.ActivityHistoryState {
    id: activityHistory
    onPageRequested: request => root.send(request)
  }

  // While the native window owns the panel, this observer still keeps its own
  // conversations. Declare once per connection that routine state messages
  // may omit them; this neutral report never claims selection or focus.
  function reportObserverState() {
    root.send({action: "panel-state", id: "", composerFocused: false, keyboardFocused: false,
      incrementalSessions: true})
  }

  function reportPanelState() {
    if (native.ready) return
    // A retained selection without a displayed panel is not a voice target.
    const id = agentSessions.viewedId
    root.send({action: "panel-state", id: id,
      composerFocused: id !== "" && sidePanel.composerFocusId === id,
      keyboardFocused: sidePanel.keyboardFocused,
      visible: agentSessions.panelVisible, navigationToken: agentSessions.navigationToken,
      draftHost: true, incrementalSessions: true})
  }

  // The listener only asks the panel that advertised draftHost. Apply the text
  // to that conversation's composer and always answer with the real outcome.
  function applyAgentDraft(message) {
    const result = native.ready
      ? {outcome: "unavailable", reason: "Another Companion window holds this panel's drafts."}
      : sidePanel.applyDraft(message)
    root.send({action: "agent-draft-result", requestId: message.requestId,
      outcome: result.outcome, reason: result.reason || ""})
    const changed = result.outcome === "inserted" || result.outcome === "appended"
    if (changed && message.focus === true) agentSessions.reveal(message.id)
  }

  function composerFocusChanged() {
    root.reportPanelState()
    // Coalesce transient focus changes while switching between conversation
    // tabs. Leaving the composer for another window or Activity restores media.
    if (!root.panelInputFocused) playback.resumePaused()
  }

  function togglePanel() {
    // The history picker and status panel have separate lifetimes. Dismissing
    // history here cancels it; opening the panel must never trigger a paste.
    root.cancel()
    if (native.ready) { native.send({action: "toggle"}); return }
    root.panelOpened = !root.panelOpened
  }

  function closePanel() {
    root.pendingHistoryInsert = null
    if (native.ready) native.send({action: "hide"})
    root.panelOpened = false
  }

  function toggleComposerFocus() {
    if (native.ready) {
      root.cancel()
      native.send({action: "focus", address: root.lastApplication})
      return
    }
    if (!root.online) {
      root.panelOpened = true
      root.lastError = "Companion is disconnected."
      root.lastErrorAction = "focus-agent"
      return
    }
    root.cancel()
    if (agentSessions.showingPrevious) agentSessions.select("")
    const previous = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    const address = previous && !previous.startsWith("0x") ? "0x" + previous : previous
    root.panelOpened = true
    sidePanel.toggleComposerFocus(address)
    if (root.lastErrorAction === "focus-agent") {
      root.lastError = ""
      root.lastErrorAction = ""
    }
  }

  function restoreApplicationFocus(address) {
    // Addresses come from compositor state, never from chat text. A window
    // closed since activation is no longer a valid focus destination.
    if (!/^0x[0-9a-f]+$/i.test(address)) return
    const exists = Hyprland.toplevels.values.some(window => {
      const candidate = window.address.startsWith("0x") ? window.address : "0x" + window.address
      return candidate === address
    })
    if (exists) Hyprland.dispatch('hl.dsp.focus({ window = "address:' + address + '" })')
  }

  function send(request) {
    if (!root.online) {
      return false
    }

    transport.write(JSON.stringify(request) + "\n")
    transport.flush()
    return true
  }

  function togglePause() {
    root.send({ action: "toggle-pause" })
  }

  function toggleSounds() {
    root.send({ action: "toggle-sounds" })
  }

  function sendAgentInput(id, text) {
    if (!root.online) {
      sidePanel.submitted(id, text, "Companion is disconnected; your draft is retained.")
      return
    }
    root.pendingAgentInput = {id: id, text: text}
    root.send({action: "send-agent", id: id, text: text})
  }

  function finishAgentInput(error) {
    if (root.pendingAgentInput) {
      sidePanel.submitted(root.pendingAgentInput.id, root.pendingAgentInput.text, error)
      root.pendingAgentInput = null
    }
  }

  function finishUtterance(error) {
    const text = root.pendingUtterance
    root.pendingUtterance = ""
    if (text !== "") sidePanel.utteranceSubmitted(text, error)
  }

  function insertionError(request, error) {
    if (request.action === "submit-utterance") {
      if (native.ready) native.send({action: "utterance-failed", id: request.id, text: request.text, error: error})
      else root.finishUtterance(error)
    }
    root.lastErrorAction = request.action
    root.lastError = error
  }

  function failInsertion(error) {
    const pending = root.pendingHistoryInsert
    root.pendingHistoryInsert = null
    insertDeadline.stop()
    if (pending) root.insertionError(pending, error)
  }

  function historyAction(action, id, value) {
    if (action !== "paste" && action !== "submit-utterance") {
      root.send(Object.assign({action: action, id: id}, value))
      return
    }
    const request = Object.assign({action: action, id: id}, value)
    if (!root.online || root.pendingHistoryInsert) {
      root.insertionError(request, root.online ? "Wait for the previous insertion." : "Companion is disconnected; your draft is retained.")
      return
    }
    const previous = native.ready ? root.lastApplication : Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    const address = previous && !previous.startsWith("0x") ? "0x" + previous : previous
    if (!/^0x[0-9a-f]+$/i.test(address)) {
      root.insertionError(request, "Select an application window before sending.")
      return
    }
    root.pendingHistoryInsert = Object.assign(request, {target: address})
    insertDeadline.restart()
    if (native.ready) native.send({action: "release-for-insertion", address: address})
    else sidePanel.releaseForInsertion(address)
  }

  function forgetUtterance(id) {
    root.history = root.history.filter(row => row.id !== id)
    const selected = root.rows[root.selectedIndex]
    // A held recovery chord must never jump to another utterance on deletion.
    // Preserve an unrelated selection; cancel if its selected row disappeared.
    if (selected && selected.id === id) root.cancel()
    root.rows = root.rows.filter(row => row.id !== id)
    root.selectedIndex = selected ? Math.max(0, root.rows.findIndex(row => row.id === selected.id)) : 0
    if (root.pendingHistoryInsert && root.pendingHistoryInsert.id === id) root.pendingHistoryInsert = null
  }

  function chooseAgent(id, revision, index) {
    if (!root.online) {
      sidePanel.choiceSubmitted(id, revision, index, "Companion is disconnected.")
      return
    }
    root.pendingAgentChoice = {id: id, revision: revision, index: index}
    // Send the visible tab first, in the same ordered socket stream as the click.
    root.reportPanelState()
    root.send({action: "choose-agent", id: id, revision: revision, index: index})
  }

  function finishAgentChoice(error) {
    if (!root.pendingAgentChoice) return
    const request = root.pendingAgentChoice
    root.pendingAgentChoice = null
    sidePanel.choiceSubmitted(request.id, request.revision, request.index, error)
  }

  function updateAgentActions(actions) {
    const next = actions || {}
    if (JSON.stringify(root.agentActions) !== JSON.stringify(next)) root.agentActions = next
  }

  function receive(line) {
    try {
      const message = JSON.parse(line)
      agentSessions.controlReceived(message)
      if (message.action === "agent-tool-page" || message.action === "agent-history-page") { sidePanel.toolPageReceived(message); return }

      if (message.type === "state" && message.protocol === 1) {
        root.paused = message.paused
        root.pauseReason = message.pauseReason || ""
        root.mediaPauseAvailable = message.mediaPauseAvailable === true
        root.speaking = message.speaking === true
        root.soundsEnabled = message.soundsEnabled === true
        root.soundsAvailable = typeof message.soundsEnabled === "boolean" && !message.preview
        root.processing = message.processing
        root.history = message.history
        root.historyDeletionAvailable = message.historyDeletionAvailable === true
        root.textInputAvailable = message.textInputAvailable === true
        // Speech/history snapshots must not rebuild chips underneath a held
        // mouse click or tooltip. Only changed routing state replaces the list.
        const intents = message.intents || []
        if (JSON.stringify(root.intents) !== JSON.stringify(intents)) root.intents = intents
        const cleanup = message.transcriptionCleanup || null
        if (JSON.stringify(root.transcriptionCleanup) !== JSON.stringify(cleanup)) root.transcriptionCleanup = cleanup
        const storage = message.captureStorage || null
        if (JSON.stringify(root.captureStorage) !== JSON.stringify(storage)) root.captureStorage = storage
        root.updateAgentActions(message.agentActions)
        agentSessions.applyState(message)
        agentSessions.controlsAvailable = message.sessionControlsAvailable === true
        // Activate the panel only after its first/reconnected snapshot is ready,
        // so it never animates a stale phrase retained from the old connection.
        root.online = message.ready
        if (root.online) activityHistory.observe(message.activitySessionId, message.activityHistoryCount)
      } else if (message.type === "history-deleted") {
        root.forgetUtterance(message.id)
        activityHistory.remove(message.sessionId, message.removed)
      } else if (message.type === "activity-entry") {
        activityHistory.update(message.sessionId, message.entry)
      } else if (message.type === "agent-session") {
        agentSessions.update(message.session)
      } else if (message.type === "agent-actions") {
        root.updateAgentActions(message.actions)
      } else if (message.type === "agent-history") {
        agentSessions.previousSessions = message.sessions || []
      } else if (message.type === "agent-restored") {
        agentSessions.restore(message.session, message.reveal)
      } else if (message.type === "agent-draft") {
        root.applyAgentDraft(message)
      } else if (message.type === "agent-removed") {
        agentSessions.remove(message.id)
      } else if (message.type === "error") {
        if (message.action === "activity-history") activityHistory.loading = false
        if (message.action === "send-agent") root.finishAgentInput(message.message)
        if (message.action === "submit-utterance") root.finishUtterance(message.message)
        if (message.action === "choose-agent") root.finishAgentChoice(message.message)
        root.lastError = message.message
        root.lastErrorAction = message.action || ""
      } else if (message.type === "result") {
        if (message.action === "activity-history") activityHistory.page(message.result)
        if (message.action === "send-agent") root.finishAgentInput("")
        if (message.action === "submit-utterance") root.finishUtterance("")
        if (message.action === "choose-agent") root.finishAgentChoice("")
        if (message.result === "skipped") {
          root.lastError = "Paste skipped: focus changed"
          root.lastErrorAction = "paste"
        } else if (root.lastErrorAction === (message.action || "")) {
          // A delayed paste result must not hide an unrelated control error.
          root.lastError = ""
          root.lastErrorAction = ""
        }
      }
    } catch (error) {
      root.lastError = "Could not read Companion state"
    }
  }

  function begin() {
    if (root.opened) {
      return
    }

    // The activity panel keeps its own visibility while history is selected.
    // Both overlays leave keyboard focus in the destination application.
    // Snapshot rows at press time. Arriving speech must never move the selected
    // utterance underneath a held shortcut. A tap starts on the newest row.
    root.rows = root.history.slice()
    root.selectedIndex = 0
    const address = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    root.targetAddress = address && !address.startsWith("0x") ? "0x" + address : address
    root.targetComposerId = root.panelComposerId
    const monitor = Hyprland.focusedMonitor
    root.pickerScreen = Quickshell.screens.find(screen => screen.name === monitor?.name) || null
    root.lastError = ""
    root.opened = true
  }

  function moveSelection(delta) {
    root.selectedIndex = Math.max(0, Math.min(root.rows.length - 1, root.selectedIndex + delta))
  }

  function cancel() {
    root.opened = false
  }

  function release() {
    if (!root.opened) {
      return
    }

    root.opened = false
    const row = root.rows[root.selectedIndex]

    if (root.online && row && root.targetAddress) {
      root.send({ action: "paste", id: row.id, target: root.targetAddress, composer: root.targetComposerId })
    }
  }

  // Handle only the press: the matching release must not immediately resume.
  // Reuse the menu's socket action so the backend remains the source of state.
  GlobalShortcut {
    appid: "companion"
    name: "pause"
    description: "Pause or resume Companion listening"
    onPressed: root.togglePause()
  }

  GlobalShortcut {
    appid: "companion"
    name: "panel"
    description: "Toggle Companion side panel"
    onPressed: root.togglePanel()
  }

  GlobalShortcut {
    appid: "companion"
    name: "focus"
    description: "Toggle focus in the Companion input"
    onPressed: root.toggleComposerFocus()
  }

  // Hyprland owns Super+Alt+Tab before Qt sees it. Its Lua adapter forwards it
  // while our panel exists; only a focused panel takes it for tab navigation.
  // Otherwise perform the original desktop action in the ordinary application.
  GlobalShortcut {
    appid: "companion"
    name: "next-tab"
    onPressed: {
      if (native.ready && root.panelKeyboardFocused) native.send({action: "next-tab"})
      else if (sidePanel.keyboardFocused) sidePanel.nextTab()
      else Hyprland.dispatch("hl.dsp.group.next()")
    }
  }

  // These are Omarchy's existing horizontal resize actions. Its leftward
  // expansion widens our right-anchored panel; outside it, retain the original
  // window dispatcher and its direction exactly.
  GlobalShortcut {
    appid: "companion"
    name: "expand-width"
    onPressed: {
      if (native.ready && root.panelKeyboardFocused) native.send({action: "resize", delta: 100})
      else if (sidePanel.keyboardFocused) sidePanel.resizeBy(100)
      else Hyprland.dispatch("hl.dsp.window.resize({ x = -100, y = 0, relative = true })")
    }
  }
  GlobalShortcut {
    appid: "companion"
    name: "shrink-width"
    onPressed: {
      if (native.ready && root.panelKeyboardFocused) native.send({action: "resize", delta: -100})
      else if (sidePanel.keyboardFocused) sidePanel.resizeBy(-100)
      else Hyprland.dispatch("hl.dsp.window.resize({ x = 100, y = 0, relative = true })")
    }
  }

  // Only finish completes a chord, after V and both modifiers are up. Hyprland
  // also releases history on V-up, which is too early when modifiers remain.
  // Both shortcuts use this resident connection, so a tap cannot race startup.
  GlobalShortcut {
    appid: "companion"
    name: "history"
    description: "Hold for speech history; release to paste"
    onPressed: root.begin()
  }

  GlobalShortcut {
    appid: "companion"
    name: "previous"
    onPressed: { if (root.opened) root.moveSelection(-1) }
  }

  GlobalShortcut {
    appid: "companion"
    name: "next"
    onPressed: { if (root.opened) root.moveSelection(1) }
  }

  GlobalShortcut {
    appid: "companion"
    name: "cancel"
    onPressed: root.cancel()
  }

  GlobalShortcut {
    appid: "companion"
    name: "finish"
    onReleased: root.release()
  }

  // Small diagnostic/control surface for CLI use and the opt-in desktop test.
  // Transcript contents remain on Companion's private socket, not in status.
  IpcHandler {
    target: "companion"
    function status(): string {
      return JSON.stringify({ online: root.online, paused: root.paused,
        pauseReason: root.pauseReason, mediaPlaying: playback.playing,
        speaking: root.speaking, processing: root.processing,
        soundsEnabled: root.soundsEnabled, soundsAvailable: root.soundsAvailable,
        opened: root.opened, selectedIndex: root.selectedIndex,
        panelOpened: native.ready ? native.status.opened : root.panelOpened,
        panelVisible: native.ready ? native.status.opened : sidePanel.visible,
        nativeWindow: native.ready,
        selectedSessionId: native.ready ? native.status.sessionId : agentSessions.conversationId,
        panelMonitor: sidePanel.monitorName,
        panelWidth: sidePanel.width,
        activityHistoryCount: activityHistory.model.count,
        composerFocusId: root.panelComposerId, composerFocusPhase: sidePanel.composerFocusPhase,
        count: root.history.length, error: root.lastError })
    }
    function togglePause(): void { root.togglePause() }
    function toggleSounds(): void { root.toggleSounds() }
    function cancel(): void { root.cancel() }
    function togglePanel(): void { root.togglePanel() }
    function closePanel(): void { root.closePanel() }
    function toggleComposerFocus(): void { root.toggleComposerFocus() }
  }

  function connectionLost() {
    root.finishAgentInput("Connection lost before confirmation. Check the conversation before resending; your draft is retained.")
    root.finishUtterance("Connection lost before confirmation. Check History before resending; your draft is retained.")
    root.textInputAvailable = false
    root.finishAgentChoice("Connection lost before confirmation. Check the conversation before choosing again.")
    root.online = false
    root.speaking = false
    root.processing = 0
    root.history = []
    root.pendingHistoryInsert = null
    insertDeadline.stop()
    activityHistory.disconnected()
    agentSessions.disconnectControls()
    root.intents = []
    root.transcriptionCleanup = null
    root.captureStorage = null
    root.agentActions = ({})
    root.cancel()

    // Quickshell's Socket retains its native socket after a failed initial
    // connect. Recreate the object instead of toggling its connected property.
    // Defer destruction until the native error signal has returned.
    Qt.callLater(() => { connection.active = false })
  }

  Loader {
    id: connection
    active: false
    sourceComponent: Component {
      Socket {
        path: Quickshell.env("XDG_RUNTIME_DIR") + "/companion/control.sock"
        parser: SplitParser {
          onRead: data => root.receive(data)
        }
        Component.onCompleted: connected = true
        onConnectedChanged: {
          if (!connected) {
            root.connectionLost()
          }
        }
        onError: root.connectionLost()
      }
    }
  }

  // Avoid logging a native socket error every second while Companion is
  // intentionally stopped. Probe existence before creating a connection.
  Process {
    id: socketProbe
    command: ["test", "-S", Quickshell.env("XDG_RUNTIME_DIR") + "/companion/control.sock"]
    onExited: code => {
      if (code === 0) {
        connection.active = true
      }
    }
  }

  Component.onCompleted: socketProbe.running = true

  Timer {
    interval: 1000
    running: true
    repeat: true
    onTriggered: {
      if (!connection.active && !socketProbe.running) {
        socketProbe.running = true
      }
    }
  }

  HistoryPicker {
    id: picker
    opened: root.opened
    online: root.online
    rows: root.rows
    selectedIndex: root.selectedIndex
    pickerScreen: root.pickerScreen
    onCancelled: root.cancel()
  }

  // Leave the panel open on socket loss so it can explain the offline state
  // and visibly reconnect when Companion starts again.
  SidePanel {
    id: sidePanel
    opened: root.panelOpened && !native.ready
    online: root.online
    paused: root.paused
    pauseReason: root.pauseReason
    speaking: root.speaking
    processing: root.processing
    history: root.history
    intents: root.intents
    transcriptionCleanup: root.transcriptionCleanup
    captureStorage: root.captureStorage
    activityHistoryModel: activityHistory.model
    activityHistoryAvailable: activityHistory.available
    historyDeletionAvailable: root.historyDeletionAvailable
    textInputAvailable: root.textInputAvailable
    onUtteranceRequested: text => {
      root.pendingUtterance = text
      root.historyAction("submit-utterance", "", {text: text})
    }
    agentActions: root.agentActions
    sessions: agentSessions.sessions
    sessionControls: agentSessions
    unreadSessionIds: agentSessions.unreadIds
    previousSessions: agentSessions.previousSessions
    showingPrevious: agentSessions.showingPrevious
    controlError: ["set-agent-model", "set-agent-thinking", "move-agent", "close-agent", "reopen-agent", "stop-agent", "stop-agent-run", "focus-agent", "set-intent-enabled", "set-transcription-cleanup", "set-capture-storage", "paste", "start-history-agent", "label-history", "delete-history", "activity-history"].includes(root.lastErrorAction) ? root.lastError : ""
    selectedSessionId: agentSessions.selectedId
    onCloseRequested: root.closePanel()
    onIntentEnabledRequested: (name, enabled, mode) => root.send({action: "set-intent-enabled", name: name, enabled: enabled, mode: mode})
    onTranscriptionCleanupRequested: enabled => root.send({action: "set-transcription-cleanup", enabled: enabled})
    onCaptureStorageRequested: enabled => root.send({action: "set-capture-storage", enabled: enabled})
    onHistoryActionRequested: (action, id, value) => root.historyAction(action, id, value)
    onSessionSelected: id => agentSessions.select(id)
    onPreviousRequested: agentSessions.showingPrevious = true
    onReopenSessionRequested: id => root.send({action: "reopen-agent", id: id})
    onStopSessionRequested: id => root.send({action: "stop-agent", id: id})
    onDismissSessionRequested: id => root.send({action: "close-agent", id: id})
    onSendSessionRequested: (id, text) => root.sendAgentInput(id, text)
    onToolPageRequested: request => { root.reportPanelState(); root.send(request) }
    onChoiceRequested: (id, revision, index) => root.chooseAgent(id, revision, index)
    onStopRunRequested: (id, runId) => {
      root.reportPanelState()
      root.send({action: "stop-agent-run", id: id, runId: runId})
    }
    onComposerFocusRequested: playback.pausePlaying()
    onComposerFocusReleased: Qt.callLater(root.composerFocusChanged)
    onComposerFocusIdChanged: Qt.callLater(root.composerFocusChanged)
    onInputFocusedChanged: Qt.callLater(root.composerFocusChanged)
    onKeyboardFocusedChanged: Qt.callLater(root.reportPanelState)
    onRestoreFocusRequested: address => root.finishFocusRestore(address)
  }

  function finishFocusRestore(address) {
    const pending = root.pendingHistoryInsert
    if (pending) {
      const active = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
      const current = active && !active.startsWith("0x") ? "0x" + active : active
      if (current !== pending.target && !(native.ready && root.isNativeWindow(Hyprland.activeToplevel))) {
        root.failInsertion("Focus changed before sending; try again.")
        return
      }
    }
    root.restoreApplicationFocus(address)
    if (native.ready && pending && pending.target === address) {
      root.pendingHistoryInsert = Object.assign({}, pending, {restoring: true})
      root.finishNativeInsert()
      return
    }
    root.pendingHistoryInsert = null
    insertDeadline.stop()
    if (pending && pending.target === address) {
      // Report relinquished panel focus before queuing keyboard delivery.
      // The backend rechecks both the ordinary window and this focus boundary.
      Qt.callLater(function() {
        root.reportPanelState()
        root.send({action: pending.action, id: pending.id, text: pending.text, target: pending.target, composer: ""})
      })
    }
  }

  function finishNativeInsert() {
    const pending = root.pendingHistoryInsert
    if (!native.ready || !pending || !pending.restoring || native.status.active) return
    // Qt's focus-out can arrive before Hyprland's toplevel update. Wait for the
    // compositor report instead of discarding a valid in-progress restoration.
    if (root.isNativeWindow(Hyprland.activeToplevel)) return
    const active = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    const current = active && !active.startsWith("0x") ? "0x" + active : active
    root.pendingHistoryInsert = null
    insertDeadline.stop()
    if (current !== pending.target) {
      root.insertionError(pending, "Focus changed before sending; try again.")
      return
    }
    // The native client sends its final focus report and paste on one ordered
    // backend connection. A bridge socket race must never revive composer focus.
    native.send({action: pending.action === "submit-utterance" ? "utterance-after-release" : "paste-after-release",
      id: pending.id, text: pending.text, target: pending.target})
  }
}
