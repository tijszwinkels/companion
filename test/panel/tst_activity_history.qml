import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 650
  height: 1100
  Component {
    id: stateComponent
    Panel.ActivityHistoryState {}
  }
  Component {
    id: viewComponent
    Rectangle {
      width: 600
      height: 1000
      color: "#161e2b"
      property alias panel: panel
      Panel.PanelContent {
        id: panel
        anchors.fill: parent
        online: true
        paused: false
        speaking: false
        processing: 0
        foreground: "#dce5ef"
        muted: "#8ba0b8"
        accent: "#9fc0f7"
        selection: "#293a51"
        fontFamily: "sans-serif"
        activityHistoryAvailable: true
        intents: [
          {
            name: "SEND_TEXT_TO_APPLICATION",
            label: "Type text",
            enabled: true,
            toggleable: true,
            inferenceAvailable: true,
            prefixAvailable: true,
            prefixes: ["insert"]
          },
          {
            name: "START_CODING_AGENT_SESSION",
            label: "Ask a coding agent",
            enabled: true,
            toggleable: true,
            inferenceAvailable: true,
            prefixAvailable: true,
            prefixes: ["quick question", "new coding agent"]
          },
          {
            name: "IGNORE",
            label: "Ignore",
            enabled: true,
            toggleable: false,
            inferenceAvailable: true,
            prefixAvailable: false,
            prefixes: []
          }
        ]
      }
    }
  }

  function entry(sequence, correct, revision = 1) {
    return {
      id: "utterance-" + sequence,
      sequence: sequence,
      revision: revision,
      utterance: sequence === 1 ? "Open the design and explain how these modules fit together." : "Let's keep the conversation moving without losing the details.",
      intent: "SEND_TEXT_TO_APPLICATION",
      outcome: "sent",
      observedAt: 1789817000000 + sequence * 1000,
      correct: correct,
      actualIntent: null
    };
  }

  TestCase {
    name: "CompanionActivityHistory"
    when: windowShown

    function showHistory(host) {
      verify(waitForRendering(host));
      const page = findChild(host, "fullActivityStatus");
      const history = findChild(host, "historySection");
      page.contentY = Math.max(0, Math.min(page.contentHeight - page.height, history.y));
      verify(waitForRendering(host));
    }

    function test_text_zoom_follows_activity_history_library_and_conversation() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("zoom-run");
      state.update("zoom-run", entry(1, null));
      const host = createTemporaryObject(viewComponent, scene);
      const panel = host.panel;
      panel.activityHistoryModel = state.model;
      panel.forceActiveFocus();
      verify(waitForRendering(host));
      const page = findChild(host, "fullActivityStatus");
      const history = findChild(host, "historySection");
      const controls = findChild(host, "intentControls");
      verify(history.y >= controls.y + controls.height, "History follows Intentions");
      const originalWidth = panel.width;
      keyClick(Qt.Key_Plus, Qt.ControlModifier);
      compare(panel.zoomPercent, 110);
      keyClick(Qt.Key_Equal, Qt.ControlModifier);
      keyClick(Qt.Key_Plus, Qt.ControlModifier | Qt.ShiftModifier);
      compare(panel.zoomPercent, 130);
      keyClick(Qt.Key_Minus, Qt.ControlModifier);
      compare(panel.zoomPercent, 120);
      compare(controls.textScale, 1.2);
      showHistory(host);
      const utterance = findChild(host, "historyUtterance");
      compare(utterance.font.pixelSize, 17);
      compare(panel.width, originalWidth, "Reader zoom keeps the panel width");

      panel.sessions = [{id: "zoom-chat", title: "Zoom test", status: "completed", error: "", messages: []}];
      panel.selectedSessionId = "zoom-chat";
      const chat = findChild(host, "sessionView");
      const composer = findChild(chat, "sessionComposer");
      composer.text = "Keep this draft";
      panel.focusComposer();
      keyClick(Qt.Key_Plus, Qt.ControlModifier);
      compare(panel.zoomPercent, 130, "Conversation handles the key exactly once");
      compare(composer.text, "Keep this draft");

      panel.showingPrevious = true;
      keyClick(Qt.Key_Minus, Qt.ControlModifier);
      compare(panel.zoomPercent, 120);
      compare(findChild(panel, "previousSessionsList").parent.textScale, 1.2);
      panel.showingPrevious = false;
      panel.selectedSessionId = "";
      compare(page.textScale, 1.2);
      keyClick(Qt.Key_0, Qt.ControlModifier);
      compare(panel.zoomPercent, 100);
      panel.selectedSessionId = "zoom-chat";
      compare(composer.text, "Keep this draft");
      panel.selectedSessionId = "";
      panel.zoomPercent = 200;
      keyClick(Qt.Key_Plus, Qt.ControlModifier);
      compare(panel.zoomPercent, 200);
      host.width = 360;
      showHistory(host);
      grabImage(host).save("/tmp/companion-activity-history-zoom.png");
      panel.zoomPercent = 80;
      keyClick(Qt.Key_Minus, Qt.ControlModifier);
      compare(panel.zoomPercent, 80);
      panel.animationsEnabled = false;
      keyClick(Qt.Key_0, Qt.ControlModifier);
      compare(panel.zoomPercent, 80, "Closed panels do not handle reader zoom");
    }

    function test_pages_live_updates_and_reconnect_preserve_newer_feedback() {
      const state = createTemporaryObject(stateComponent, scene);
      const requests = [];
      state.pageRequested.connect(request => requests.push(request));
      state.observe("run-one", 120);
      compare(requests.length, 1);
      compare(requests[0].through, 120);
      state.update("run-one", entry(120, false, 4));
      state.page({
        sessionId: "run-one",
        entries: [entry(1, null), entry(120, null)],
        next: 50,
        through: 120
      });
      compare(state.model.count, 2);
      compare(state.model.get(0).feedback, "incorrect");
      compare(requests[1].after, 50);
      state.page({
        sessionId: "run-one",
        entries: [entry(70, true)],
        next: null
      });
      compare(state.model.get(1).sequence, 70);
      compare(state.synced, true);
      state.disconnected();
      state.observe("run-one", 121);
      compare(state.model.count, 3, "Reconnect keeps known cards while fetching missed updates");
      compare(requests.length, 3);
      state.observe("run-two", 0);
      compare(state.model.count, 0);
      state.page({
        sessionId: "run-one",
        entries: [entry(1, null)],
        next: null
      });
      compare(state.model.count, 0, "Old listener responses cannot populate the new run");
    }

    function test_hover_actions_and_correction_preserve_original_intent() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      state.update("run", entry(1, null));
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      const requests = [];
      host.panel.historyActionRequested.connect((action, id, value) => requests.push({
          action: action,
          id: id,
          value: value
        }));
      verify(waitForRendering(host));
      showHistory(host);
      const card = findChild(host, "history-utterance-1");
      verify(card !== null);
      mouseMove(card, 10, 10);
      tryCompare(card, "actionsVisible", true);
      wait(180);
      mouseClick(findChild(card, "history-action-paste"));
      compare(requests[0].action, "paste");
      compare(requests[0].id, "utterance-1");
      mouseClick(findChild(card, "history-action-start-history-agent"));
      compare(requests[1].action, "start-history-agent");
      mouseClick(findChild(card, "history-action-incorrect"));
      compare(requests[2].value.correct, false);
      compare(card.choosingIntent, true);
      state.update("run", entry(1, false, 2));
      compare(card.feedback, "incorrect");
      compare(card.tone.toString(), "#f17f90");
      wait(180);
      const choice = findChild(card, "history-correction-START_CODING_AGENT_SESSION");
      mouseClick(choice);
      compare(requests[3].value.actualIntent, "START_CODING_AGENT_SESSION");
      compare(card.choosingIntent, false);
      compare(card.intent, "SEND_TEXT_TO_APPLICATION");
      state.update("run", entry(1, true, 3));
      compare(card.feedback, "correct");
      compare(card.tone.toString(), "#65d6a1");
      host.panel.online = false;
      compare(findChild(card, "history-action-paste").enabled, false);
    }

    function test_collapsing_keeps_history_and_shortcuts_are_on_intent_cards() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      for (let index = 1; index <= 130; index++)
        state.update("run", entry(index, null));
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      verify(waitForRendering(host));
      showHistory(host);
      const history = findChild(host, "historySection");
      const expandedHeight = history.height;
      mouseClick(findChild(history, "sectionToggle"));
      compare(history.expanded, false);
      verify(history.height < expandedHeight);
      compare(state.model.count, 130);
      mouseClick(findChild(history, "sectionToggle"));
      compare(history.expanded, true);
      const intentions = findChild(host, "intentionsSection");
      const voice = findChild(host, "voiceSection");
      intentions.expanded = false;
      voice.expanded = false;
      compare(findChild(host, "intent-SEND_TEXT_TO_APPLICATION").active, true);
      const prefix = findChild(findChild(host, "intent-SEND_TEXT_TO_APPLICATION"), "intentCardShortcuts");
      verify(prefix.height > 0);
      compare(state.model.count, 130);
    }

    function test_history_visual_preview_and_narrow_width() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      state.update("run", entry(1, true));
      state.update("run", entry(2, false));
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "intentionsSection").expanded = false;
      findChild(host, "voiceSection").expanded = false;
      verify(waitForRendering(host));
      wait(450);
      grabImage(host).save("/tmp/companion-activity-history-preview.png");
      host.width = 360;
      verify(waitForRendering(host));
      grabImage(host).save("/tmp/companion-activity-history-preview-narrow.png");
      const card = findChild(host, "history-utterance-2");
      verify(card.width <= findChild(host, "activityHistoryList").width);
      verify(findChild(card, "historyDetectedIntent").width <= card.width);
      const detected = findChild(card, "historyDetectedIntent");
      verify(detected.mapToItem(card, 0, detected.height).y <= card.height, "Wrapped metadata stays inside its card");
    }
  }
}
