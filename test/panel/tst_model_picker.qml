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
      return [{tag: "normal", unit: 1}, {tag: "scaled", unit: 1.5}]
    }

    function renderedPixel(setup, item, x, y) {
      const point = item.mapToItem(setup, x, y)
      return grabImage(setup).pixel(Math.round(point.x), Math.round(point.y))
    }

    function test_closed_field_and_popup_follow_panel_theme(data) {
      const setup = createTemporaryObject(fixture, parent)
      setup.picker.unit = data.unit
      const chooser = findChild(setup, "sessionModelPicker")
      verify(waitForRendering(chooser))

      // Inspect rendered pixels: merely setting a palette did not prevent the
      // platform style from drawing a pale gradient behind near-white text.
      compare(renderedPixel(setup, chooser, 6, chooser.height - 6), setup.picker.selection)
      compare(chooser.contentItem.color, setup.picker.foreground)
      verify(chooser.font.pixelSize >= 12 * data.unit)

      mouseClick(chooser, 35, chooser.height / 2)
      tryCompare(chooser.popup, "visible", true)
      verify(waitForRendering(chooser.popup.background))
      const row = chooser.popup.contentItem.itemAtIndex(1)
      verify(row !== null)
      compare(renderedPixel(setup, row, 6, row.height - 6), setup.picker.selection)
      compare(row.contentItem.color, setup.picker.foreground)

      // A theme change must recolor an already-open popup as well as its field.
      setup.picker.selection = "#343b2f"
      setup.picker.foreground = "#f3f0d9"
      verify(waitForRendering(chooser.popup.background))
      compare(renderedPixel(setup, row, 6, row.height - 6), setup.picker.selection)
      compare(row.contentItem.color, setup.picker.foreground)
      keyClick(Qt.Key_Escape)
      tryCompare(chooser.popup, "visible", false)
      verify(waitForRendering(chooser))
      compare(renderedPixel(setup, chooser, 6, chooser.height - 6), setup.picker.selection)
    }
  }
}
