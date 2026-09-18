import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 600
  height: 600
  Component {
    id: focusComponent
    Panel.ComposerFocus {
      available: true
      mapped: true
      sessionId: "question-1"
      settleDuration: 40
      onFocusRequested: if (mapped) actualFocus = true
      onReleaseRequested: actualFocus = false
    }
  }
  Component {
    id: chatComponent
    Panel.SessionView {
      width: 420
      height: 500
      session: ({id: "question-1", title: "Question", status: "completed", messages: []})
      foreground: "white"
      muted: "gray"
      accent: "lightblue"
      selection: "#283348"
      fontFamily: "sans-serif"
    }
  }
  TestCase {
    name: "CompanionComposerFocus"
    when: windowShown

    function test_toggle_focus_and_restore_after_releasing_keys() {
      const control = createTemporaryObject(focusComponent, parent)
      let restored = ""
      control.restoreRequested.connect(function(address) {
        compare(control.keyboardMode, "none")
        restored = address
      })
      control.toggle("0xabc")
      compare(control.actualFocus, true)
      compare(control.grabRequested, true)
      tryCompare(control, "phase", "idle")
      compare(control.keyboardMode, "on-demand")
      wait(control.settleDuration * 3)
      compare(control.grabRequested, true, "Keyboard summoning must not expire after a timer")
      control.toggle("0xabc")
      compare(control.actualFocus, false)
      compare(control.grabRequested, false)
      compare(control.keyboardMode, "none")
      compare(restored, "")
      tryVerify(function() { return restored === "0xabc" })
      compare(control.phase, "idle")
    }

    function test_repeated_toggle_cancels_delayed_restore() {
      const control = createTemporaryObject(focusComponent, parent)
      let restored = 0
      control.restoreRequested.connect(function() { restored++ })
      control.toggle("0xabc")
      control.toggle("0xabc")
      control.toggle("0xdef")
      tryCompare(control, "phase", "idle")
      compare(restored, 0)
      compare(control.actualFocus, true)
      compare(control.previousWindow, "0xdef")
    }

    function test_external_focus_loss_releases_without_restoring_the_previous_app() {
      const control = createTemporaryObject(focusComponent, parent)
      let restored = 0
      control.restoreRequested.connect(function() { restored++ })
      control.toggle("0xabc")
      compare(control.grabRequested, true)
      control.actualFocus = false
      compare(control.grabRequested, false)
      compare(control.previousWindow, "")
      wait(control.settleDuration * 2)
      compare(restored, 0)
    }

    function test_hiding_or_changing_tab_cancels_pending_focus_and_restore() {
      for (const disable of [true, false]) {
        const control = createTemporaryObject(focusComponent, parent)
        let restored = 0
        control.restoreRequested.connect(function() { restored++ })
        control.toggle("0xabc")
        control.toggle("0xabc")
        if (disable) control.available = false
        else control.sessionId = "question-2"
        wait(control.settleDuration + 25)
        compare(restored, 0)
        compare(control.actualFocus, false)
        compare(control.phase, "idle")
        compare(control.previousWindow, "")
      }
    }

    function test_acquisition_waits_until_the_surface_is_mapped() {
      const control = createTemporaryObject(focusComponent, parent, {mapped: false})
      control.toggle("0xabc")
      wait(control.settleDuration + 25)
      compare(control.phase, "acquiring")
      control.mapped = true
      tryCompare(control, "phase", "idle")
      control.available = false
      control.toggle("0xdef")
      compare(control.keyboardMode, "none")
      compare(control.actualFocus, false)
    }

    function test_focus_entry_and_release_preserve_the_composer_draft() {
      const chat = createTemporaryObject(chatComponent, parent)
      const composer = findChild(chat, "sessionComposer")
      composer.text = "Keep this unfinished message"
      chat.focusComposer()
      tryCompare(composer, "activeFocus", true)
      compare(chat.composerFocusId, "question-1")
      chat.releaseComposerFocus()
      compare(composer.activeFocus, false)
      compare(chat.composerFocusId, "")
      compare(composer.text, "Keep this unfinished message")
    }
  }
}
