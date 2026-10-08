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
        historyDeletionAvailable: true
        intents: [
          {
            name: "SEND_TEXT_TO_APPLICATION",
            label: "Type text",
            enabled: true,
            supportsInference: true,
            inferenceEnabled: true,
            shortcutEnabled: true,
            toggleable: true,
            inferenceAvailable: true,
            prefixAvailable: true,
            prefixes: ["insert"]
          },
          {
            name: "START_CODING_AGENT_SESSION",
            label: "Ask a coding agent",
            enabled: true,
            supportsInference: true,
            inferenceEnabled: true,
            shortcutEnabled: true,
            toggleable: true,
            inferenceAvailable: true,
            prefixAvailable: true,
            prefixes: ["new session"]
          },
          {
            name: "IGNORE",
            label: "Ignore",
            enabled: true,
            supportsInference: true,
            inferenceEnabled: true,
            shortcutEnabled: true,
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
      const list = findChild(page, "activityScroll");
      page.scrollTo(history.mapToItem(list.contentItem, 0, 0).y - list.originY);
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

    function test_deletion_reconnect_and_delayed_pages_cannot_restore_text() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      state.update("run", entry(1, null));
      state.update("run", entry(2, null));
      const removal = {id: "utterance-1", sequence: 1, revision: 3, deleted: true};
      state.remove("old-run", removal);
      compare(state.model.count, 2);
      state.remove("run", removal);
      compare(state.model.count, 1);
      state.page({sessionId: "run", entries: [entry(1, null)], next: null});
      state.update("run", entry(1, true, 2));
      compare(state.model.count, 1, "Delayed pages and feedback cannot resurrect a deleted card");
      state.disconnected();
      state.observe("run", 2);
      state.page({sessionId: "run", entries: [], removed: [{id: "utterance-2", sequence: 2, revision: 4, deleted: true}], next: null});
      compare(state.model.count, 0, "Reconnect replays a deletion missed while offline");
      state.observe("new-run", 1);
      state.update("new-run", entry(1, null));
      compare(state.model.count, 1, "Tombstones belong to one listener run");
    }

    function test_delete_cross_hover_click_and_offline_compatibility() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      state.update("run", entry(1, null));
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      const requests = [];
      host.panel.historyActionRequested.connect((action, id) => requests.push({action: action, id: id}));
      showHistory(host);
      const card = findChild(host, "history-utterance-1");
      const button = findChild(card, "history-action-delete-history");
      mouseMove(host, 2, 2);
      tryCompare(button, "opacity", 0);
      mouseMove(card, 10, 10);
      tryCompare(button, "opacity", 1);
      mouseClick(button);
      compare(requests.length, 1);
      compare(requests[0].action, "delete-history");
      compare(requests[0].id, "utterance-1");
      compare(state.model.count, 1, "The card waits for confirmed server deletion");
      host.panel.online = false;
      compare(button.enabled, false);
      mouseClick(button);
      compare(requests.length, 1);
      host.panel.online = true;
      host.panel.historyDeletionAvailable = false;
      compare(button.visible, false, "Older listeners and previews do not offer deletion");
      host.panel.historyDeletionAvailable = true;
      button.forceActiveFocus();
      tryCompare(button, "opacity", 1);
      keyClick(Qt.Key_Space);
      compare(requests.length, 2, "Keyboard activation uses the same explicit row");
      state.remove("run", {id: "utterance-1", sequence: 1, revision: 2, deleted: true});
      compare(state.model.count, 0);
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
      // The Storage setting makes the header taller; keep the hovered card's
      // action row inside this fixed-height test window.
      findChild(host, "fullActivityStatus").scrollToItem(card);
      verify(waitForRendering(host));
      tryCompare(card, "actionsVisible", true);
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
      findChild(host, "fullActivityStatus").scrollToItem(card);
      verify(waitForRendering(host));
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

    function test_capture_storage_off_disables_labeling_and_marks_unsaved_entries() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      const legacy = entry(1, true);
      const unsaved = entry(2, null);
      unsaved.captureStorage = "off";
      state.update("run", legacy);
      state.update("run", unsaved);
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      host.panel.captureStorage = {enabled: false, pending: "", saved: true, warning: ""};
      verify(waitForRendering(host));
      showHistory(host);

      // Storage off: labeling is disabled everywhere, including older saved
      // entries, while their existing label stays visible.
      const old = findChild(host, "history-utterance-1");
      compare(old.feedback, "correct");
      compare(old.labelable, false);
      compare(findChild(old, "historyNotSaved").visible, false, "Older entries are not claimed unsaved");
      old.choosingIntent = true;
      compare(findChild(old, "history-action-correct").enabled, false);
      compare(findChild(old, "history-action-incorrect").enabled, false);
      verify(findChild(old, "history-action-start-history-agent").visible, "Saved media stay usable");
      compare(findChild(old, "historyLabelingUnavailable").text, "Labeling requires capture storage.");
      verify(findChild(old, "historyLabelingUnavailable").visible);
      old.choosingIntent = false;

      // A new unsaved entry says so and offers nothing that needs its capture.
      const card = findChild(host, "history-utterance-2");
      verify(findChild(card, "historyNotSaved").visible);
      compare(findChild(card, "historyNotSaved").text, "Not saved · audio and screenshot were not kept");
      compare(findChild(card, "history-action-start-history-agent").visible, false);
      verify(findChild(card, "history-action-copy").visible, "Text actions still work");

      // Storage on again: older entries can be labeled; unsaved ones never.
      host.panel.captureStorage = {enabled: true, pending: "", saved: true, warning: ""};
      compare(old.labelable, true);
      compare(card.labelable, false);
      card.choosingIntent = true;
      compare(findChild(card, "history-action-correct").enabled, false);
      compare(findChild(card, "historyLabelingUnavailable").text, "Labeling requires this entry's saved capture.");
      card.choosingIntent = false;

      // A partly saved entry (its screenshot was not kept) stays unlabelable
      // and offers no screenshot-dependent session, even while storage is on.
      const partial = entry(3, null);
      partial.captureStorage = "on";
      partial.screenshotSaved = false;
      partial.labelingUnavailable = "The original screenshot for this entry was not saved";
      state.update("run", partial);
      tryVerify(() => findChild(host, "history-utterance-3") !== null);
      const partialCard = findChild(host, "history-utterance-3");
      compare(partialCard.labelable, false);
      compare(findChild(partialCard, "historyNotSaved").visible, false);
      verify(findChild(partialCard, "historyOriginalUnavailable").visible);
      compare(findChild(partialCard, "historyOriginalUnavailable").text, "The original screenshot for this entry was not saved.");
      compare(findChild(partialCard, "history-action-start-history-agent").visible, false);
      partialCard.choosingIntent = true;
      compare(findChild(partialCard, "history-action-correct").enabled, false);
      compare(findChild(partialCard, "historyLabelingUnavailable").text, "Labeling requires this entry's complete saved capture.");
      partialCard.choosingIntent = false;

      // While an Off is being acknowledged, labeling is already unavailable.
      host.panel.captureStorage = {enabled: false, pending: "disabling", saved: true, warning: ""};
      compare(old.labelable, false);
    }

    function test_later_original_loss_overrides_publication_flags_and_stale_pages() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      const saved = entry(1, true);
      saved.captureStorage = "on";
      saved.screenshotSaved = true;
      saved.audioSaved = true;
      state.update("run", saved);
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      host.panel.captureStorage = {enabled: true, pending: "", saved: true, warning: ""};
      findChild(host, "listeningArea").expanded = false;
      showHistory(host);
      const card = findChild(host, "history-utterance-1");
      compare(card.labelable, true);
      verify(findChild(card, "history-action-start-history-agent").visible);

      const lost = Object.assign({}, saved, {
        revision: 2,
        screenshotUnavailable: true,
        labelingUnavailable: "The original screenshot for this entry is unavailable"
      });
      state.update("run", lost);
      compare(card.feedback, "correct", "Existing labels are preserved");
      compare(card.labelable, false);
      compare(findChild(card, "history-action-start-history-agent").visible, false);
      verify(findChild(card, "historyOriginalUnavailable").visible);
      verify(findChild(card, "history-action-copy").visible);
      state.page({sessionId: "run", entries: [saved], next: null});
      compare(card.labelable, false, "A delayed page cannot revive a known lost original");

      const audioLost = Object.assign({}, saved, {
        revision: 3,
        screenshotUnavailable: false,
        labelingUnavailable: "The original audio for this entry is unavailable"
      });
      state.update("run", audioLost);
      compare(card.labelable, false);
      verify(findChild(card, "history-action-start-history-agent").visible, "An intact screenshot still supports a history question");
    }

    function test_cleaned_text_appears_below_the_raw_transcript_with_its_own_copy_action() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      const cleaned = entry(1, null);
      cleaned.utterance = "um so open the uh design";
      cleaned.cleanupEnabled = true;
      cleaned.cleanupStatus = "cleaned";
      cleaned.cleanedText = "Open the design.";
      cleaned.cleanupFallback = null;
      const fallback = entry(2, null);
      fallback.cleanupEnabled = true;
      fallback.cleanupStatus = "fallback";
      fallback.cleanedText = null;
      fallback.cleanupFallback = "timeout";
      state.update("run", cleaned);
      state.update("run", fallback);
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      showHistory(host);

      const card = findChild(host, "history-utterance-1");
      compare(findChild(card, "historyUtterance").text, "um so open the uh design", "Raw text stays the main text");
      const line = findChild(card, "historyCleanup");
      verify(line.visible);
      compare(line.text, "Cleaned: Open the design.");
      mouseMove(card, 10, 10);
      tryCompare(card, "actionsVisible", true);
      verify(findChild(card, "history-action-copy-cleaned").visible);

      const other = findChild(host, "history-utterance-2");
      compare(findChild(other, "historyCleanup").text, "Cleanup fell back to the raw transcript (timeout)");
      mouseMove(other, 10, 10);
      tryCompare(other, "actionsVisible", true);
      compare(findChild(other, "history-action-copy-cleaned").visible, false);
    }

    function test_text_from_an_earlier_attempt_is_labeled_and_unspecified_is_not() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      const recovered = entry(1, null);
      recovered.outcome = "error";
      recovered.transcriptSource = "earlier-attempt";
      const ordinary = entry(2, null);
      ordinary.transcriptSource = null;
      state.update("run", recovered);
      state.update("run", ordinary);
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      showHistory(host);

      const line = findChild(findChild(host, "history-utterance-1"), "historyTranscriptSource");
      verify(line.visible);
      compare(line.text, "Text from an earlier part of this utterance; the full recording was not transcribed");
      compare(findChild(findChild(host, "history-utterance-2"), "historyTranscriptSource").visible, false);
    }

    function test_an_audio_only_record_is_labeled_and_offers_no_text_actions() {
      const state = createTemporaryObject(stateComponent, scene);
      state.reset("run");
      const audioOnly = entry(1, null);
      audioOnly.utterance = "";
      audioOnly.intent = null;
      audioOnly.outcome = "error";
      audioOnly.transcriptSource = "audio-only";
      state.update("run", audioOnly);
      const host = createTemporaryObject(viewComponent, scene);
      host.panel.activityHistoryModel = state.model;
      findChild(host, "listeningArea").expanded = false;
      showHistory(host);

      const card = findChild(host, "history-utterance-1");
      const line = findChild(card, "historyTranscriptSource");
      verify(line.visible);
      compare(line.text, "Audio only: no speech was recognized, so nothing was sent");
      mouseMove(card, 10, 10);
      tryCompare(card, "actionsVisible", true);
      for (const action of ["copy", "paste", "start-history-agent"])
        compare(findChild(card, "history-action-" + action).visible, false, action);
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
      const prefix = findChild(findChild(host, "shortcut-SEND_TEXT_TO_APPLICATION"), "intentCardShortcuts");
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
      verify(card.width <= findChild(host, "activityScroll").width);
      verify(findChild(card, "historyDetectedIntent").width <= card.width);
      const detected = findChild(card, "historyDetectedIntent");
      verify(detected.mapToItem(card, 0, detected.height).y <= card.height, "Wrapped metadata stays inside its card");
    }
  }
}
