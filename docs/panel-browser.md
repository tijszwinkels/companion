# Panel browser

A minimal web browser inside the native Companion panel. It shows one
ordinary web page in place of the chat and returns to the same conversation,
drafts, pins and widgets afterwards. It is a desktop proof of concept: no
agent tool, backend protocol, app registry or phone route opens or controls it.

Source: `integrations/panel/PanelBrowser.qml` (view, profile, controls) and
`integrations/panel/PanelBrowserPolicy.mjs` (address rules). Only the native
Qt host loads it; the portable Quickshell panel never does. It needs Qt
WebEngine **6.9 or newer** (`WebEngineProfilePrototype`), while the rest of the
native UI still builds with 6.8. With an older Qt, opening the browser shows
a message saying so instead of a page; the rail returns as usual.

## Using it

- **Open:** the small **Browser** control in the panel header. The first time,
  the address field has focus. Type an address and press Enter. Bare names
  get `https://`; `localhost:5173` or `127.0.0.1:8080` get `http://`. There is
  no search engine; text with spaces is rejected.
- **Controls are hidden by default.** A slim strip above the page always shows
  the site, “(local, not encrypted)” for loopback HTTP, the loading state, a
  load error and the latest notice. Hover the strip or click it, or press
  **Ctrl+L**, to reveal Back, Forward, Reload/Stop, the address field, **Chat**
  and **Close**. The toolbar stays while the pointer is over it or while one of
  its controls has keyboard focus, and hides shortly after both end. An address
  you are editing is never replaced by page navigation; Escape reverts it and
  returns focus to the page.
- **Chat** returns to the conversation and keeps the page. While hidden the
  page is frozen (scripts and timers stop) and muted; opening the browser
  again resumes it. Selecting a conversation, Activity or Previous sessions in
  the rail, and the focus-input shortcut, do the same. **Hiding the whole
  Companion panel (×, the toggle shortcut) does not freeze or mute the page**;
  it keeps running as it would in a hidden browser window.
- While browsing, a conversation closed in the background (by an agent,
  another surface or a reconnect) does not move keyboard focus: typing stays
  in the page or the address field.
- **Close** unloads the page and returns to chat. The address stays in the
  field for reopening; cookies and site data stay in the profile.

## Profile and storage

One named, persistent Qt WebEngine profile, `companion-panel-browser`, serves
the whole panel browser. It is created on first use and lives as long as the
UI process. Redirects and logins do not change it. It is separate from:

- the restricted, off-the-record widget profile (`WidgetProfile`), which is
  unchanged;
- the user's own browser, and the Chromium profiles that local apps use under
  `~/companion/apps`. Signing in to one does not sign in the others;
- Qt's default profile.

Chromium stores it under Qt's application data and cache locations, with the
directories created as mode 0700 (checked by the tests). The native UI sets
organisation and application name `Companion`, so by Qt's documented default
these are `~/.local/share/Companion/Companion/QtWebEngine/companion-panel-browser`
and `~/.cache/Companion/Companion/QtWebEngine/companion-panel-browser`; the
tests observe the equivalent paths of their own runner, not a live UI. To sign
out of everything, stop the UI and delete both directories. Cookies follow
normal site expiry; sites may still ask you to sign in again.

The page gets no user scripts, WebChannel, native objects, files or
credentials from Companion. The Chromium sandbox, same-origin policy and TLS
checks are the normal ones; the UI still refuses to start with the sandbox or
web security disabled.

## What is refused

The page's top-level frame may show `https:` on any host, `http:` only on
loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), and `about:blank`.
The check runs for typed addresses, links, form posts and server redirects.
Everything else (`file:`, `data:`, `blob:`, `javascript:`,
`companion-widget:`, `chrome:`, `view-source:`, `mailto:` and other external
schemes) is refused, and no external handler is launched. Typed addresses get
a notice, and so do server redirects to a refused web address (for example
public `http:`) or to `companion-widget:`. Chromium decides first for other
attempts:

- some page-initiated ones (e.g. `companion-widget:`) end on Chromium's inert
  `about:blank#blocked` page, which also shows a notice;
