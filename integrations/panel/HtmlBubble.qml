import QtQuick
import "Html.mjs" as Html

// The source is validated here again, including for socket snapshots. A hidden
// layout probe measures only sanitized rich text. Oversized visuals fall back
// to wrapping text rather than clipping content or nesting a scroll area.
TextEdit {
  id: root
  required property string source
  required property string fallback
  required property color muted
  required property color accent
  required property color themeSelection
  property real textScale: 1
  property bool showText: false
  readonly property string markup: {
    try {
      return Html.renderHtml(source, textScale, color.toString(), muted.toString(), accent.toString(), themeSelection.toString())
    } catch (error) {
      return ""
    }
  }
  readonly property bool fits: markup !== "" && probe.contentWidth <= width + 1
    && probe.contentHeight <= 480 * textScale
  readonly property bool showingGraphic: fits && !showText
  // Keep the format stable while switching views. Changing format and text
  // together can transiently interpret the fallback as HTML in QTextDocument.
  text: showingGraphic ? markup : "<p>" + Html.escapeText(fallback).replace(/\n/g, "<br>") + "</p>"
  textFormat: TextEdit.RichText
  height: contentHeight
  readOnly: true
  selectByMouse: true
  activeFocusOnPress: false
  wrapMode: TextEdit.Wrap
  clip: true
  Accessible.name: fallback

  TextEdit {
    id: probe
    visible: false
    width: root.width
    text: root.markup
    textFormat: TextEdit.RichText
    font: root.font
    wrapMode: TextEdit.Wrap
    readOnly: true
  }
}
