import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 500
  height: 200

  TextInput {
    id: editor
    width: 300
    height: 40
    text: "Keyboard focus stays in this application"
  }

  Panel.PanelHandle {
    id: handle
    x: 400
    y: 50
    opened: false
    background: "#1a1b26"
    foreground: "#c0caf5"
    borderColor: "#7aa2f7"
    selection: "#24283b"
    onToggleRequested: opened = !opened
  }

  TestCase {
    name: "CompanionPanelHandle"
    when: windowShown

    function test_click_expands_and_collapses_without_keyboard_focus() {
      editor.forceActiveFocus()
      verify(editor.activeFocus)
      compare(handle.Accessible.name, "Expand Companion panel")

      mouseClick(handle)
      compare(handle.opened, true)
      compare(handle.Accessible.name, "Collapse Companion panel")
      verify(editor.activeFocus)

      mouseClick(handle)
      compare(handle.opened, false)
      verify(handle.visible)
      verify(editor.activeFocus)
    }
  }
}
