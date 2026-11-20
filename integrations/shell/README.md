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
   [changes to the shared chat page](#changes-to-the-shared-chat-page)):
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
  for 30 ms, status is sent whole when it changed. One exception: the rows of
  an arrived history page go out at once, before the status that ends
  loading (see [the paging rule](#the-paging-rule)). A conversation switch sends
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
  pages not requested again. The chat page asks for older and newer pages by
  the [paging rule](#the-paging-rule); the bridge answers each request
  (`older`, `newer`) with the next page at that edge. New rows below a
  detached snapshot continue under the reader without moving them (also
  when they reach the end before the page arrives). A failed request is
  never repeated, only the reader's Retry sends it again.
- Connection loss: the phone Connection reconnects with backoff and never
  resends a request whose answer did not arrive; such a send keeps its text in
  the editor with an explanation. The page shows a banner and the chat's
  "Disconnected" state. Sending, choosing, stopping and closing are refused
  while offline, and after reconnecting until the listener's new snapshot has
  arrived (the shown conversation may have been closed or reopened meanwhile).
- Stop follows one rule, below.
- Paging through history follows one rule, below.
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
   available for this turn (the turn is usually already ending). That notice
   belongs to the turn: it goes as soon as the conversation stops running,
   names a run (a follow-up started) or completes the turn. A listener that
   names no runs therefore cannot be stopped from the browser.

`test/shell/bridge.test.ts` lists the cases in one table (named run, a run
that changes before the click, an ending turn before and after rendering, a
first snapshot that already shows an ending turn, reconnects, another
client's Stop, a follow-up starting meanwhile; per-run and footer Stop) with
the request the rule allows for each, and a second table for the footer
Stop's notice (same turn, a follow-up with or without a run, a completed
turn, stopped elsewhere).

### The paging rule

The chat page (`Chat.tsx`) asks for history pages itself, the same way in
the browser and in the Qt host:

> A scroll the reader makes that leaves the transcript within one viewport of
> an edge asks for the next page at that edge: the previous page near the top
> (while there are older pages), the next newer page near the end of a
> detached snapshot. Whatever moved it: wheel, keys, scroll bar or a finger.
> Not while a page is loading and not after a failure (only Retry repeats a
> request). Scrolls the page makes itself never ask: following the live end,
> keeping the reader's row in place (when rows arrive or the window is
> resized), Jump to latest, and the browser pulling the view back to the end
> when the transcript grows.

The page tells its own scrolls from the reader's by the scroll positions it
set itself; the browser's pull-back is the one scroll after which the scroll
range shrank below the previous position and the view sits at the new end
(`pulledBack` in `Chat.tsx`). No input events are interpreted for paging, so
a touch pan (which the browser reports as pointerdown, pointercancel and then
scroll events only) counts like any other scroll. The bridge answers `newer`
with the next page below the snapshot, or joins the live rows when the
snapshot already ends where they start; it sends nothing while a page is
pending, after a failure, or at a boundary the listener answered with an
empty page.

Because the rule is about scrolls, input that moves nothing asks for
nothing: a downward wheel at the very end of a detached snapshot (where the
previous shell asked for the next page) does not. That end is only reached
without the next page already requested when the request could not be made
or was lost in a reconnect; any scroll there by the reader, a small one back
up included, then asks for it, and Jump to latest always works.

`test/shell/shell.test.ts` tests the rule with one table derived from it:
each input method (wheel, keyboard, scroll bar drag, touch pan) × where the
reader's scroll leaves the transcript (near the top, in the middle, near the
end) × the page state (live; detached with newer pages; detached at the
newest page, whose next rows are the live window), 36 cases with the request
the rule allows for each, and a second table of page-made scrolls at the end
of a detached snapshot (a downward wheel where nothing scrolls, a narrower
window with the mouse held still, a wider window, a taller window that pulls
the view back to the end) followed by the reader's own 3-pixel scroll there,
which does ask. Further tests cover a scroll without input at the live end
(the page stays there and asks for nothing) and a scroll bar held still for
more than a second before dragging away from it (it leaves the end and asks
for the previous page). `bridge.test.ts` has a table for `pulledBack`
(fractional positions, a reader's 1- and 3-pixel scroll at the very end, a
reader landing just before a new end), and checks that an arriving page
reaches the page as rows before the status that ends loading, while a failed
request leaves queued rows to their 30 ms coalescing: the page never sees a
request settled while it still shows the previous rows, so a scroll that
continues meanwhile (a key's smooth scrolling, a fling) cannot ask for the
page after one it has not shown yet.

### Changes to the shared chat page

`Chat.tsx` is shared with the Qt host (`TrustedChatView.qml`). Two changes
were made for the browser:

1. Its transcript does not count the end of a **detached** history snapshot
   as the live end (`following` is reported and kept as
   `atEnd && !history.detached`), except right after Jump to latest until the
   host has shown the live rows; and Jump to latest does not count its own
   scrolling as the reader's when the reader used the wheel just before.
   Newer pages are appended below a detached snapshot, and a page that
   thought it was following would jump to the end of each new page, skipping
   it. The Qt bridge already sets `followEnd = atEnd && !detached`, so what it
   records is unchanged; the only visible difference there is that a Refresh
   or a resize while reading at the end of a detached snapshot keeps the
   reader's row in place instead of the end of the rows, which is what the
   classic view does.
2. It pages by [the paging rule](#the-paging-rule): it asks for `newer` near
   the end of a detached snapshot, and asks for nothing (`older` included)
   on scrolls it makes itself. Leaving the live end still needs the reader's
   input within the last second, as before, or now also a pointer held
   pressed in the transcript: a scroll bar held still for more than a second
   before dragging used to be pulled back to the end. A scroll without input
   (a layout change) still keeps the page at the live end.

What the Qt host does at the end of a detached snapshot (`TrustedChatView.qml`,
`ChatState.mjs`, `../panel/SessionView.qml`):

- **Before the second change.** Nothing loads there. The page never asked
  for `newer`, and SessionView's own `readerScrolled`, which loads newer
  pages for the classic view, only runs on input to the classic transcript,
  which is hidden while the HTML page shows. The reader sees the end of the
  snapshot and returns to the live rows with Jump to latest
  (`latestHistory`). Near the top, the page asked for `older` on every
  scroll event there, its own included (for example while it follows the
  live end of a live window shorter than two viewports).
- **After it.** A scroll by the reader within one viewport of the end of a
  detached snapshot asks for `newer`; `TrustedChatView.history` calls
  `SessionView.loadNewer()`, exactly what the classic view does when its
  reader scrolls there: it joins the live window when the snapshot reaches
  it, otherwise requests the next page after the snapshot (unless that
  boundary already answered empty). The page arrives through
  `onToolPageReceived`, is appended with the oldest rows trimmed to stay
  within three pages, and joins the live window once it reaches it; the chat
  page keeps the reader's row in place while rows are added below and
  trimmed above. Like the classic view, the page does not ask while a page is
  pending or after a failure (`loadNewer` itself would clear the error).
  Scrolls the page makes itself no longer ask for `older` either, as in the
  classic view.

This is a deliberate difference: the HTML chat now reads down through a
detached snapshot like the classic view instead of stopping at its end.
`ChatState.mjs` (row diffing) is unchanged. Two consequences of the Qt host's
existing model show up more now that newer pages load there:

- Trimming spares the rows `SessionView.visibleKeys()` reports, and that
  reads the hidden classic transcript, not the HTML page (as it already does
  for older pages). If the hidden transcript happens to show rows that a
  newer page would trim, `applyHistory()` refuses and the whole reply is
  dropped: no new rows appear, nothing is retried, and the reader's next
  scroll near the end asks again. Conversely, if the reader scrolls back up
  while a newer page is in flight, rows they see can be trimmed; the page
  can then no longer keep their row and shifts the view by the change in the
  transcript's height instead, as it does when rows change without a row to
  keep.
- `TrustedChatView.qml` sends the status at once but coalesces rows for up to
  30 ms, so the page can see "loading" end up to 30 ms before the new rows. A
  scroll that continues in that window (a key's smooth scrolling, a fling)
  can then ask for one more page; it loads below, and the reader's row stays
  in place. The browser bridge sends an arrived page's rows first; the Qt
  host's order is QML and not changed here.

To check in the Qt host (not run here; it needs the Qt build): in the HTML
chat of a conversation with more than about a thousand rows,

1. scroll up until more than three pages are loaded (Jump to latest appears
   and the newest rows are gone), then scroll down to the end with the wheel,
   with Page Down, by dragging the scroll bar and, where available, by touch:
   each time the next newer page loads below without moving the reader's row,
   and reading on reaches the live rows (nothing skipped or duplicated);
2. while a newer page is in flight, scroll back up a little: the reader's
   row should stay or move only by the trimmed height, and the page should
   either load below or (if the hidden classic transcript protected old rows)
   be dropped with the next scroll near the end asking again, never loop;
3. with the history request failing (gateway or listener refusing it), the
   failure notice shows and scrolling at the end does not send the request
   again; Retry does;
4. Jump to latest from a detached snapshot still shows the live rows and
   follows new ones;
5. a live conversation shorter than two viewports that streams an answer
   does not load older pages by itself; scrolling up to the top and "Load
   earlier messages" still do;
6. at the live end, press the scroll bar, hold it still for two seconds and
   drag up: the view leaves the end and stays where it was dragged;
7. the classic view (unchanged QML) still pages as before, and the existing
   Qt suites (`npm run test:window`, `test/session-apps-ui/`) pass.

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
deletes its temporary directory, also while it is still starting (a second
Ctrl+C during the cleanup deletes the directory at once). `--port N` picks
another port.

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
dropped, an uncertain send's notice kept next to other notices, the footer
Stop's notice ending with its turn, and the page's `newer` request never
repeated while pending or after a failure.

`demo.test.ts` interrupts `shell:demo` with Ctrl+C while it starts and after
it started, and checks that no temporary directory is left.

`shell.test.ts` runs the built shell in headless Chromium at desktop sizes, on
the phone tests' fixtures (real gateway, real listener control socket,
synthetic agent backend, temporary directories, loopback). It covers pairing;
the list and picking a conversation; a streamed Markdown answer with agent HTML
kept literal; send; a follow-up queued while running; a choice; stop; close;
loading older pages while scrolling up, reading down through newer pages below
a detached snapshot without skipping rows (also when the reader reaches the
end by a slow scroll bar drag before the next page arrives), and Jump to
latest from a detached snapshot followed by a streamed row; the
[paging rule](#the-paging-rule) tables; a conversation reopened under the same ID while offline shown at its
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
