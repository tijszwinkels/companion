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
| Message, Markdown and action styles; icons    | `../chat-ui/`, shared with the phone   |
| Restricted application view                   | `SessionAppView.qml`                   |
| Trusted conversation list (rail)              | `TrustedRailView.qml`, `rail/`         |
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
older revision, or one that cannot be applied (too long, words being recorded),
is refused. The host keeps the refused text for that conversation until the
person chooses **Use my text**, **Copy my text** or **Dismiss** (in HTML chat or
Classic view); switching conversations or reloading the page keeps it, and
moving the conversation to another view waits until it is resolved. The
composer is read-only while recording appends to the draft.

Send names the exact text the page shows and is accepted only when that is the
host draft at the page's revision, so a refused or unanswered edit never sends
older text. The page also waits for its latest edit's answer before sending.
Cursor movement without typing (keys, pointer, selection) is reported as well,
so Classic view and pop-out handover resume at the same position.

Each conversation gets its own composer instance, created from that
conversation's host draft in the same render that switches to it, so typing
right after a switch goes to the right draft and is never erased. Answers that
arrive later for a previous instance's edits do not touch the editor now shown;
text the host could not keep still reaches that conversation's recovery.

Typing, pasting or dropping past twice the message limit is cancelled before
it changes the editor. Over-limit text that still arrives (an input method
cannot be cancelled) is refused and kept as the conversation's refused text.
Only if that bounded recovery is full does the page keep the text itself, per
conversation and for the lifetime of the page document (it survives showing
Activity or another conversation and a resynchronization); the host is told,
and moving that conversation waits until it is resolved. A real page reload
loses such text and says so. If a conversation is closed elsewhere while its
window is open, its draft, refused text and page-held text all stay in the
sidebar's closed-conversation notice with Copy and Dismiss.

Copy in these recovery notices copies at most 1,048,576 characters at once.
Text the host keeps is at most 262,144 characters, so it always copies in one
piece; longer text only the page holds is offered as **Copy part 1 of N** and
so on, in order, each within that limit and never cut inside a character (an
emoji at a boundary moves to the next part), so the plain-text clipboard keeps
every character. Nothing is cut off, the text stays
until Discard, and each Copy says whether it worked (with the number of
characters) or why it was refused. A new editor (page load, pop-out) starts at the
host cursor.

The trusted pages count as working only after their script connected and
answered. The host also asks about every second whether the current document is
still connected; after 10 seconds of missed or negative answers (a page that
never gets there, or a reload into a failing script) the view counts as
failed, and a later answer recovers it. Until a page works, and after it fails or its
renderer stops, the classic view and the native conversation list stay
visible.

## Application changes

The view follows `session.application`:

- A first application or a new code version arriving while the view shows the
  conversation brings the application forward, unless a send, choice or
  recording is unconfirmed or the person is typing in the composer. Then the
  view stays where it is (chat, for a first application), keeps the draft, and
  the bar says the application is ready until the person opens it.
- Opening a conversation that already has an application (selecting its tab or
  a new pop-out) shows the application, unless the person chose Chat for it in
  that view before.
- The capability URL stays the same across code replacement; the view reloads
  it for each new code version.
- `error` (an application that could not be restored) shows the error and the
  application's text description; chat stays one click away.
- `eventStatus` is shown in the bar: changes waiting for, queued for or being
  read by the agent, and failed deliveries.
- Without `application` the view shows chat.

## Refused application requests

Through the native profile a refused action or query (for example a stale code
version, invalid arguments or a busy outbox) settles in the application's page
as a failed request: `api.call`/`api.query` reject, nothing changes, and later
valid requests work. The page learns that it failed, not why, because Qt's
scheme handler cannot pass a non-200 status or body; refusals are never turned
into successful replies. Only a failed document or state load (or an expired
view) marks the view as broken, and the next successful load clears that.

## Not ported to HTML yet

Tool details, inline widgets and pinned widgets, history-pane features such as
message selection and screenshot thumbnails (screenshots open in the native
viewer), the model picker, timers and the panel browser. Use Classic view or the
sidebar for those.

## Session rail

With the HTML session surface the panel's list of conversations is also a
trusted HTML page (`TrustedRailView.qml`, `rail/`), in the same `ShellProfile`
shape: select, pop out, focus (selecting a popped-out conversation) and return,
and close, each through the panel's existing signals. The Activity tab,
Previous sessions, the compact rail's Expand/Return, the divider, Alt+number
and Alt+Shift+Up/Down stay native, and the native tab list returns if the page
fails. Drag reordering and tab tooltips are not ported; the rest of the sidebar
(Activity, settings, Previous sessions) remains Qt Quick.

## Build and test

```sh
npm run session-apps:build   # also run by npm run ui:build
npm run ui:build -- -DBUILD_TESTING=ON
npm run test:session-apps-ui
```

`test/session-apps-ui/surface.test.ts` runs the real native host, QML body,
trusted chat page, rail and restricted application view offscreen against a
scripted listener transport and a synthetic application endpoint.
`runtime-native.test.ts` (skipped unless the session application runtime is in
the tree) shows a real agent-applied `task-list` from AgentSessions and
WidgetService in the native view, performs a user edit through the native
broker and follows the agent's replacement with `task-board`, with a scripted
model. Neither exercises a compositor or real speech.
