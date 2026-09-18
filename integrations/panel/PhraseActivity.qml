import QtQuick

// Animates the newest transcribed phrase using the portable desktop snapshot.
// Repeated socket snapshots update the same phrase, rather than restarting its
// animation. Opening/reconnecting adopts in-flight work but skips old results.
Item {
  id: root

  property var history: []
  property bool active: false
  required property color muted
  required property color accent
  required property string fontFamily
  required property real unit

  // Exposed timings also let headless tests exercise the complete lifecycle.
  property int riseDuration: 360
  property int resultHoldDuration: 1400
  property int fadeDuration: 1000

  property bool initialized: false
  property bool componentReady: false
  property string lastSeenId: ""
  property string utteranceId: ""
  property string phrase: ""
  property string intent: ""
  property string outcome: "processing"
  property bool arrived: false
  property bool showingResult: false
  property bool presenting: false
  property real lift: 0
  property real visibility: 0

  readonly property bool completed: outcome !== "processing" && outcome !== "delivering"
  readonly property bool failed: outcome === "error" || outcome === "skipped"
    || outcome === "cancelled" || outcome === "interrupted"

  // Recognition can succeed even when delivery fails or is skipped after a
  // focus change. Keep the detected intent, but make that outcome explicit.
  // Preview also needs a label because it deliberately sends no keyboard input.
  readonly property string resultLabel: (failed || outcome === "preview")
    ? outcome.toUpperCase() + (intent ? " · " + intent : "")
    : intent || outcome.toUpperCase()
  readonly property string label: showingResult ? resultLabel : "PROCESSING"
  readonly property color phraseColor: !showingResult ? "#66bb6a"
    : failed ? "#ef5350"
    : intent === "SEND_TEXT_TO_APPLICATION" ? "#82aaff"
    : intent === "ENTER_TEXT_TO_APPLICATION" ? "#c792ea"
    : intent === "IGNORE" ? muted
    : intent ? accent : muted

  function reset() {
    rise.stop()
    finish.stop()
    root.initialized = false
    root.lastSeenId = ""
    root.utteranceId = ""
    root.presenting = false
    root.showingResult = false
    root.arrived = false
    root.visibility = 0
    root.lift = 0
  }

  function finishWhenReady() {
    // Very fast prefix routing can finish before the first rendered frame.
    // Always finish the rise before replacing PROCESSING with the intent.
    if (root.presenting && root.arrived && root.completed && !root.showingResult) {
      root.showingResult = true
      finish.start()
    }
  }

  function synchronize() {
    if (!root.componentReady || !root.active || root.history.length === 0) {
      return
    }

    const latest = root.history[0]
    const firstSnapshot = !root.initialized
    const unseen = latest.id !== root.lastSeenId
    root.initialized = true
    root.lastSeenId = latest.id

    if (!latest.utterance) {
      return
    }

    if (latest.id !== root.utteranceId) {
      const pending = latest.outcome === "processing" || latest.outcome === "delivering"

      if (!unseen || (firstSnapshot && !pending)) {
        return
      }

      // A newer phrase supersedes a fading result. Stop both animations before
      // reusing the card so an old timer cannot hide the new phrase.
      rise.stop()
      finish.stop()
      root.utteranceId = latest.id
      root.phrase = latest.utterance
      root.intent = latest.intent || ""
      root.outcome = latest.outcome
      root.showingResult = false
      root.arrived = false
      root.presenting = true
      root.visibility = 0
      root.lift = 0
      rise.start()
      return
    }

    root.intent = latest.intent || ""
    root.outcome = latest.outcome
    root.finishWhenReady()
  }

  onHistoryChanged: synchronize()
  onActiveChanged: {
    if (root.componentReady) {
      root.reset()
      root.synchronize()
    }
  }
  Component.onCompleted: {
    root.componentReady = true
    root.synchronize()
  }

  SequentialAnimation {
    id: rise

    ParallelAnimation {
      NumberAnimation {
        target: root
        property: "lift"
        from: 0
        to: 1
        duration: root.riseDuration
        easing.type: Easing.OutCubic
      }
      NumberAnimation {
        target: root
        property: "visibility"
        from: 0
        to: 1
        duration: root.riseDuration
      }
    }

    ScriptAction {
      script: {
        root.arrived = true
        root.finishWhenReady()
      }
    }
  }

  SequentialAnimation {
    id: finish
    PauseAnimation { duration: root.resultHoldDuration }
    NumberAnimation {
      target: root
      property: "visibility"
      to: 0
      duration: root.fadeDuration
      easing.type: Easing.InOutQuad
    }
    ScriptAction { script: root.presenting = false }
  }

  Column {
    id: card
    objectName: "phraseCard"
    width: parent.width
    spacing: 8 * root.unit
    visible: root.presenting
    opacity: root.visibility

    // Begin at the microphone's center, then rise until the entire card clears
    // it. Long phrases wrap and elide within the available upper half-panel.
    readonly property real destinationY: Math.max(0, root.height - height - 48 * root.unit)
    y: root.height + root.lift * (destinationY - root.height)

    Text {
      objectName: "phraseLabel"
      width: parent.width
      text: root.label
      textFormat: Text.PlainText
      horizontalAlignment: root.showingResult ? Text.AlignRight : Text.AlignLeft
      wrapMode: Text.WrapAnywhere
      color: root.phraseColor
      font.family: root.fontFamily
      font.pixelSize: 9 * root.unit
      Accessible.ignored: true
    }

    Text {
      objectName: "phraseText"
      width: parent.width
      text: root.phrase
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      maximumLineCount: Math.max(1, Math.floor((root.height - 80 * root.unit) / (22 * root.unit)))
      elide: Text.ElideRight
      color: root.phraseColor
      font.family: root.fontFamily
      font.pixelSize: 17 * root.unit
      lineHeightMode: Text.FixedHeight
      lineHeight: 22 * root.unit
      Accessible.ignored: true
    }

    Accessible.role: Accessible.StaticText
    Accessible.name: root.label + ": " + root.phrase
  }
}
