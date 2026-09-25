import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 320
  height: 400

  Component {
    id: phraseComponent
    Panel.PhraseActivity {
      width: 300
      height: 250
      active: true
      muted: "gray"
      accent: "cyan"
      fontFamily: "sans-serif"
      unit: 1
      riseDuration: 80
      resultHoldDuration: 100
      fadeDuration: 120
    }
  }

  TestCase {
    name: "CompanionPhrase"
    when: windowShown

    function row(id, intent, outcome, text) {
      return {id: id, utterance: text || "Please send this phrase.",
        intent: intent, outcome: outcome}
    }

    function test_processing_result_and_fade() {
      const view = createTemporaryObject(phraseComponent, parent)
      const card = findChild(view, "phraseCard")
      const label = findChild(view, "phraseLabel")
      const text = findChild(view, "phraseText")
      view.history = [row("first", null, "processing")]
      compare(label.text, "PROCESSING")
      compare(label.horizontalAlignment, Text.AlignLeft)
      compare(text.color, "#66bb6a")
      const startY = card.y
      tryCompare(view, "arrived", true)
      verify(card.y < startY)

      // Classification is not the end of processing: delivery may still run.
      view.history = [row("first", "SEND_TEXT_TO_APPLICATION", "delivering")]
      compare(label.text, "PROCESSING")
      view.history = [row("first", "SEND_TEXT_TO_APPLICATION", "sent")]
      compare(label.text, "SEND_TEXT_TO_APPLICATION")
      compare(label.horizontalAlignment, Text.AlignRight)
      compare(label.color, "#82aaff")
      compare(text.color, label.color)
      tryCompare(view, "presenting", false)
      compare(card.visible, false)

      // Sound/VAD updates broadcast the same history again. Never replay it.
      view.history = [row("first", "SEND_TEXT_TO_APPLICATION", "sent")]
      compare(view.presenting, false)
    }

    function test_fast_result_finishes_rise_first() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("fast", null, "processing")]
      view.history = [row("fast", "ENTER_TEXT_TO_APPLICATION", "sent")]
      compare(view.showingResult, false)
      compare(view.label, "PROCESSING")
      tryCompare(view, "showingResult", true)
      compare(view.label, "ENTER_TEXT_TO_APPLICATION")
      compare(view.phraseColor, "#c792ea")
    }

    function test_open_skips_history_but_adopts_pending_work() {
      const view = createTemporaryObject(phraseComponent, parent, {
        history: [row("old", "IGNORE", "ignored")]
      })
      compare(view.presenting, false)
      view.active = false
      view.history = [row("pending", null, "processing")]
      view.active = true
      compare(view.presenting, true)
      compare(view.label, "PROCESSING")
    }

    function test_close_cancels_animation_and_completed_replay() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("first", null, "processing")]
      view.active = false
      compare(view.presenting, false)
      compare(view.visibility, 0)
      view.history = [row("first", "IGNORE", "ignored")]
      view.active = true
      wait(120)
      compare(view.presenting, false)
      compare(view.visibility, 0)
    }

    function test_new_phrase_replaces_result_without_old_timer() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("old", null, "processing")]
      view.history = [row("old", "IGNORE", "ignored")]
      tryCompare(view, "showingResult", true)
      compare(view.phraseColor, "#808080")

      view.history = [row("new", null, "processing"), row("old", "IGNORE", "ignored")]
      wait(400)
      compare(view.presenting, true)
      compare(view.label, "PROCESSING")
      compare(view.utteranceId, "new")
    }

    function test_failure_does_not_invent_an_intent() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("failed", null, "processing")]
      view.history = [row("failed", null, "error")]
      tryCompare(view, "showingResult", true)
      compare(view.label, "ERROR")
      compare(view.phraseColor, "#ef5350")
      tryCompare(view, "presenting", false)
    }

    function test_failed_delivery_keeps_its_outcome_data() {
      return [
        {tag: "focus changed", outcome: "skipped"},
        {tag: "typing failed", outcome: "error"},
        {tag: "cancelled", outcome: "cancelled"},
        {tag: "interrupted", outcome: "interrupted"}
      ]
    }

    function test_failed_delivery_keeps_its_outcome(data) {
      const view = createTemporaryObject(phraseComponent, parent)
      const label = findChild(view, "phraseLabel")
      const text = findChild(view, "phraseText")
      view.history = [row("failed-send", "SEND_TEXT_TO_APPLICATION", "delivering")]
      compare(label.text, "PROCESSING")
      compare(text.color, "#66bb6a")

      view.history = [row("failed-send", "SEND_TEXT_TO_APPLICATION", data.outcome)]
      tryCompare(view, "showingResult", true)
      compare(label.text, data.outcome.toUpperCase() + " · SEND_TEXT_TO_APPLICATION")
      compare(label.horizontalAlignment, Text.AlignRight)
      compare(label.color, "#ef5350")
      compare(text.color, label.color)
      tryCompare(view, "presenting", false)
    }

    function test_preview_reports_that_no_input_was_sent() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("preview", null, "processing")]
      view.history = [row("preview", "SEND_TEXT_TO_APPLICATION", "preview")]
      tryCompare(view, "showingResult", true)
      compare(view.label, "PREVIEW · SEND_TEXT_TO_APPLICATION")
      compare(view.phraseColor, "#82aaff")
    }

    function test_superseded_phrase_is_neutral() {
      const view = createTemporaryObject(phraseComponent, parent)
      view.history = [row("provisional", null, "processing")]
      view.history = [row("provisional", null, "superseded")]
      tryCompare(view, "showingResult", true)
      compare(view.label, "SUPERSEDED")
      compare(view.failed, false)
      compare(view.phraseColor, view.muted)
    }

    function test_transcript_is_literal_text() {
      const view = createTemporaryObject(phraseComponent, parent)
      const transcript = "<b>Keep this literal</b> & café — 🙂"
      view.history = [row("literal", null, "processing", transcript)]
      const text = findChild(view, "phraseText")
      compare(text.text, transcript)
      compare(text.textFormat, Text.PlainText)
    }
  }
}
