import QtQuick
import QtTest
import "../../integrations/panel" as Panel

Rectangle {
  id: scene
  width: 600
  height: 900
  color: "#161e2b"
  TextEdit { id: clipboardReader; visible: false; textFormat: TextEdit.PlainText }
  Component { id: stateComponent; Panel.AgentSessionState {} }
  Component {
    id: chatComponent
    Panel.SessionView {
      width: 540
      height: 850
      foreground: "#dce5ef"
      muted: "#8ba0b8"
      accent: "#9fc0f7"
      selection: "#293a51"
      fontFamily: "monospace"
      session: null
    }
  }
  readonly property string diagram: '<p><b>A small processing pipeline</b></p><table width="100%" cellpadding="8" cellspacing="3"><tr><td style="background-color: var(--selection)">Input</td><td align="center" style="color: var(--accent)">→</td><td style="background-color: var(--selection)">Result</td></tr></table><p style="color: var(--muted)">Each stage keeps its own responsibility.</p>'
  readonly property string fallback: "Input leads to Result. Each stage keeps its own responsibility."

  function conversation(html, text) {
    return {id: "html", title: "Small graphic", status: "completed", error: "", messages: [
      {id: "visual", kind: "assistant", text: text || fallback, html: html, input: "", toolName: "", screenshot: false, state: "done"}
    ]}
  }
  TestCase {
    name: "CompanionHtml"
    when: windowShown
    function graphic(chat) { return findChild(chat, "htmlMessageText") }
    function clipboardText() {
      clipboardReader.text = ""
      clipboardReader.paste()
      return clipboardReader.text
    }

    function test_native_graphic_layout_theme_zoom_selection_and_copy() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation(scene.diagram)
      tryVerify(function() { return graphic(chat) !== null })
      const visual = graphic(chat)
      tryCompare(visual, "showingGraphic", true)
      const plain = visual.getText(0, visual.length)
      verify(plain.includes("Input"))
      verify(plain.includes("→"))
      verify(plain.includes("Result"))
      const input = visual.positionToRectangle(plain.indexOf("Input"))
      const result = visual.positionToRectangle(plain.indexOf("Result"))
      verify(result.x > input.x + 80, "Actual Qt layout places nodes in separate columns")
      compare(result.y, input.y)
      verify(visual.height < 300)
      verify(visual.contentWidth <= visual.width + 1)
      const oldHeight = visual.height
      chat.zoomPercent = 150
      tryVerify(function() { return visual.height > oldHeight })
      compare(visual.showingGraphic, true)
      verify(visual.markup.includes('cellpadding="12"'))
      chat.selection = "#e6edf5"
      chat.accent = "#245fa8"
      chat.foreground = "#182330"
      tryVerify(function() { return visual.markup.includes("#e6edf5") })
      verify(visual.markup.includes("#245fa8"))
      chat.focusComposer()
      const composer = findChild(chat, "sessionComposer")
      composer.text = "Keep my draft"
      const selectionIndex = visual.getText(0, visual.length).indexOf("Input")
      visual.select(selectionIndex, selectionIndex + 5)
      keyClick(Qt.Key_C, Qt.ControlModifier)
      compare(clipboardText(), "Input")
      compare(composer.activeFocus, true)
      compare(composer.text, "Keep my draft")
      const copy = findChild(chat, "copyMessage")
      copy.activate()
      compare(clipboardText(), scene.fallback)
      compare(visual.selectedText, "Input")
      const toggle = findChild(chat, "toggleHtmlText")
      mouseClick(toggle, toggle.width / 2, toggle.height / 2)
      compare(visual.showingGraphic, false)
      compare(visual.getText(0, visual.length), scene.fallback)
      compare(composer.activeFocus, true)
      compare(composer.text, "Keep my draft")
    }

    function test_invalid_html_and_oversized_layouts_use_literal_fallback() {
      const chat = createTemporaryObject(chatComponent, scene)
      const literal = '<img src="file:///private"> fallback stays literal'
      chat.session = conversation('<img src="https://example.invalid/forbidden">', literal)
      tryVerify(function() { return graphic(chat) !== null })
      const visual = graphic(chat)
      compare(visual.markup, "")
      compare(visual.showingGraphic, false)
      compare(visual.textFormat, TextEdit.RichText)
      compare(visual.getText(0, visual.length), literal)
      chat.session = conversation('<p>' + '<br>'.repeat(100) + '</p>')
      tryCompare(visual, "fits", false)
      compare(visual.getText(0, visual.length), scene.fallback)
      verify(visual.height < 200)
      // Tables with long unbreakable cell labels may exceed the available width.
      chat.width = 220
      chat.session = conversation('<table><tr><td>' + 'W'.repeat(300) + '</td><td>Result</td></tr></table>')
      tryCompare(visual, "fits", false)
      compare(visual.getText(0, visual.length), scene.fallback)
      verify(visual.contentWidth <= visual.width + 1)
    }

    function test_streaming_preserves_visual_scroll_focus_and_selection() {
      const chat = createTemporaryObject(chatComponent, scene)
      const session = conversation(scene.diagram)
      session.messages.push({id: "text", kind: "assistant", text: "A long explanation.\n\n".repeat(80), input: "", toolName: "", screenshot: false, state: "running"})
      chat.session = session
      const transcript = findChild(chat, "sessionTranscript")
      tryVerify(function() { return transcript.contentHeight > transcript.height })
      chat.followEnd = false
      transcript.positionViewAtBeginning()
      tryVerify(function() { return graphic(chat) !== null })
      const visual = graphic(chat)
      visual.select(0, 7)
      chat.focusComposer()
      const composer = findChild(chat, "sessionComposer")
      composer.text = "Unsent follow-up"
      mouseWheel(transcript, 100, 100, 0, -120, Qt.NoModifier)
      const position = transcript.contentY
      const selected = visual.selectedText
      session.messages[1].text += "More answer.\n\n"
      chat.session = JSON.parse(JSON.stringify(session))
      wait(30)
      compare(graphic(chat), visual)
      compare(visual.selectedText, selected)
      compare(transcript.contentY, position)
      compare(composer.activeFocus, true)
      compare(composer.text, "Unsent follow-up")
    }

    function test_completed_tool_row_reconnect_and_restore_keep_the_graphic_and_draft() {
      const state = createTemporaryObject(stateComponent, scene)
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = Qt.binding(function() { return state.sessions.length ? state.sessions[0] : null })
      const pending = conversation("")
      pending.status = "running"
      pending.messages[0].kind = "tool"
      pending.messages[0].state = "running"
      pending.messages[0].toolName = "companion_html"
      state.update(pending)
      tryVerify(function() { return findChild(chat, "bubble-visual") !== null })
      const row = findChild(chat, "bubble-visual")
      chat.focusComposer()
      const composer = findChild(chat, "sessionComposer")
      composer.text = "My queued follow-up"
      const completed = conversation(scene.diagram)
      state.update(completed)
      tryVerify(function() { return graphic(chat) !== null && graphic(chat).showingGraphic })
      compare(findChild(chat, "bubble-visual"), row, "Publication replaces the same tool row")
      compare(chat.messageCount, 1)
      compare(composer.activeFocus, true)
      compare(composer.text, "My queued follow-up")
      state.replace([JSON.parse(JSON.stringify(completed))])
      compare(graphic(chat).showingGraphic, true)
      compare(composer.text, "My queued follow-up")
      state.remove("html")
      compare(chat.messageCount, 0)
      state.restore(JSON.parse(JSON.stringify(completed)))
      tryVerify(function() { return graphic(chat) !== null && graphic(chat).showingGraphic })
      compare(chat.messageCount, 1)
      compare(composer.text, "My queued follow-up")
    }

    function test_diagram_and_comparison_preview() {
      const chat = createTemporaryObject(chatComponent, scene)
      const session = conversation(scene.diagram)
      session.messages.push({id: "compare", kind: "assistant", text: "Cache is fast but uses memory. Recompute saves memory but takes more time.",
        html: '<p><b>Two ways to get a result</b></p><table width="100%" cellpadding="8" cellspacing="3"><tr><th>Cache</th><th>Recompute</th></tr><tr><td style="background-color: var(--selection)"><b style="color: var(--accent)">Fast lookup</b><br>Uses memory</td><td style="background-color: var(--selection)"><b style="color: var(--accent)">Less memory</b><br>More work each time</td></tr></table>',
        input: "", toolName: "", screenshot: false, state: "done"})
      chat.session = session
      tryVerify(function() { return graphic(chat) !== null && graphic(chat).showingGraphic })
      wait(40)
      const snapshot = grabImage(chat)
      snapshot.save('/tmp/companion-html-bubbles.png')
      // Verify pixels from a real rendered card, not merely generated markup.
      let cardPixels = 0
      for (let y = 40; y < 200; y += 2) {
        for (let x = 20; x < 450; x += 2) {
          if (snapshot.pixel(x, y).toString() === '#293a51') cardPixels++
        }
      }
      verify(cardPixels > 300, "The native renderer paints card backgrounds")
    }
  }
}
