import QtQuick
import QtTest
import "../../integrations/panel" as Panel

// Portable hosts (stock Quickshell, this plain qmltestrunner) have no
// initialized Qt WebEngine. They must never show the browser entry or load
// PanelBrowser.qml, even when the experimental native-widget marker is set.
// The native window suite covers the browser inside the standalone host.
Item {
  width: 620
  height: 600

  Component {
    id: contentComponent
    Panel.PanelContent {
      width: 620
      height: 600
      online: true
      paused: false
      speaking: false
      processing: 0
      foreground: "white"
      muted: "gray"
      accent: "cyan"
      selection: "#333333"
      fontFamily: "sans-serif"
      sessions: [{id: "one", title: "Synthetic", status: "idle", messages: []}]
      selectedSessionId: "one"
    }
  }

  TestCase {
    name: "PanelBrowserEntry"
    when: windowShown

    function test_portable_host_has_no_browser() {
      for (const nativeWidgets of [false, true]) {
        const panel = createTemporaryObject(contentComponent, parent, {nativeWidgets: nativeWidgets})
        verify(panel !== null)
        const button = findChild(panel, "panelBrowserButton")
        verify(button !== null)
        verify(!button.visible, "no entry without browserAvailable")

        panel.openBrowser()
        verify(!panel.browsing)
        verify(!panel.browserStarted)
        compare(findChild(panel, "panelBrowserLoader").item, null)
        compare(findChild(panel, "panelBrowser"), null)
        verify(findChild(panel, "sessionView").visible, "the chat stays visible")

        // No pin either: there is no page to own or show.
        panel.browserPinOwnerId = "one"
        verify(!panel.browserPinned)
        verify(!panel.browserPinVisible)
        verify(!findChild(panel, "browserPinResize").visible)
        compare(findChild(panel, "panelBrowserLoader").height, findChild(panel, "panelBrowserLoader").parent.contentHeight)
      }
    }

    // A host whose Qt WebEngine lacks the browser's types (Qt 6.8) gets a
    // clear message in place of a blank area, and the rail still returns.
    function test_failed_browser_load_is_reported() {
      const panel = createTemporaryObject(contentComponent, parent,
        {browserAvailable: true, browserSource: Qt.resolvedUrl("missing-panel-browser.qml")})
      ignoreWarning(new RegExp("missing-panel-browser"))
      verify(findChild(panel, "panelBrowserButton").visible)
      panel.openBrowser()
      verify(panel.browsing)
      const message = findChild(panel, "panelBrowserUnavailable")
      tryVerify(function() { return message.visible })
      verify(message.text.indexOf("Qt WebEngine 6.9") >= 0)
      verify(!findChild(panel, "sessionView").visible)
      panel.sessionSelected("one")
      verify(!panel.browsing)
      verify(findChild(panel, "sessionView").visible)

      // An agent's request gets the same truthful answer, and changes nothing.
      let answer = null
      panel.openBrowserFromAgent({requestId: "a", id: "one", url: "https://example.com/"},
        function(result) { answer = result })
      compare(answer.outcome, "unsupported")
      verify(!panel.browsing)
    }

    // companion_browser_open on a portable host: answered, never opened.
    function test_agent_request_without_browser_is_unsupported() {
      const panel = createTemporaryObject(contentComponent, parent, {nativeWidgets: true})
      const answers = []
      panel.openBrowserFromAgent({requestId: "b", id: "one", url: "https://example.com/"},
        function(result) { answers.push(result) })
      compare(answers.length, 1)
      compare(answers[0].outcome, "unsupported")
      verify(!panel.browsing)
      verify(!panel.browserStarted)
      compare(findChild(panel, "panelBrowser"), null)
      // A repeated request id is ignored rather than answered twice.
      panel.openBrowserFromAgent({requestId: "b", id: "one", url: "https://example.com/"},
        function(result) { answers.push(result) })
      compare(answers.length, 1)
    }
  }
}
