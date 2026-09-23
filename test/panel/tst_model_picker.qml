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
