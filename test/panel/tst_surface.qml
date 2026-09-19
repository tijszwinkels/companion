import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 600
  height: 900
  Component {
    id: surfaceComponent
    Panel.PanelSurface { opened: false }
  }
  TestCase {
    name: "CompanionPanelSurface"
    when: windowShown

    function test_full_height_surface_opens_without_resizing_parent() {
      const surface = createTemporaryObject(surfaceComponent, scene)
      compare(surface.x, 600)
      compare(surface.y, 0)
      compare(surface.width, 600)
      compare(surface.height, 900)
      surface.opened = true
      tryCompare(surface, "reveal", 1)
      compare(surface.x, 0)
      compare(Math.round(surface.x + surface.width), scene.width)
      compare(Math.round(surface.y + surface.height), scene.height)
      compare(scene.width, 600)
      compare(scene.height, 900)
      compare(surface.width, 600)
      compare(surface.height, 900)
      compare(surface.y, 0)
    }

    function test_slide_reverses_from_its_current_position() {
      const surface = createTemporaryObject(surfaceComponent, scene)
      surface.opened = true
      wait(60)
      verify(surface.reveal > 0 && surface.reveal < 1)
      const partialReveal = surface.reveal
      surface.opened = false
      compare(surface.reveal, partialReveal)
      tryCompare(surface, "reveal", 0)
      compare(surface.x, scene.width)
      surface.opened = true
      tryCompare(surface, "reveal", 1)
      compare(surface.x, 0)
    }

    function test_small_display_caps_both_dimensions() {
      const host = Qt.createQmlObject('import QtQuick; Item { width: 320; height: 300 }', scene)
      const surface = createTemporaryObject(surfaceComponent, host)
      compare(surface.width, 320)
      compare(surface.height, 300)
      surface.opened = true
      tryCompare(surface, "reveal", 1)
      compare(surface.x, 0)
      compare(surface.y, 0)
      surface.destroy()
      host.destroy()
    }

    function test_resize_bounds_and_remembered_width() {
      const surface = createTemporaryObject(surfaceComponent, scene, {availableWidth: 1200})
      surface.resizeBy(100)
      compare(surface.width, 700)
      surface.resizeBy(-100)
      compare(surface.width, 600)
      surface.resizeBy(-1000)
      compare(surface.width, 360)
      surface.resizeBy(2000)
      compare(surface.width, 1200)
      // A smaller monitor clamps immediately; the next press uses that actual
      // width rather than the remembered width of the larger monitor.
      surface.availableWidth = 800
      compare(surface.width, 800)
      surface.resizeBy(-100)
      compare(surface.width, 700)
      surface.opened = true
      tryCompare(surface, "reveal", 1)
      compare(surface.x + surface.width, scene.width)
      surface.opened = false
      tryCompare(surface, "reveal", 0)
      surface.opened = true
      compare(surface.width, 700)
      surface.availableWidth = 320
      surface.resizeBy(-100)
      compare(surface.width, 320)
    }

    function test_resize_uses_theme_units() {
      const surface = createTemporaryObject(surfaceComponent, scene, {unit: 1.5, availableWidth: 1600})
      compare(surface.width, 900)
      surface.resizeBy(100)
      compare(surface.width, 1050)
      surface.resizeBy(-2000)
      compare(surface.width, 540)
    }
  }
}
