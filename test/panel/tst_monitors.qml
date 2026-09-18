import QtQuick
import QtTest
import "../../integrations/omarchy/plugin/MonitorSelection.js" as Monitors

Item {
  QtObject {
    id: first
    property string name: "DP-1"
    property int x: 0
    property int width: 1920
  }

  QtObject {
    id: second
    property string name: "DP-2"
    property int x: 1920
    property int width: 1920
  }

  // Keep the array itself unchanged: geometry notifications from its screen
  // objects must invalidate the binding, including reads inside imported JS.
  property var screens: [first, second]
  readonly property var selectedScreen: Monitors.chooseScreen(screens)

  TestCase {
    name: "CompanionMonitorBindings"
    when: windowShown

    function test_geometry_updates_without_hotplug() {
      compare(selectedScreen, second)
      first.x = 3840
      compare(selectedScreen, first)
      second.width = 6000
      compare(selectedScreen, second)
      second.name = "eDP-1"
      compare(selectedScreen, first)
    }
  }
}
