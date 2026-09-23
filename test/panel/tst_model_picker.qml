import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  width: 620
  height: 480

  Component {
    id: fixture
    Rectangle {
      id: setup
      width: 580
      height: 440
      color: "#1a1b26"
      property alias picker: footer

      Panel.ModelPicker {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 12
        session: ({id: "synthetic", profile: "coding", model: "configured/current"})
        catalog: ({models: ["configured/alternate"], coding: "configured/current"})
        catalogLoaded: true
        online: true
        background: setup.color
        foreground: "#e0e6f0"
        muted: "#959faa"
        selection: "#283348"
        fontFamily: "sans-serif"
      }
    }
  }

  TestCase {
    name: "ModelPickerAppearance"
    when: windowShown

    function test_pins_all_models_and_effort_keyboard_selection() {
      const setup = createTemporaryObject(fixture, parent)
      const picker = setup.picker
      picker.catalog = {
        models: ["configured/other", "configured/reasoner", "configured/plain"],
        pinned: ["configured/reasoner"], coding: "configured/reasoner", codingThinking: "off",
        thinkingLevels: {"configured/reasoner": ["minimal", "low", "medium", "high"], "configured/plain": ["off"]}
      }
      let choices = []
      picker.thinkingRequested.connect((id, value) => { choices.push({id: id, value: value}) })
      const model = findChild(setup, "sessionModelPicker")
      const effort = findChild(setup, "sessionThinkingPicker")
      const all = findChild(setup, "showAllSessionModels")
      compare(model.count, 2, "Only the default and Pi's pinned model appear initially")
      verify(effort.currentText.indexOf("minimal") >= 0, "Inherited off is adapted for a reasoning model")
      compare(effort.count, 5)
      verify(!effort.model.some(row => row.value === "off"))
      verify(waitForRendering(effort))
      mouseClick(effort, 25, effort.height / 2)
      keyClick(Qt.Key_End)
      keyClick(Qt.Key_Return)
      compare(choices.length, 1)
      compare(choices[0].id, "synthetic")
      compare(choices[0].value, "high")
      mouseClick(all, all.width / 2, all.height / 2)
      compare(model.count, 4)
      // Retain an unpinned chosen model when collapsing; never mislabel it unavailable.
      picker.session = {id: "synthetic", profile: "coding", modelOverride: "configured/plain", thinkingOverride: "high"}
      mouseClick(all, all.width / 2, all.height / 2)
      compare(model.count, 3)
      compare(model.currentText, "configured/plain")
      compare(effort.currentText, "off")
      // Empty scopes are intentionally short, with an explicit expansion control.
      picker.session = {id: "synthetic", profile: "coding"}
      picker.catalog = Object.assign({}, picker.catalog, {pinned: []})
      compare(model.count, 1)
      all.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(model.count, 4)
    }

    function test_effort_popup_pins_rows_and_rejects_changed_conversation() {
      const setup = createTemporaryObject(fixture, parent)
      const picker = setup.picker
      picker.catalog = {models: ["configured/current"], pinned: [], coding: "configured/current", codingThinking: "medium",
        thinkingLevels: {"configured/current": ["off", "minimal", "low", "medium", "high"]}}
      const effort = findChild(setup, "sessionThinkingPicker")
      let choices = []
      picker.thinkingRequested.connect((id, value) => { choices.push(value) })
      verify(waitForRendering(effort))
      mouseClick(effort, 25, effort.height / 2)
      compare(effort.popup.visible, true)
      picker.catalog = Object.assign({}, picker.catalog, {thinkingLevels: {"configured/current": ["off"]}})
      compare(effort.count, 6, "An arriving catalogue cannot change a row under the pointer")
      keyClick(Qt.Key_End)
      keyClick(Qt.Key_Return)
      compare(choices[0], "high", "Backend revalidation owns a stale choice")
      mouseClick(effort, 25, effort.height / 2)
      picker.session = {id: "new-conversation", profile: "coding"}
      tryCompare(effort.popup, "visible", false)
      keyClick(Qt.Key_Return)
      compare(choices.length, 1)
    }

    function test_effort_fields_remain_inside_narrow_zoomed_footer() {
      const setup = createTemporaryObject(fixture, parent)
      setup.width = 340
      setup.picker.unit = 2
      const model = findChild(setup, "sessionModelPicker")
      const effort = findChild(setup, "sessionThinkingPicker")
      verify(waitForRendering(model))
      verify(effort.y > model.y + model.height)
      verify(effort.x >= 0 && effort.x + effort.width <= setup.picker.width)
      verify(effort.y + effort.height <= setup.picker.height)
      compare(effort.enabled, false, "Old listeners without effort metadata cannot submit it")
    }

    function test_closed_field_and_popup_follow_panel_theme_data() {
      return [
        {tag: "normal", unit: 1, selection: "#283348"},
        {tag: "scaled", unit: 1.5, selection: "#283348"},
        {tag: "translucent", unit: 1, selection: "#14a9b1d6"},
        {tag: "translucent scaled", unit: 1.5, selection: "#14a9b1d6"}
      ]
    }

    function renderedPixel(setup, item, x, y) {
      const point = item.mapToItem(setup, x, y)
      return grabImage(setup).pixel(Math.round(point.x), Math.round(point.y))
    }

    function compareRenderedColors(actual, expected) {
      // Qt's raster blend and QColor composition can round a channel one byte
      // apart. Compare the rendered menu with the field, not a copied formula.
      fuzzyCompare(actual.r, expected.r, 1 / 255 + 0.0001)
      fuzzyCompare(actual.g, expected.g, 1 / 255 + 0.0001)
      fuzzyCompare(actual.b, expected.b, 1 / 255 + 0.0001)
      compare(actual.a, 1)
    }

    function test_closed_field_and_popup_follow_panel_theme(data) {
      const setup = createTemporaryObject(fixture, parent)
      setup.picker.unit = data.unit
      setup.picker.selection = data.selection
      const chooser = findChild(setup, "sessionModelPicker")
      verify(waitForRendering(chooser))

      // Inspect rendered pixels: merely setting a palette did not prevent the
      // platform style from drawing a pale gradient behind near-white text.
      const fieldColor = renderedPixel(setup, chooser, 6, chooser.height - 6)
      if (setup.picker.selection.a === 1) compare(fieldColor, setup.picker.selection)
      compare(chooser.contentItem.color, setup.picker.foreground)
      verify(chooser.font.pixelSize >= 12 * data.unit)

      mouseClick(chooser, 35, chooser.height / 2)
      tryCompare(chooser.popup, "visible", true)
      verify(waitForRendering(chooser.popup.background))
      const row = chooser.popup.contentItem.itemAtIndex(1)
      verify(row !== null)
      compareRenderedColors(renderedPixel(setup, row, 6, row.height - 6), fieldColor)
      compare(row.contentItem.color, setup.picker.foreground)

      // Change both the base surface and translucent overlay while open. This
      // also checks a light theme without letting content show through menus.
      setup.color = "#f4f0e8"
      setup.picker.selection = "#14222222"
      setup.picker.foreground = "#222222"
      verify(waitForRendering(chooser.popup.background))
      const updatedFieldColor = renderedPixel(setup, chooser, 6, chooser.height - 6)
      compareRenderedColors(renderedPixel(setup, row, 6, row.height - 6), updatedFieldColor)
      compare(row.contentItem.color, setup.picker.foreground)
      keyClick(Qt.Key_Escape)
      tryCompare(chooser.popup, "visible", false)
      verify(waitForRendering(chooser))
      compareRenderedColors(renderedPixel(setup, chooser, 6, chooser.height - 6), updatedFieldColor)
    }
  }
}
