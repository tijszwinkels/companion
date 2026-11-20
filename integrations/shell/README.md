# Companion browser shell

Status: first slice (2026-11). The desktop chat page in an ordinary browser,
against the existing remote gateway. The goal of the larger project is the
whole sidebar in a browser, so the interface can run on another computer
(macOS, Windows) than the listener; this slice covers one conversation at a
time.

A paired browser can:

1. pair with the gateway and reconnect, exactly as the phone panel does;
2. pick one open conversation from a plain list (Back returns to the list);
3. show it with the **desktop chat page** (`../session-apps/chat/Chat.tsx`,
   shared with the Qt host; see
   [one change to the shared chat page](#one-change-to-the-shared-chat-page)):
   streaming transcript, Markdown, tool-group summary rows and origin labels;
4. send a message, queue a follow-up while the agent runs, stop the run,
   answer offered choices and close the conversation;
5. page through older and newer history, as the desktop does;
6. show connection loss and recovery without resending anything.

## How it works

```text
Chat.tsx + ChatStore ──NativeBridge──▶ GatewayChatBridge ──▶ phone Store/Connection ──WSS──▶ gateway ──▶ listener
 (session-apps/chat, shared with Qt)     (src/bridge.ts)       (mobile/src, imported)
```

In the Qt host the chat page talks to `TrustedChatView.qml` over QWebChannel.
Here `src/bridge.ts` implements the same `NativeBridge` interface
(`../session-apps/chat/protocol.ts`) on top of the phone panel's `Store` and
`Connection` (imported, not copied):

- It sends the page the same `rows` and `status` messages as the Qt host, with
  the same sequence-number rules: every message is numbered, `ready()` resends
  everything in full, rows are diffed with `ChatState.diffRows` and coalesced
  for 30 ms, status is sent whole when it changed. A conversation switch sends
  the new rows and status at once. Rows are built with `ChatState.chatRow` from
  a TypeScript port of `SessionView.rowData()` (`src/rows.ts`).
- It checks every page request again against the shown conversation, like the
  Qt bridge, and maps it to a gateway action: Send/Queue → `send-agent`,
  choices → `choose-agent`, Stop → `stop-agent-run` (see the Stop rule below), Close
  session → `close-agent`, history → `agent-history-page`. These are all in
  the gateway's remote allowlist (`src/remote/protocol.ts`); nothing else
  leaves the page except the phone Store's own `panel-state` selection report.
  The Store is created with `{ activity: false }`, so it never reads Activity
  history (the phone panel's default is unchanged).
- A send names the draft revision its text is based on and is refused when
  the draft changed since (for example a second Enter after the first send was
  answered and cleared the draft), so a message is never sent twice. A choice
  awaiting its answer holds sends back for that conversation, also while the
  reader looks at another one.
- Resident history (`src/history.ts`) is a port of `SessionView.qml`'s paging
  on the shared `../panel/HistoryRows.mjs`: contiguous joins only, at most
  three pages resident, rows the reader can see are never trimmed, one request
  at a time with a 10 s deadline, failures only retried by the reader, empty
  pages not requested again. Below a detached snapshot (after loading more
  than three pages up), the next newer page loads when the reader scrolls toward the end to within
  one viewport of it, observed by `src/main.tsx` like
  SessionView's `readerScrolled`: a scroll toward the end while the reader drags
  in the transcript (scroll bar or finger), or within a second of wheel or key
  input there that itself pointed toward the end; at the very end, where
  nothing scrolls, a downward wheel. Scrolls the page makes itself (keeping
  the reader's row after a resize, say) never count, also right after the
  reader's input. This way so the new rows continue below without
  moving the reader (also when they reach the end before the page arrives).
  It never repeats a failed request.
- Connection loss: the phone Connection reconnects with backoff and never
  resends a request whose answer did not arrive; such a send keeps its text in
  the editor with an explanation. The page shows a banner and the chat's
  "Disconnected" state. Sending, choosing, stopping and closing are refused
  while offline, and after reconnecting until the listener's new snapshot has
  arrived (the shown conversation may have been closed or reopened meanwhile).
- Stop follows one rule, below.
- Notices and pending choices belong to one conversation lifetime (ID and
  tool epoch): a conversation closed and reopened under the same ID does not
  show the old one's notices, and late answers for the old one are ignored.
- Signing out (or a revoked pairing) clears drafts, input only the editor
  held, notices and pending state; answers that arrive later for the previous
  pairing are ignored. Another tab of the same browser reloads when the
  stored pairing changes, so it cannot write its old drafts back. Input only
  the editor holds stays reachable from the list (Copy, Discard) when its
  conversation is not shown.

### The Stop rule

1. The browser never sends the unscoped `stop-agent`.
2. A Stop it sends is `stop-agent-run` naming the run that Stop was rendered
   for: the `stopRunId` of the status the page showed. That is the run the
   conversation itself names while it runs (`AgentSession.runId`); the
   listener sets it when a turn starts and withdraws it as soon as it starts
   ending the turn.
3. It is sent only while connected (after the connection's new snapshot) and
   while that run is still the run the conversation names; otherwise nothing
   is sent. The listener stops a run only while it is current, so a Stop can
   never reach another turn, whatever happens between rendering and the
   click (another client stopping it, a follow-up starting, a reconnect).
4. The page shows its per-run Stop exactly when the conversation names a run
   (`stopRunId` set), and its footer Stop while it runs without one. The
   footer Stop sends nothing; it explains in `inputError` that Stop is not
   available for this turn (the turn is usually already ending). A listener
   that names no runs therefore cannot be stopped from the browser.

`test/shell/bridge.test.ts` lists the cases in one table (named run, a run
that changes before the click, an ending turn before and after rendering, a
first snapshot that already shows an ending turn, reconnects, another
client's Stop, a follow-up starting meanwhile; per-run and footer Stop) with
the request the rule allows for each.

### One change to the shared chat page

Apart from this, `Chat.tsx` is as the Qt host had it. Its transcript no longer counts the end of
a **detached** history snapshot as the live end (`following` is reported and
kept as `atEnd && !history.detached`), except right after Jump to latest
until the host has shown the live rows; and Jump to latest no longer counts
its own scrolling as the reader's when the reader used the wheel just
before. The browser shell needs this: newer
pages are appended below a detached snapshot, and a page that thought it was
following would jump to the end of each new page, skipping it. In the Qt host
nothing is appended below a detached snapshot, and its bridge already sets
`followEnd = atEnd && !detached`, so what it records is unchanged; the only
visible difference there is that a Refresh or a resize while reading at the
end of a detached snapshot keeps the reader's row in place instead of the end
of the rows, which is what the classic view does.

### Differences from the desktop chat

Shown as unavailable through the existing `status` fields, not by changing
the chat page:

| Desktop feature                                | In the browser                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Recording into the text box                    | `recording.available: false` (no Record button)                                                        |
| Listener-owned and agent-proposed drafts       | The draft is kept in this page per conversation, as on the phone; `draftUnsaved` is always empty       |
| Classic view, tool details, widgets            | The page's Classic view and tool-group buttons show "not available in the browser yet" in `inputError` |
| Session applications                           | `application: null`                                                                                    |
| Screenshots                                    | Labelled "screenshot unavailable"; no viewer yet                                                       |
| Voice target, voice hints, focus shortcut      | `voiceTarget: false`, `voiceStatus` and `focusShortcut` empty; choices are clicked                     |
| Rail, Activity, settings, model picker, timers | Not in this slice                                                                                      |

Known limit: two tabs of the same browser under the same pairing each keep
the phone Store's draft map and save it whole, so a draft typed in one tab can
replace a draft saved by the other (for another conversation) in storage; the
open tabs keep their own text. This is the phone Store's existing draft
persistence; scoping it per conversation belongs in that Store, for both
clients.

The gateway also limits a message to 4,000 characters (the desktop allows
8,000), so `maximumMessageLength` is 4,000. Copy uses the browser clipboard.
Links in answers (http and https only) open in a new tab without opener or
referrer when the reader clicks them, as on the phone; that navigation is the
reader's own, the page itself never requests anything from another origin.

## Build, demo and tests

```sh
npm ci
npm run shell:build      # → integrations/shell/dist (index.html, app.js, app.css)
npm run shell:demo       # synthetic listener + gateway on http://127.0.0.1:8788
npm run test:shell       # builds, then runs the unit and headless Chromium suites
```

The demo prints a pairing code; open the URL in a desktop browser and enter it.
A scripted backend streams Markdown, tool calls and choices; no model,
microphone, screen capture or personal data is involved. Ctrl+C stops it and
deletes its temporary directory. `--port N` picks another port.

Against a real listener, serve the shell with the gateway's existing option:
`bin/companion-remote serve --app-directory integrations/shell/dist` (see the
[gateway README](../../src/remote/README.md) for origins and TLS). Pairing a
real browser or exposing the gateway beyond loopback is a separate, explicitly
approved step.

`npm run test:shell` builds the shell and runs `test/shell/`.

`bridge.test.ts` checks the bridge and the history model in Node with a
stand-in Store, for orderings a browser cannot time reliably: gapless sequence
numbers and full resynchronization, no second send from a stale draft
revision, a conversation switch sending rows with their status, pending
choices across navigation, nothing admitted between reconnecting and the new
snapshot, sign-out clearing held input and late failures, a conversation
reopened under the same ID replaced like a switch, the Stop rule table,
contiguous paging within three pages including newer pages, no automatic retry after a failure, superseded pages
dropped, and an uncertain send's notice kept next to other notices.

`shell.test.ts` runs the built shell in headless Chromium at desktop sizes, on
the phone tests' fixtures (real gateway, real listener control socket,
synthetic agent backend, temporary directories, loopback). It covers pairing;
the list and picking a conversation; a streamed Markdown answer with agent HTML
kept literal; send; a follow-up queued while running; a choice; stop; close;
loading older pages while scrolling up, reading down through newer pages below
a detached snapshot without skipping rows (also when the reader reaches the end by a slow drag before the next page
arrives), and Jump to latest from a detached snapshot followed by a streamed
row; a conversation reopened under the same ID while offline shown at its
live end; a send whose
answer was lost in a gateway restart, kept with its notice and not replayed
after reconnecting; signing out and pairing again without the previous draft, also with a second
tab of the same browser open;
no Activity history request; that every request and socket goes to the
gateway's origin only; no Content-Security-Policy violation under the
gateway's real policy; and no horizontal overflow at 420 px and 1280 px. With
`COMPANION_SHELL_SCREENSHOTS=<directory>` it also saves screenshots of a
synthetic conversation at both widths (keep them out of Git).

Not tested: Safari, Firefox and Windows browsers, a real network or Tailscale,
and the Qt host itself (`npm run test:window`, `test/session-apps-ui/`).

## Structure

| File             | Responsibility                                                            |
| ---------------- | ------------------------------------------------------------------------- |
| `src/main.tsx`   | Creates the phone Store, the bridge and the chat page's ChatStore         |
| `src/App.tsx`    | Pairing, conversation list, header, connection banner, toasts             |
| `src/bridge.ts`  | `NativeBridge` over the gateway: rows/status messages, request mapping    |
| `src/history.ts` | Resident history pages (port of SessionView's paging on HistoryRows.mjs)  |
| `src/rows.ts`    | Port of `SessionView.rowData()`, through `ChatState.chatRow`              |
| `src/styles.css` | The frame around the chat; the chat keeps its desktop stylesheet          |
| `build.ts`       | esbuild bundle (Preact) plus `public/index.html`; no network dependencies |
| `demo.ts`        | Synthetic end-to-end demo                                                 |
