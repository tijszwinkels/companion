import QtQuick

// Test stub: records the presentation properties the real button would draw.
Item {
  objectName: "barButton"
  property var bar: null
  property string text: ""
  property bool dimmed: false
  property bool active: false
  property bool useActiveColor: true
  property color foreground: "white"
  property bool pressable: true
  property string tooltipText: ""
  signal pressed(int button)
  implicitWidth: 24
}