- page-initiated `file:`, `mailto:` and unknown-scheme links, and server
  redirects to `mailto:` and similar non-web schemes, are dropped by Chromium
  before Companion is told. The page simply stays where it was, **without a
  notice** (as in Chromium itself, apart from a console message).

Subresources and frames follow Chromium's normal rules.

Each of these is declined, with a notice in the strip:

| Request                                                                              | Behaviour                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| New windows, tabs, pop-ups, `target=_blank`                                          | Refused; nothing opens elsewhere or replaces the page. |
| Downloads                                                                            | Cancelled; no file is written.                         |
| Camera, microphone, screen sharing, location, notifications, clipboard, pointer lock | Denied every time; decisions are never stored.         |
| File picker, colour picker, HTTP sign-in prompt, passkeys/security keys, printing    | Declined.                                              |
| Invalid TLS certificate                                                              | Refused; there is no bypass.                           |
| Context menu, fullscreen                                                             | Not shown (keyboard copy and paste still work).        |

**Script dialogs are ordinary page features.** `alert()`, `confirm()`,
`prompt()` and the leave-page question appear in a small dialog over the page,
headed with the page's own host name (“example.com says”) and its message as
plain text. The page waits for the user's answer: OK/Cancel, the typed prompt
answer, or Stay/Leave. Enter answers OK and Escape answers Cancel. The dialog
takes keyboard focus only if the page had it, and returns focus to the page
afterwards. The toolbar stays usable above it, so Ctrl+L, Chat and Close still
work. Close, a navigation to another page and a renderer crash decline a
pending dialog. Chromium asks the leave-page question only after the user has
interacted with the page.

Unsupported pop-ups can break sign-in flows that depend on them, attachment
viewers, print and compose links. Some identity providers refuse embedded
browsers altogether; Google sign-in in particular is not promised to work.
Nothing spoofs the user agent or copies credentials to work around this.

## Opening a page from an agent

