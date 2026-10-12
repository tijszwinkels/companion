import QtQuick

// Test stub: keeps its content instantiated so the popup's toggles can be checked.
Item {
  property var anchorItem: null
  property var bar: null
  property var owner: null
  property bool open: false
  property real contentWidth: 0
  property real contentHeight: 0
  function fittedContentWidth(width) { return width }
  function fittedContentHeight(height) { return height }
}
