import QtQuick
import QtTest
import "../../integrations/panel" as Panel
import "../../integrations/panel/Markdown.mjs" as Markdown

Rectangle {
  id: scene
  width: 600
  height: 900
  color: "#161e2b"
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
  function conversation(source, id) {
    return {id: id || "markdown", title: "Markdown", status: "completed", error: "", messages: [
      {id: "answer", kind: "assistant", text: source, input: "", toolName: "", screenshot: false, state: "done"}
    ]}
  }
  TestCase {
    name: "CompanionMarkdown"
    when: windowShown
    function answer(chat) { return findChild(findChild(chat, "bubble-answer"), "messageText") }

    function test_paragraph_spacing_and_prose_code_typography() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation("First paragraph.\n\nSecond paragraph with `inline code`.\n\n```js\nconst hello = '<b>literal</b>';\n  keepIndent();\n```")
      tryVerify(function() { return answer(chat) !== null })
      const text = answer(chat)
      const plain = text.getText(0, text.length)
      verify(plain.includes("<b>literal</b>"))
      verify(plain.includes("  keepIndent();"))
      const first = text.positionToRectangle(0)
      const second = text.positionToRectangle(plain.indexOf("Second"))
      verify(second.y - first.y > first.height + 6, "Paragraphs have space beyond their line height")
      text.select(0, 5)
      compare(text.cursorSelection.font.family, chat.proseFontFamily)
      compare(text.cursorSelection.font.pixelSize, 16)
      const code = plain.indexOf("const hello")
      text.select(code, code + 5)
      compare(text.cursorSelection.font.family, "monospace")
      compare(text.cursorSelection.font.pixelSize, 14)
    }

    function test_markdown_keeps_raw_html_inert_and_links_explicit() {
      const source = '<img src="file:///private.png"><b>literal</b>\n\n[Website](https://example.com) [command](file:///private) ![image label](https://example.com/image.png)'
      const html = Markdown.render(source, 1, "#293a51", "#9fc0f7")
      verify(!html.includes("<img"), "Markdown images and HTML do not fetch resources")
      verify(html.includes('href="https://example.com"'))
      verify(!html.includes('href="file:'))
      verify(!Markdown.render('[bad](javascript:alert(1))', 1, "#293a51", "#9fc0f7").includes('href="javascript:'))
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation(source)
      tryVerify(function() { return answer(chat) !== null })
      const text = answer(chat)
      verify(text.getText(0, text.length).includes('<b>literal</b>'))
      verify(text.getText(0, text.length).includes('image label'))
    }

    function test_streamed_fences_lists_tables_and_escaped_syntax() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation("## Heading\n\n```ts\nconst value = 1;")
      tryVerify(function() { return answer(chat) !== null })
      const text = answer(chat)
      verify(text.getText(0, text.length).includes("const value = 1;"))
      chat.session = conversation("## Heading\n\n```ts\nconst value = 1;\n```\n\nAfter **code**.\n\n- First\n  - Nested\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n\\*literal\\*\n\n&copy; &mdash; &NotEqualTilde; &eacute;")
      compare(answer(chat), text, "Streaming keeps the same selectable text item")
      const plain = text.getText(0, text.length)
      for (const expected of ["Heading", "const value = 1;", "After code.", "Nested", "Key", "Value", "*literal*", "©", "—", "≂̸", "é"]) {
        verify(plain.includes(expected), expected)
      }
    }

    function test_zoom_shortcuts_preserve_draft_and_follow_the_reader_between_tabs() {
      const chat = createTemporaryObject(chatComponent, scene)
      chat.session = conversation("A readable answer.")
      const composer = findChild(chat, "sessionComposer")
      composer.text = "Keep this draft"
      chat.focusComposer()
      tryCompare(composer, "activeFocus", true)
      keyClick(Qt.Key_Plus, Qt.ControlModifier)
      compare(chat.zoomPercent, 110)
      keyClick(Qt.Key_Equal, Qt.ControlModifier)
      compare(chat.zoomPercent, 120)
      keyClick(Qt.Key_Plus, Qt.ControlModifier | Qt.ShiftModifier)
      compare(chat.zoomPercent, 130)
      keyClick(Qt.Key_Minus, Qt.ControlModifier)
      compare(chat.zoomPercent, 120)
      keyClick(Qt.Key_Minus, Qt.ControlModifier)
      compare(chat.zoomPercent, 110)
      compare(composer.text, "Keep this draft")
      compare(answer(chat).font.pixelSize, 18)
      chat.session = conversation("Another conversation", "second")
      compare(chat.zoomPercent, 110)
      chat.focusComposer()
      keyClick(Qt.Key_0, Qt.ControlModifier)
      compare(chat.zoomPercent, 100)
      for (let index = 0; index < 15; index++) keyClick(Qt.Key_Minus, Qt.ControlModifier)
      compare(chat.zoomPercent, 80)
      for (let index = 0; index < 20; index++) keyClick(Qt.Key_Plus, Qt.ControlModifier)
      compare(chat.zoomPercent, 200)
      chat.visible = false
      keyClick(Qt.Key_0, Qt.ControlModifier)
      compare(chat.zoomPercent, 200, "Hidden chats do not take zoom keys")
    }

    function test_zoomed_code_wraps_without_changing_its_text() {
      const chat = createTemporaryObject(chatComponent, scene, {zoomPercent: 200})
      const code = "const longValue = '" + "abcde".repeat(45) + "';"
      chat.session = conversation("```ts\n" + code + "\n```")
      tryVerify(function() { return answer(chat) !== null })
      const text = answer(chat)
      verify(text.getText(0, text.length).includes(code))
      verify(text.contentWidth <= text.width + 2, "Large code stays within the readable viewport")
    }

    function test_markdown_visual_preview() {
      const chat = createTemporaryObject(chatComponent, scene, {x: 20, y: 20, width: 560})
      chat.session = conversation("## A little more breathing room\n\nNormal answers use **Adwaita Sans**, with a comfortable reading size and space between paragraphs. Inline `code` stays distinct.\n\n```ts\nconst reply = await agent.ask(question);\nconsole.log(reply.text);\n```\n\nCode gets its own shaded frame. Lists also have room to breathe:\n\n- Clearer hierarchy\n- Selectable, streaming Markdown\n\n> Keep the reading experience calm.\n\n[Open the documentation](https://example.com)")
      wait(150)
      grabImage(scene).save("/tmp/companion-markdown-preview.png")
    }
  }
}