An agent can show a page without the user clicking **Browser** or typing an
address: `companion_browser_open({url})`, available to Pi and Claude Code
conversations through their turn's session tool lease (see the
[agent contracts](../src/agents/README.md#session-lifecycle-tools)). It only
presents the page. The agent cannot read, click, type in or screenshot it, and
nothing from the page is returned except the address it ends on (no content,
not even its title).

- **Addresses:** absolute `https://` URLs, or `http://` on loopback, at most
  2048 characters. The service checks the address, the panel checks it again,
  and every navigation and redirect still follows the rules above.
- **Who may open:** only a conversation's own running turn, only while the
  Companion panel is showing, and only while that conversation is the one
  selected in it (Previous sessions or Activity
  do not count). A background, closed or finished conversation, an external
  CLI caller or a phone panel cannot change what the user sees.
- **The user comes first:** while they are typing in the address field or a
  page dialog awaits their answer, the request is refused as `busy`. An address
  they edited but left stays in the field; the strip shows the real site.
- **Presentation:** the browser replaces the chat as if **Browser** had been
  clicked, with the controls hidden and the address field not focused. A hidden
  (frozen) page is reused and woken. A hidden window is never shown or
  activated: the request is refused as `panel-hidden` and nothing changes, so a
  page the user cannot see is never reported as opened. In
  an already focused window, keyboard focus moves to the page instead of the
  hidden composer. Drafts, pins and widgets are kept as usual.
- **Answer:** the panel reports once, after the page loaded (`loaded` with its
  address) or failed (`load-failed` with the load error, certificate or policy
  notice), or after about 8 seconds (`loading`). A newer request, or the user's
  own navigation or Close, answers `superseded`. Confirmed non-changes are
  `panel-hidden`, `not-selected`, `busy`,
  `unsupported` (no native browser, or Qt WebEngine older than 6.9) and
  `refused`. `offline` means no panel is connected. `unconfirmed` means the
  panel did not answer within 15 seconds or disconnected; the agent is told not
  to retry.
- **No replay:** each call is one `agent-browser-open` event to one native
  window. It is not stored in snapshots or re-sent on reconnect, and a repeated
  delivery of the same tool call returns the original reply without asking the
  panel again. A new call may navigate again. The calls count toward the turn's
  six session actions.

Protocol (listener ↔ native window, desktop-only): the window reports
`browserHost: true` in `panel-state`. The listener sends
`{type: "agent-browser-open", requestId, id, url}` to exactly one such window,
and only that window may answer
`{action: "agent-browser-open-result", requestId, outcome, reason, url?}`;
any other field (such as page text) is dropped.
A late, foreign, malformed or remote answer is refused.

## Tests

- `test/panel/tst_panel_browser_policy.qml` (plain `qmltestrunner`): typed
  address normalisation and the top-level URL rules.
- `test/window/panel-browser.test.ts` (in `npm run test:window`): the real
  component against loopback HTTP/HTTPS fixtures in offscreen Qt. It covers
  typed addresses, links, same-origin subresources, redirects, Back/Forward,
  Reload, refused redirects and page-initiated navigations, pop-up refusal
  (script and real click), permissions, the file picker and download refusal,
  an untrusted certificate, pointer and Ctrl+L reveal, retained address edits,
  reparenting, Close and recreation. Script dialogs are answered with real
  clicks and keys (OK, Escape, typed prompt answer, Cancel, Stay/Leave); a
  pending dialog lapses on navigation and is declined by Close. Chat and Close
  are reached from page focus by keyboard alone, also while a dialog is open.
  A hidden page is frozen: JavaScript timers stop and a playing (muted) audio
  element's position does not advance until it is shown again. Recording
  stubs for `xdg-open`, `gio` and similar handlers come first in `PATH`; real
  clicks on `mailto:` and custom-scheme links and a redirect to `mailto:` must
  leave them unused (the test environment has no D-Bus portal). A
  second runner process with the same temporary home proves that cookies and
  local storage persist on disk, and that a default-profile view does not see
  them. The storage directories are checked to be 0700.
- The same file's second test drives the real standalone window body
  (`test/window/panel-browser-host.qml.in`) with a synthetic backend and a
  real pinned native widget. Opening the browser hides the chat, pin and model
  footer and clears the voice target; the page, draft, pinned widget document
  and selection survive Window/Sidebar/Dock moves (ordinary offscreen surfaces),
  hide/show and agent updates. Chat, the rail, Alt+1 and the focus command
  return; the page is then frozen and resumes on reopening; Close unloads it.
  A snapshot that removes the selected conversation leaves keyboard focus in
  the address field or the page.
  The widget keeps its separate off-the-record profile.
- `test/unit/browser-open-tool.test.ts` (in `npm test`): identical Pi and
  Claude schemas, and the real lease, service and desktop socket with a
  synthetic panel. It covers address checks before any panel is asked, loopback
  http, panels without a browser, answers only from the asked panel, late,
  foreign and malformed answers, receipts, the action budget, withdrawal,
  disconnect, reconnect without replay, remote panels, external callers and
  ended turns.
- `test/window/browser-open-tool.test.ts` (in `npm run test:window`):
  - The real window body receives requests and answers them: background and
    unknown callers, controls hidden and chat retained, reuse of a frozen page,
    busy while typing or during a page dialog, an edited address kept, refusals,
    connection and redirect failures, the bounded wait, supersession, a hidden
    window refused as `panel-hidden` without showing it or navigating, and
    ignored repeats.
  - End to end, a real tool call runs through the lease, the listener and the
    real `companion-ui` executable. The selected conversation loads a loopback
    page, a background conversation is refused, and with the window hidden the
    call fails as `panel-hidden` without any page request.
- `test/panel/tst_panel_browser_entry.qml`: a portable host never shows the
  entry or loads the browser, even with the native-widget marker set; a
  browser that fails to load (as on Qt 6.8) shows the version message.

These use offscreen software rendering, synthetic pages and temporary
profiles. They do not establish live Wayland hover or focus, GPU behaviour,
Sidebar/Dock layer-shell behaviour, audible playback, behaviour on an actual
Qt 6.8 installation, dialog handling during a real renderer crash, or
compatibility with any real site or sign-in.
