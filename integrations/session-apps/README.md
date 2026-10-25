# HTML session surface

Status: first implementation path (desktop standalone host only). The phone app
and the portable Quickshell panel keep their existing conversation views.

In the standalone Companion host every conversation view, in the sidebar and in
pop-out windows, shows the **HTML session surface** instead of the classic Qt
Quick transcript and composer:

- **HTML chat** by default: transcript, choices, Stop, composer, Send/Queue,
  Record and Close session.
- The conversation's own **session application** once its agent applied one
  (`AgentSession.application`, see
  [the session application contract](../../src/session-apps/README.md)). The
  application fills the conversation's content area. It is the same
  conversation: same ID, agent, history and unsent draft.

A thin native bar above an application switches between **Chat** and the
application and opens **Classic view**. The chat page also offers Classic view.
Classic view is the existing Qt Quick presentation of the same conversation and
the recovery path for anything not shown in HTML yet (tool details, inline
widgets, pins and the panel browser stay where they were). Start the host with
`--session-surface classic` to use the classic view everywhere.

## Who owns what

| Part                                          | Source                                 |
| --------------------------------------------- | -------------------------------------- |
| Conversation model: rows, draft, pending send | `../panel/SessionView.qml` (unchanged) |
| Chat/application switch and native bar        | `SessionSurface.qml`                   |
| Trusted chat view and its bridge              | `TrustedChatView.qml`, `ChatState.mjs` |
| Trusted chat page (Preact)                    | `chat/`, built into `dist/`            |
| Restricted application view                   | `SessionAppView.qml`                   |
| Browser profiles                              | `../../native/widget-renderer/`        |

`SessionView` stays the model in every presentation, so the existing draft
handover between the sidebar and pop-out windows, agent drafts, recording into
the text box, pending send/choice confirmation and voice routing work unchanged.
Switching between chat, application and classic view never moves or rewrites
the draft.

## Two privilege levels

**Trusted chat page.** Companion's own code from the fixed local bundle
(`dist/chat.html`, `chat.js`, `chat.css`), served by the native `ShellProfile` on
`companion-shell://chat/`. The profile accepts only those files, Qt's
`qwebchannel.js` and inline images/fonts; the page CSP forbids network
connections and inline scripts. Its only native access is one QWebChannel
object (`TrustedChatView.qml`). Every bridge method re-checks the request
against the model before calling the same `SessionView` function as the classic
view: displayed conversation, draft revision, offered choice revision, current
run ID. The page never receives capability URLs, tool inputs or other
conversations. Transcript text is untrusted and rendered as escaped text or
Markdown with raw HTML disabled.

**Session application.** Agent-authored code, loaded only in the existing
restricted widget renderer (`../panel/NativeWidgetView.qml`, `WidgetProfile`):
off-the-record profile, no QWebChannel, no permissions, and a broker that maps
exactly `GET /`, `GET /state`, `POST /action` and `POST /query` onto that
application's capability URL. It cannot read history or the draft, send chat,
move focus, call window commands or reach other conversations. It is never a
composer: only the trusted chat page reports composer focus for voice routing.

This is a constrained contract, not a claim that arbitrary hostile code is
safely sandboxed. Chromium's renderer sandbox, the private profile, the request
broker and the listener's iframe/CSP form the application boundary.

## Draft synchronization

The draft lives in `SessionView`. The page sends each edit with the draft
revision it is based on. Host-side changes (agent draft, recorded words, a
confirmed send, a handover, another tab) advance the revision; the page's own
accepted edits do not, so edits in flight stay in order. An edit based on an
older revision is refused, and the page keeps the refused text with **Use my
text** and **Copy my text**, so nothing typed is silently lost. The composer is
read-only while recording appends to the draft.

## Application changes

The view follows `session.application`:

- A new application or a new code version seen while the view is open brings
  the application forward, unless a send, choice or recording is unconfirmed or
  the person is typing. Then the bar says it is ready and waits.
- The capability URL stays the same across code replacement; the view reloads
  it for each new code version.
- `error` (an application that could not be restored) shows the error and the
  application's text description; chat stays one click away.
- `eventStatus` is shown in the bar: changes waiting for, queued for or being
  read by the agent, and failed deliveries.
- Without `application` the view shows chat.

## Not ported to HTML yet

Tool details, inline widgets and pinned widgets, history-pane features such as
message selection and screenshots thumbnails (screenshots open in the native
viewer), the model picker, timers and the panel browser. Use Classic view or the
sidebar for those. The trusted HTML rail/sidebar is a separate later step.

## Build and test

```sh
npm run session-apps:build   # also run by npm run ui:build
npm run ui:build -- -DBUILD_TESTING=ON
npm run test:session-apps-ui
```

`test/session-apps-ui/surface.test.ts` runs the real native host, QML body,
trusted chat page and restricted application view offscreen against a scripted
listener transport and a synthetic application endpoint. It does not exercise
the listener's application service, a compositor or real speech.
