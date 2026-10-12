import QtQuick

// Test stub for the shell's labelled switch.
Item {
  property string label: ""
  property string description: ""
  property bool checked: false
  signal clicked()
  implicitHeight: 20
}
