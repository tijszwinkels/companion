import QtQuick
import QtQuick.Controls

// History cards are the Activity page's single scrolling surface. The owner
// supplies the sections above them as `header` and the keyboard help as
// `footer`, so a mouse wheel or touchpad moves the whole page wherever the
// pointer is. An earlier capped inner list inside a page Flickable took every
// wheel event over the cards; the page then only moved over the History heading.
// Cards are still created lazily, so long histories stay cheap to show.
ListView {
  id: root
  property var historyModel: null
  // False when the listener has no history connection (older listener).
  property bool available: false
  // Folding History swaps the cards for a placeholder row (see attachModel):
  // rows stay in the shared state, but no hidden cards are kept alive.
  property bool expanded: true
  property bool historyDeletionAvailable: false
  // False while the listener reports capture storage off (no labeling).
  property bool labelingAvailable: true
  required property var intents
  required property bool online
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  property bool animationsEnabled: true
  signal actionRequested(string action, string id, var value)
  // The number of known rows, including while History is folded.
  readonly property int historyCount: historyModel ? historyModel.count : 0

  // Page coordinates that start at the top of the header. A ListView places
  // its header at a negative origin that also moves while card heights are
  // estimated, so callers use these instead of the raw contentY.
  readonly property real pageY: contentY - originY
  readonly property real maximumPageY: Math.max(0, contentHeight - height)
  function scrollToPageY(value) {
    // Header and card geometry are otherwise updated at the next polish, which
    // would clamp a scroll requested right after a section changed size.
    ensurePolished()
    cancelFlick()
    applyContentY(originY + Math.max(0, Math.min(maximumPageY, value)))
  }
  // Scroll so that an item inside the header (or a card) starts at the top of
  // the viewport. Lays out sections that just folded or unfolded first.
  function scrollToItem(item) {
    if (headerItem)
      headerItem.forceLayout()
    ensurePolished()
    scrollToPageY(item.mapToItem(contentItem, 0, 0).y - originY)
  }

  // Where the reader is, so the view can keep it when content above moves.
  // Header geometry arrives after the list first positions itself and changes
  // when sections fold or intent cards update; card-height estimates move the
  // origin; and a ListView also nudges contentY itself while laying out. So
  // only actual scrolling records the position: wheel, drag or flick, the
  // scroll bar, or scrollToPageY.
  //  - At the top: stay at the top.
  //  - Inside the page sections: keep the section at the viewport top in the
  //    same place on screen, e.g. the heading of a section just folded.
  //  - Among the cards: the ListView already keeps the cards in place.
  property bool readerAtTop: true
  // Header sections in page order, supplied by the owner.
  property var anchorItems: []
  property Item anchorItem: null
  // The anchor's top relative to the viewport top (zero or negative).
  property real anchorOffset: 0
  // True while this view applies a scroll itself. The origin can move during
  // that assignment, before the new position has been noted.
  property bool applyingScroll: false
  function noteReaderPosition() {
    readerAtTop = contentY <= originY + 0.5
    anchorItem = null
    if (readerAtTop || !headerItem || contentY >= originY + headerItem.height)
      return

    for (const item of anchorItems) {
      const top = item.mapToItem(contentItem, 0, 0).y
      if (item.visible && top <= contentY + 0.5) {
        anchorItem = item
        anchorOffset = top - contentY
      }
    }
  }
  function applyContentY(value) {
    applyingScroll = true
    contentY = value
    applyingScroll = false
    noteReaderPosition()
  }
  onMovementEnded: noteReaderPosition()
  onOriginYChanged: {
    if (applyingScroll || moving || verticalBar.pressed)
      return

    if (readerAtTop)
      contentY = originY
    else if (anchorItem)
      keepAnchor()
  }
  // Put the anchor section back at its recorded screen position, as far as
  // the page allows. The recorded position is kept rather than re-noted, so
  // unfolding after a fold that had to clamp returns to the same view.
  function keepAnchor() {
    // The header starts at the origin once the list has laid it out.
    const anchorTop = originY + anchorItem.mapToItem(headerItem, 0, 0).y
    const end = originY + Math.max(0, contentHeight - height)
    applyingScroll = true
    contentY = Math.max(originY, Math.min(end, anchorTop - anchorOffset))
    applyingScroll = false
  }
  function showPageTop() {
    readerAtTop = true
    ensurePolished()
    applyContentY(originY)
  }

  // The list always has at least one row. With none, a ListView moves back to
  // its top whenever the header changes size, for example when listening
  // pauses or intent cards update while the reader looks further down. An empty
  // or folded History therefore shows one placeholder row instead of cards.
  ListModel {
    id: placeholderRows
    ListElement {
      placeholder: true
    }
  }
  // Assigning a model also moves a ListView to its first row, so swap models
  // only when needed and restore the reader's page position straight away.
  function attachModel() {
    const cards = expanded && historyCount > 0
    const wanted = cards ? historyModel : placeholderRows
    if (model === wanted)
      return

    const keptPageY = pageY
    const keptTop = readerAtTop
    const keptAnchor = anchorItem
    // Detach first so neither delegate is ever created for the other's rows.
    model = null
    delegate = cards ? cardDelegate : placeholderDelegate
    model = wanted
    if (keptTop) {
      showPageTop()
    } else if (keptAnchor) {
      ensurePolished()
      anchorItem = keptAnchor
      keepAnchor()
    } else {
      scrollToPageY(keptPageY)
    }
  }
  onExpandedChanged: attachModel()
  onHistoryModelChanged: attachModel()
  onHistoryCountChanged: attachModel()
  Component.onCompleted: attachModel()

  // Same wheel and touchpad steps as the conversation transcript, so the
  // panel scrolls alike everywhere. Qt's default Flickable wheel step depends
  // on frame timing; a reversed notch on this heavier page could barely move.
  property real scrollSpeed: 3
  WheelHandler {
    parent: root
    target: null
    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
    onWheel: event => {
      const pixels = event.pixelDelta.y || event.angleDelta.y / 120 * Qt.styleHints.wheelScrollLines * 24 * root.unit
      if (pixels === 0) {
        event.accepted = false
        return
      }

      root.cancelFlick()
      const beginning = root.originY
      const end = beginning + Math.max(0, root.contentHeight - root.height)
      root.applyContentY(Math.max(beginning, Math.min(end, root.contentY - pixels * root.scrollSpeed)))
      event.accepted = true
    }
  }

  clip: true
  // A ListView otherwise makes its first card current and scrolls to it when
  // rows arrive, hiding the page sections above History.
  currentIndex: -1
  highlightFollowsCurrentItem: false
  spacing: 10 * root.unit
  boundsBehavior: Flickable.StopAtBounds
  ScrollBar.vertical: ScrollBar {
    id: verticalBar
    policy: root.contentHeight > root.height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
    onPressedChanged: {
      if (!pressed)
        root.noteReaderPosition()
    }
  }

  Component {
    id: placeholderDelegate
    Item {
      width: root.width
      height: root.expanded ? Math.max(52 * root.unit, emptyLabel.implicitHeight + 4 * root.unit) : 0
      Text {
        id: emptyLabel
        objectName: "activityHistoryEmpty"
        width: parent.width
        anchors.verticalCenter: parent.verticalCenter
        visible: root.expanded
        text: !root.available ? "Restart Companion to connect session history." : "Completed utterances will appear here.\nThis Companion run"
        textFormat: Text.PlainText
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 12 * root.textScale
        lineHeight: 1.5
        wrapMode: Text.WordWrap
      }
    }
  }
  Component {
    id: cardDelegate
    HistoryCard {
      required property var model
      width: root.width - 8 * root.unit
      entryId: model.entryId
      utterance: model.utterance
      intent: model.intent
      outcome: model.outcome
      observedAt: model.observedAt
      feedback: model.feedback
      actualIntent: model.actualIntent
      cleanedText: model.cleanedText
      cleanupStatus: model.cleanupStatus
      cleanupFallback: model.cleanupFallback
      transcriptSource: model.transcriptSource
      captureStorage: model.captureStorage
      labelingUnavailable: model.labelingUnavailable
      screenshotMissing: model.screenshotMissing
      labelingAvailable: root.labelingAvailable
      intents: root.intents
      online: root.online
      historyDeletionAvailable: root.historyDeletionAvailable
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: root.textScale
      onActionRequested: (action, id, value) => root.actionRequested(action, id, value)
    }
  }
  add: Transition {
    enabled: root.animationsEnabled
    ParallelAnimation {
      NumberAnimation {
        property: "opacity"
        from: 0
        to: 1
        duration: 420
      }
      NumberAnimation {
        property: "x"
        from: 12 * root.unit
        to: 0
        duration: 420
        easing.type: Easing.OutCubic
      }
    }
  }
}
