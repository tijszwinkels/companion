# Panel browser

A minimal web browser inside the native Companion panel. It shows one
ordinary web page in place of the chat and returns to the same conversation,
drafts, pins and widgets afterwards. It is a desktop proof of concept: no
agent tool, backend protocol, app registry or phone route opens or controls it.

Source: `integrations/panel/PanelBrowser.qml` (view, profile, controls) and
`integrations/panel/PanelBrowserPolicy.mjs` (address rules). Only the native
Qt host loads it; the portable Quickshell panel never does.

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
  the rail, and the focus-input shortcut, do the same.
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
schemes) is refused with a notice, and no external handler is launched.
Chromium itself replaces some page-initiated attempts with an inert
`about:blank#blocked` page. Subresources and frames follow Chromium's normal
rules.

Each of these is declined, with a notice in the strip:

| Request                                                                              | Behaviour                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| New windows, tabs, pop-ups, `target=_blank`                                          | Refused; nothing opens elsewhere or replaces the page. |
| Downloads                                                                            | Cancelled; no file is written.                         |
| Camera, microphone, screen sharing, location, notifications, clipboard, pointer lock | Denied every time; decisions are never stored.         |
| File picker, colour picker, HTTP sign-in prompt, passkeys/security keys, printing    | Declined.                                              |
| Invalid TLS certificate                                                              | Refused; there is no bypass.                           |
| `alert()`                                                                            | Dismissed; its text appears as “Page says: …”.         |
| `confirm()`, `prompt()`                                                              | Answered “Cancel”.                                     |
| Leave-page (`beforeunload`) prompt                                                   | Leaving proceeds.                                      |
| Context menu, fullscreen                                                             | Not shown.                                             |

Unsupported pop-ups can break sign-in flows that depend on them, attachment
viewers, print and compose links. Some identity providers refuse embedded
browsers altogether; Google sign-in in particular is not promised to work.
Nothing spoofs the user agent or copies credentials to work around this.

## Tests

- `test/panel/tst_panel_browser_policy.qml` (plain `qmltestrunner`): typed
  address normalisation and the top-level URL rules.
- `test/window/panel-browser.test.ts` (in `npm run test:window`): the real
  component against loopback HTTP/HTTPS fixtures in offscreen Qt. It covers
  typed addresses, links, same-origin subresources, redirects, Back/Forward,
  Reload, refused redirects and page-initiated navigations, pop-up refusal
  (script and real click), dialogs, permissions, the file picker and download
  refusal, an untrusted certificate, pointer and Ctrl+L reveal, retained
  address edits, freezing while hidden, reparenting, Close and recreation. A
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
  The widget keeps its separate off-the-record profile.
- `test/panel/tst_panel_browser_entry.qml`: a portable host never shows the
  entry or loads the browser, even with the native-widget marker set.

These use offscreen software rendering, synthetic pages and temporary
profiles. They do not establish live Wayland hover or focus, GPU behaviour,
Sidebar/Dock layer-shell behaviour, or compatibility with any real site or
sign-in.
