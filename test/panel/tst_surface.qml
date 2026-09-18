import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Item {
  id: scene
  width: 600
  height: 900
  Component {
    id: surfaceComponent
    Panel.PanelSurface { opened: false; expanded: false }
  }
  TestCase {
    name: "CompanionPanelSurface"
    when: windowShown

    function test_bottom_right_stays_fixed_during_resize_without_resizing_parent() {
      const surface = createTemporaryObject(surfaceComponent, scene)
      compare(surface.x, 600)
      compare(surface.y, 500)
      surface.opened = true
      tryCompare(surface, "reveal", 1)
      compare(surface.x, 180)
      surface.expanded = true
      wait(60)
      verify(surface.width > 420 && surface.width < 600)
      verify(surface.height > 400 && surface.height < 900)
      compare(Math.round(surface.x + surface.width), scene.width)
      compare(Math.round(surface.y + surface.height), scene.height)
      compare(scene.width, 600)
      compare(scene.height, 900)
      tryCompare(surface, "animating", false)
      compare(surface.width, 600)
      compare(surface.height, 900)
      compare(surface.y, 0)
      surface.expanded = false
      tryCompare(surface, "animating", false)
      compare(surface.x, 180)
      compare(surface.y, 500)
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
      surface.expanded = true
      compare(surface.width, 600, "Hidden surfaces adopt their new size immediately")
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
      surface.expanded = true
      compare(surface.width, 320)
      compare(surface.height, 300)
      surface.destroy()
      host.destroy()
    }
  }
}
