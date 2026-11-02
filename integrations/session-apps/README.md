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
application and opens **Classic view**. The chat page also offers Classic view
(and the application, when there is one) in its row of actions under the text
box. Classic view is the existing Qt Quick presentation of the same conversation and
the recovery path for anything not shown in HTML yet (tool details, inline
widgets, pins and the panel browser stay where they were). Start the host with
`--session-surface classic` to use the classic view everywhere.

The HTML chat and rail are drawn like the classic view so that both look the
same: messages as rounded panels with a small "You"/"Pi"/provenance heading
and Copy on hover, Markdown with the classic typography, tool groups as
"▸ N tool calls", choices as full-width "[label] description" rows, the same
text box, buttons and status, and the classic tabs in the rail. The values
come from `../panel/SessionView.qml`, `AgentChoices.qml`, `PanelAction.qml`,
`SessionTab.qml` and `Markdown.mjs` (see `chat/styles.css`, `rail/styles.css`).
Like the classic view, the chat stays at the newest message while the reader
is there, through resizing, text scale changes and streaming, and otherwise
keeps the message at the top edge in place. The phone app keeps its own
presentation.

## Who owns what

| Part                                          | Source                                 |
| --------------------------------------------- | -------------------------------------- |
| Conversation model: rows, draft, pending send | `../panel/SessionView.qml`             |
| Chat/application switch and native bar        | `SessionSurface.qml`                   |
| Trusted chat view and its bridge              | `TrustedChatView.qml`, `ChatState.mjs` |
| Trusted chat page (Preact)                    | `chat/`, built into `dist/`            |
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
exactly `GET /`, `GET /state`, `POST /action`, `POST /query` and bounded
`POST /chat-read`, `/chat-send` and `/chat-receipt` onto that application's capability URL. History requires
explicit native read consent and excludes drafts, tools and attachments. The
native permission control lives below the escape bar, outside both browsers;
only the dedicated native Client commands can grant or revoke access. So that
the application gets the room, it starts collapsed and takes no row of its own:
the native Chat/application row shows its short status (reading on/off;
sending on with remaining attempts, used up, off or unavailable; an active app
message; Disconnected) and a keyboard-reachable **Permissions…** button, wrapping
when narrow or zoomed. The button shows the review and revoke controls below
that row; **Hide permissions** collapses them again. An open disclosure, a
change awaiting confirmation or its error keeps them shown, and another
conversation starts collapsed. Collapsing grants, revokes or hides no state. In the sidebar, Activity likewise starts collapsed to its one-line status
while an application is shown and expands with its own toggle; chat keeps the
person's own Activity setting. Sending has
its own review/allow-five/revoke controls, exact-identity confirmation and quota
status; reading never grants sending. Native replies do not optimistically change
status. Renewals need explicit review and timeout never causes automatic retry. Authored
`api.chat.read()` and `api.chat.subscribe()` receive the bounded text projection,
never the trusted Chat bridge. See the [read contract](../../src/session-apps/README.md#optional-chat-read-checkpoint).
Authored sending uses `api.chat.prepareSend()` to obtain a handle **before**
`api.chat.send(handle, text)`. Keep that exact handle across errors/timeouts and
use `api.chat.receipt(handle)` for read-only recovery. No automatic replay, implicit
renewal or human-origin claim is offered. A null receipt is unknown, not proof of
no execution. See the [sender contract](../../src/session-apps/README.md#sending-backend).
The app cannot
read the draft, claim human origin, move focus, call window commands or reach
other conversations. It is never a
composer: only the trusted chat page reports composer focus for voice routing.

Host `application-message` rows have explicit Application/name/version/receipt
labels in both trusted HTML and Classic chat. They are not app-edit events or
linked agent conversations. Classic derives app titles from validated host
metadata; malformed app metadata stays explicitly unverified/non-human. Labels
and bodies render as text, and body prefixes never manufacture trusted provenance.

This is a constrained contract, not a claim that arbitrary hostile code is
safely sandboxed. Chromium's renderer sandbox, the private profile, the request
broker and the listener's iframe/CSP form the application boundary.

## Draft synchronization

The listener owns every conversation's draft; the last edit it receives wins
(see [the desktop protocol](../../src/desktop/README.md), "Text-box drafts").
`SessionView` shows it and sends each edit, naming the conversation it was
typed for. The page sends its edits to `SessionView`; an edit is no longer
refused because it was based on an older draft, and an edit that arrives after
a switch goes to its own conversation, not the one now shown. Showing,
switching or reloading only reads drafts. Text the listener has not saved
(typed while disconnected, refused, or unconfirmed at a reconnect) stays on
screen with **Save** and **Discard**, is never written again by itself, and
the conversation does not move to another view or close until one is chosen.
Edits that are longer than may be edited, or that arrive while words are being
recorded, are still refused and kept as refused text (below). The composer is
read-only while recording appends to the draft.

Send sends exactly the text the page shows, whatever the host draft holds at
that moment (another editor may have changed it): admission depends only on
the connection, a send or choice awaiting its answer and recording. The page
also waits for its latest edit's answer before sending. A confirmed send
clears the draft only while it still equals the sent text.
Cursor movement without typing (keys, pointer, selection) is reported as well,
so Classic view and pop-out handover resume at the same position.

Each conversation gets its own composer instance, created from that
conversation's host draft in the same render that switches to it, so typing
right after a switch goes to the right draft and is never erased. Answers that
arrive later for a previous instance's edits do not touch the editor now shown.
A focus request (focus shortcut) that arrives before the editor is shown is
kept until it appears.

Typing, pasting or dropping past twice the message limit is cancelled before
it changes the editor. Over-limit text that still arrives (an input method
cannot be cancelled) stays visible in the editor and is never cut. Up to four
times the message limit it becomes the conversation's text and, since the
listener does not keep it, shows as not saved with Save and Discard; moving or
closing that conversation waits until it is saved (after shortening) or
discarded. Longer text, and an edit that arrives while words are being
recorded into the draft, stays only in this editor, with a notice offering Copy
and Discard; it cannot be sent and never replaces the draft or recorded words.
The page keeps at most one such text. The host knows only its length and
keeps that conversation from moving to or from a window or closing until the
text is shortened or discarded; while another conversation or Activity is
shown, the notice stays and typing waits for it. A window whose conversation
is closed elsewhere stays open for that text. If the page reloads anyway, the
host says the text was lost.
If a conversation is closed elsewhere while its window is open, the text its
editor shows stays in the sidebar's closed-conversation notice with Copy and
Dismiss. Copy says whether it worked (with the number of characters) or why
it was refused. A new editor (page load, pop-out) starts at the
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

Through the native profile a refused action, query or chat read (for example a stale code
version, invalid arguments or a busy outbox) settles in the application's page
as a failed request: `api.call`/`api.query`/`api.chat.read` reject, nothing changes, and later
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
fails. Its tabs look like the classic ones; Pop out, Return and close appear
on hover or keyboard focus. Drag reordering and the styled tab tooltip are
not ported (the browser shows the title); the rest of the sidebar
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
