import QtQuick
import QtTest
import "../../integrations/panel/PanelBrowserPolicy.mjs" as Policy

// Address rules of the in-panel browser, without a WebEngine host. The native
// window suite separately proves that PanelBrowser applies these decisions to
// real Chromium navigations, including server redirects.
TestCase {
  name: "PanelBrowserPolicy"

  function test_typed_addresses() {
    const cases = [
      // QML's URL keeps an empty path; Chromium adds "/" when it loads.
      ["example.com", "https://example.com"],
      ["  example.com/path?q=1#top ", "https://example.com/path?q=1#top"],
      ["https://Example.COM", "https://example.com"],
      ["localhost:5173", "http://localhost:5173"],
      ["127.0.0.1:8080/app", "http://127.0.0.1:8080/app"],
      ["127.1:8080", "http://127.0.0.1:8080"],
      ["app.localhost:3000", "http://app.localhost:3000"],
      ["[::1]:9000/", "http://[::1]:9000/"],
      ["http://127.0.0.1:4000/x", "http://127.0.0.1:4000/x"],
      ["https://localhost:8443/", "https://localhost:8443/"],
      ["example.com:8443", "https://example.com:8443"],
    ]
    for (const [input, expected] of cases) {
      const result = Policy.addressFromInput(input)
      compare(result.error, "", input)
      compare(result.url, expected, input)
    }
  }

  function test_refused_typed_addresses() {
    const cases = [
      ["", "Enter a web address."],
      ["   ", "Enter a web address."],
      ["two words", "cannot contain spaces"],
      ["http://example.com", "only opened for this computer"],
      ["file:///etc/passwd", "does not open file:"],
      ["companion-widget://view/document", "does not open companion-widget:"],
      ["javascript:alert(1)", "does not open javascript:"],
      ["data:text/html,hi", "does not open data:"],
      ["mailto:someone@example.com", "does not open mailto:"],
      ["chrome://settings", "does not open chrome:"],
      ["view-source:https://example.com", "does not open view-source:"],
      ["about:settings", "does not open about:"],
      ["blob:https://example.com/abc", "does not open blob:"],
      ["https://", "not a valid web address"],
    ]
    for (const [input, expected] of cases) {
      const result = Policy.addressFromInput(input)
      compare(result.url, "", input)
      verify(result.error.indexOf(expected) >= 0, input + " -> " + result.error)
    }
  }

  function test_main_frame_decisions() {
    verify(Policy.mainFrameDecision("about:blank").allowed)
    verify(Policy.mainFrameDecision("https://accounts.example/login").allowed)
    verify(Policy.mainFrameDecision("http://127.0.0.1:1234/").allowed)
    verify(Policy.mainFrameDecision("http://127.9.8.7/").allowed)
    verify(Policy.mainFrameDecision("http://localhost/").allowed)
    verify(Policy.mainFrameDecision("http://[::1]/").allowed)
    for (const blocked of ["http://example.com/", "http://127.0.0.1.example.com/",
      "http://localhost.example.com/", "http://10.0.0.1/", "http://[::2]/", "file:///tmp/x",
      "companion-widget://view/document", "qrc:/panel.qml", "ftp://example.com/",
      "ws://127.0.0.1/", "chrome-error://chromewebdata/", "", "not a url"]) {
      verify(!Policy.mainFrameDecision(blocked).allowed, blocked)
      verify(Policy.mainFrameDecision(blocked).reason !== "", blocked)
    }
  }

  function test_display_host() {
    compare(Policy.displayHost("https://www.example.com/a/b?c"), "www.example.com")
    compare(Policy.displayHost("http://127.0.0.1:8123/"), "127.0.0.1:8123")
    compare(Policy.displayHost("http://[::1]:8123/"), "::1:8123")
    compare(Policy.displayHost("http://localhost:80/"), "localhost")
    compare(Policy.displayHost("https://example.com:443/"), "example.com")
    compare(Policy.displayHost("about:blank"), "")
    compare(Policy.displayHost("file:///tmp"), "")
    compare(Policy.displayHost(""), "")
  }
}
