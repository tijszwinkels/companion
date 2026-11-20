# Companion browser shell

Status: second slice (2026-11). The desktop chat page in an ordinary browser,
against the existing remote gateway, with the conversation list next to it.
The goal of the larger project is the whole sidebar in a browser, so the
interface can run on another computer (macOS, Windows) than the listener.

A paired browser can:

1. pair with the gateway and reconnect, exactly as the phone panel does;
2. show the open conversations in a list on the left, as a narrow strip or a
   full list, and switch between them (see
   [conversation list and layout](#conversation-list-and-layout)); close
   them, reorder them by dragging, and reopen saved ones from Previous
   sessions;
3. show the selected conversation with the **desktop chat page**
   (`../session-apps/chat/Chat.tsx`, shared with the Qt host; see
   [changes to the shared chat page](#changes-to-the-shared-chat-page)):
   streaming transcript, Markdown, tool-group summary rows and origin labels;
4. send a message, queue a follow-up while the agent runs, stop the run,
   answer offered choices and close the conversation;
5. page through older and newer history, as the desktop does;
6. show connection loss and recovery without resending anything.

## Conversation list and layout

The arrangement is the same at every window width, as in the agreed design:

```text
┌──────────┬┬──────────────────────────────────────────┐
│ list     ││ ☰  title of the conversation      ready  │  ← bar above the chat
│ (strip   ││──────────────────────────────────────────│
│  or full ││        chat, centred, at most 860 px      │
│  list)   ││                                          │
│ ◷ Prev.  ││                                          │
└──────────┴┴──────────────────────────────────────────┘
            └ divider
```

- **The list** shows the open conversations in the listener's order, then
  Previous sessions at the bottom. Each conversation has the native rail's
  icon (a leading emoji of the title, or "Q" and its number; with an emoji
  the number is drawn beside it). The emoji is the title's first character
  as the reader sees it (one grapheme cluster), so "🧪Investigate" keeps
  its first word in the title. At the strip's width a short name is below
  the icon; as a full list the title and the conversation's last line (one
  muted line) are next to it. Each entry is a button named by its number,
  title and markers, with the last line as its description.
- **The divider** between the list and the chat changes the list's width by
  dragging, or from the keyboard (it is a focusable separator named
  "Conversation list width").
- **The bar above the chat** has the ☰ button that hides and shows the
  list, the conversation's title and its state as text: `working…` while
  its agent works on a turn (status `starting` or `running`), else `ready`.
  On Previous sessions, or with nothing selected, the bar has Sign out
  instead of a state.
- **The chat** is the unchanged chat page in a centred column of at most
  860 px; with the list hidden it uses the freed width up to that maximum.
- **Selecting** a conversation (click, or Enter/Space on the focused entry)
  shows it with its own unsent text: drafts are kept per conversation in
  the phone Store, as in slice 1.
- **Closing**: the × that appears on hover or keyboard focus asks for
  `close-agent` (while invisible it takes no input, so a first tap on that
  corner of an entry selects instead of closing unseen); the conversation leaves the list when the listener reports
  it closed and appears under Previous sessions. Like the chat page's Close
  session it is offered only while requests are admitted (connected, after
  this connection's snapshot) and not while the chat editor holds input of
  that conversation that only it has; the × follows changes of either.
- **Previous sessions** shows the saved conversations the listener reports
  (`agent-history`), each with Reopen (`reopen-agent`); the reopened
  conversation is selected, as on the phone. One reopen at a time: the
  Store has one mark for the conversation to select when it is restored.
  Times are not shown in this slice.
- **Look**: only the current Companion's values: the chat page's default
  theme and PanelAction buttons (`../session-apps/chat/styles.css`) and the
  native rail's tabs (`../session-apps/rail/styles.css` at theme unit 1).
  The full list's and the bar's text sizes are those of the agreed design.

Only actions the gateway's remote role already allows leave the page:
`move-agent` with the order revision, `close-agent`, `reopen-agent` and those
of slice 1.

### Remembered width and hidden state

Rule (`src/layout/list-width.ts`, `src/layout/stored-layout.ts`):

1. The list has two appearances. The **strip** is exactly 78 px wide; the
   **full list** is 150 to 420 px wide. The width remembered is always one
   of these.
2. Dragging the divider: a pointer left of 114 px (halfway between the two)
   gives the strip; at or right of it a full list as wide as the pointer's
   position, within 150 and 420 px. The width follows the pointer while
   dragging and is remembered once, when the drag ends (released, cancelled
   or capture lost: the width reached is kept). A press on the divider that
   does not move changes and remembers nothing.
3. Keyboard on the focused divider: Right widens by 20 px (from the strip:
   the 150 px full list), Left narrows by 20 px (under 150 px: the strip),
   Home gives the strip, End 420 px. Each key press is remembered.
4. ☰ hides and shows the list (and the divider). Hiding keeps the width.
5. The chat keeps at least 320 px next to the list and the divider (which
   takes 1 px). The list is shown at its remembered width narrowed to the
   window's width minus 321 px; if that is under 150 px the strip is shown.
   The strip never gets narrower, so in windows under 399 px the chat has
   what remains (296 px at 375 px). The window never changes what is remembered, so a wider
   window shows the chosen width again.
6. Remembered in this browser's `localStorage` as two independent entries,
   `companion.shell.layout.listWidth` and `companion.shell.layout.listShown`,
   each `{"version":1,"value":…}`. They describe only this page's
   arrangement, not the person or their conversations, so they are not
   cleared on sign-out. An entry that is missing, unreadable, of another
   version or of the wrong type gives its own default (the strip; shown). A
   change writes only its own entry. A storage that cannot be written keeps
   the page's values for this page.
7. Tabs of the same browser share the entries: a tab follows each entry
   another tab writes (also one written while it was starting), and since
   each change writes only its own entry, changes of different entries in
   two tabs never undo each other, in whatever order they happen.

| Case                                        | Result                                             |
| ------------------------------------------- | -------------------------------------------------- |
| Initial (nothing remembered)                | Strip, shown                                       |
| Both entries invalid or of another version  | Strip, shown                                       |
| Only the width invalid; list hidden         | Strip, hidden                                      |
| Only the hidden state invalid; 300 px       | Full list at 300 px, shown                         |
| Press on the divider without moving         | Nothing changes or is written                      |
| Storage refuses writes; 300 px, ☰, ☰      | Full list at 300 px for this page                  |
| Divider dragged to 100 px                   | Strip, remembered on release                       |
| Divider dragged to 120 px                   | Full list at 150 px                                |
| Divider dragged to 300 px                   | Full list at 300 px                                |
| Divider dragged to 600 px                   | Full list at 420 px                                |
| Right / Left / Home / End on the divider    | Per rule 3, each remembered                        |
| ☰ pressed                                  | List and divider hidden; again: shown at its width |
| Reload                                      | Width and hidden state as remembered               |
| Window 420 px, full list 300 px remembered  | Strip (420 − 321 < 150); 300 px again when wider   |
| Window 470 / 471 px, full list remembered   | Strip / full list at 150 px                        |
| Window 600 px, full list 420 px remembered  | Full list at 279 px                                |
| Width changed in another tab, then ☰ here  | This tab shows that width; ☰ keeps it             |
| Width and ☰ in two tabs at the same moment | Both kept                                          |
| Sign-out and pairing again                  | Layout kept                                        |

### Reordering by dragging

The native rail's rules (`../session-apps/rail/main.tsx`), with its pure
functions (`../session-apps/RailOrder.mjs`: threshold, insertion target,
no-op, order key), in `src/list/reorder-gesture.ts`:

1. A press with the primary button of a mouse or pen on a conversation (not
   on its ×), while requests are admitted and the listener has named an
   order revision, starts a gesture and captures that revision and the open
   conversations. A touch never starts one (rule 9).
2. It becomes a drag once the pointer moved 6 px with the button held,
   provided the order, membership and admission are still as captured
   (otherwise the press is forgotten and stays an ordinary click); a
   shorter press is an ordinary click that selects. A line shows where the
   conversation will go; the list scrolls near its top and bottom edges.
3. A drag released inside the list, at a position that changes the order,
   while the revision, the open conversations and the connection are as
   captured, asks for exactly one `move-agent` naming the captured revision.
4. Anything else ends it without a move: release outside the list, a
   position that changes nothing, Escape, a cancelled pointer, the list
   losing capture of the gesture's pointer, the window losing focus or being
   hidden (the release, or a new press of the same pointer, may then happen
   where the page cannot see it), a changed order or membership, or requests
   no longer admitted (offline, or reconnected but before the new snapshot).
   When the drag starts, capture moves from the pressed entry to the list;
   that is not a loss.
5. A drag never also selects or closes: the click after the release of any
   drag (completed or cancelled) is ignored; the next click is not.
6. The press is followed from the window: a release anywhere ends it, a
   movement without the button held forgets it, and a new press anywhere
   in the page (in the list or not) discards anything left over.
7. The list never reorders itself. It shows the listener's order; a move the
   listener refuses (the order changed meanwhile) leaves it as it was, with
   the Store's error toast.
8. Inside the list means the list is what the pointer is over (a hit test):
   not the divider overlapping its edge, nor a toast above it.
9. Reordering is a mouse and pen gesture for desktop browsers. A touch
   press never starts it: on a touchscreen a swipe scrolls the list and a
   tap selects. Touch reordering would need a gesture of its own (the phone
   panel has Move up and Move down) and is not part of this slice.

| Case                                                                     | Move requests | Click selects |
| ------------------------------------------------------------------------ | ------------- | ------------- |
| Press and release without moving                                         | 0             | yes           |
| Movement under 6 px, release                                             | 0             | yes           |
| Secondary button pressed and moved                                       | 0             | —             |
| Press while not admitted (offline, before snapshot)                      | 0             | yes           |
| Press on ×                                                               | 0             | × closes      |
| Drag released inside at a new position                                   | 1, captured   | no            |
| Drag released inside where it already is                                 | 0             | no            |
| Drag released outside the list                                           | 0             | no            |
| Escape during the drag, then release                                     | 0             | no            |
| Pointer cancelled during the drag                                        | 0             | no            |
| Pointer capture lost during the drag, then release                       | 0             | no            |
| Capture of another pointer lost during the drag                          | 1, captured   | no            |
| Window loses focus during the drag, then release                         | 0             | no            |
| Window loses focus before the threshold, press back                      | 0             | yes           |
| Press while the listener names no order revision                         | 0             | yes           |
| Release missed, then a new press elsewhere dragged back over the list    | 0             | —             |
| Drag released over the divider at the list's edge                        | 0             | no            |
| Touch press and movement on an entry (the list scrolls)                  | 0             | yes (a tap)   |
| Pen drag released inside at a new position                               | 1, captured   | no            |
| Order revision changed during the drag                                   | 0             | no            |
| A conversation opened or closed during the drag                          | 0             | no            |
| Connection lost during the drag                                          | 0             | no            |
| Order changed after the press, before the threshold                      | 0             | yes           |
| Order changed before the threshold, noticed only by the movement past it | 0             | yes           |
| Movement without the button held (release missed)                        | 0             | —             |
| New press after a cancelled drag; its click                              | per new press | yes           |
| Move refused by the listener                                             | 1 (refused)   | no; unchanged |

### Markers

The rail's markers, derived with the phone Store's rules from what the
remote role sends (`src/list/entries.ts`):

- **Selected**: the shown conversation (selection background, accent bar).
  Previous sessions is marked the same way while it is shown.
- **Working** (a turning ring around the icon, and `working…` in the bar):
  the conversation's status is `starting` or `running`. It appears when a
  turn starts and goes when the turn ends (done, stopped or failed).
- **Answer not seen** (green dot and tint): the Store's `unread` set. The
  rule: it is set when this page learns of a completed turn it had not
  seen, in an event or in a snapshot, unless that conversation is shown on
  a visible page, whatever the conversation does now (it may already run
  its next turn); and when a conversation this page never saw arrives in an
  event and is not shown. It is cleared when this page selects the
  conversation or learns it was closed (an event), and on sign-out.

| Event                                                                                                           | Unread mark                                                                 |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A turn completes in a conversation that is not shown                                                            | set                                                                         |
| A turn completes in the shown conversation, page visible                                                        | not set                                                                     |
| A turn completes in the shown conversation, page hidden (other tab)                                             | set                                                                         |
| A turn is stopped or fails                                                                                      | not set                                                                     |
| A conversation this page has not seen arrives in an event (started elsewhere)                                   | set                                                                         |
| A conversation this page has seen is reopened elsewhere                                                         | not set                                                                     |
| After a reconnect, its snapshot shows a new completed turn of a conversation not shown (also one running again) | set                                                                         |
| After a reconnect, its snapshot shows a new completed turn of the shown conversation, page visible              | not set                                                                     |
| After a reconnect, its snapshot shows a conversation started while offline without a completed turn             | not set                                                                     |
| A marked conversation closed elsewhere while offline, later reopened without a new turn                         | set again (its answer is still unseen)                                      |
| A conversation reopened from this page's Previous sessions                                                      | not set (it is selected)                                                    |
| The first snapshot after loading the page or pairing                                                            | set on every conversation whose latest turn completed, except the shown one |
| The conversation is selected (also again while shown)                                                           | cleared                                                                     |
| The conversation is closed                                                                                      | cleared                                                                     |
| Sign-out                                                                                                        | all cleared                                                                 |

The first-snapshot and offline rows are the Store's existing rules (the
phone behaves the same): it keeps no record of what this browser saw before
loading, and it learns of changes made while offline from the reconnect
snapshot, where only a new completed turn counts. `test/shell/markers.test.ts`
plays every row against the real Store.

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
> detached snapshot. In a transcript so short that both edges are that near,
> the way the reader moved decides. Whatever moved it: wheel, keys, scroll
> bar or a finger. Not while a page is loading and not after a failure (only Retry repeats a
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
the view back to the end) followed by the reader's own 1-pixel scroll there
in the same frame as the page putting their row back, which does ask.
Further tests cover a scroll without input at the live end (the page stays
there and asks for nothing), and a scroll bar or a finger held still for
more than a second before scrolling away from it (it leaves the end).
`bridge.test.ts` has the rule's decision (`pageToAsk`) as a table, including
transcripts so short that both edges are near (the browser cannot reach
those: the reader would see more than half of a detached snapshot, and rows
the reader sees are never trimmed), a table for `pulledBack` (fractional
positions, a reader's 1- and 3-pixel scroll at the very end, a reader
landing just before a new end), and checks that an arriving page reaches
the page as rows before the status that ends loading, while a failed or
refused page leaves queued rows to their 30 ms coalescing: the page never sees a
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
   pressed in the transcript, and the end of such a press counts as input: a
   scroll bar or a finger held still for more than a second before moving
   used to be pulled back to the end. A scroll without input (a layout
   change) still keeps the page at the live end.

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
   drag up: the view leaves the end and stays where it was dragged (on a
   touch screen the same with a finger resting before it pans); a scroll
   without input still keeps the view at the live end (the existing
   `test/session-apps-ui/surface.qml.in` case);
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
| Activity, settings, model picker, timers       | Not in this slice                                                                                      |
| Pop-out windows, Alt+number, Alt+Shift+Up/Down | Not in the browser; reordering is by dragging                                                          |

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

`layout.test.ts` and `reorder-gesture.test.ts` check the list's pure rules in
Node, each with the cases of its README table above: the remembered width and
hidden state (initial, invalid, dragged, keys, narrow windows, reload), the
entries' icons (also without `Intl.Segmenter`), changes from two tabs, and the
reorder gesture (every row of the reordering table, plus the drawn insertion
line). `markers.test.ts` plays every row of the markers table against the
real phone Store in Node (with stand-ins for history, storage and page
visibility), read through the list's own derivation.

`shell.test.ts` and `list.test.ts` run the built shell in headless Chromium at
desktop sizes, on the phone tests' fixtures (real gateway, real listener
control socket, synthetic agent backend, temporary directories, loopback;
shared helpers in `page.ts`).

`shell.test.ts` covers pairing;
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
`COMPANION_SHELL_SCREENSHOTS=<directory>` it also saves screenshots of
synthetic conversations at 420, 760, 1280 and 1600 px, with the list as strip
and as full list (keep them out of Git).

`list.test.ts` covers the list and layout with real pointer and key input: at
1280 px the strip next to the chat, the divider dragged under and over the snap
point and beyond the maximum, the width remembered only on release, a press
on the divider without moving changing nothing, ☰ hiding
the list with the chat then 860 px and centred, width and hidden state after
reloads, a narrow window showing the strip without changing what is
remembered, a storage that refuses writes keeping the page's width; a layout change in one tab followed by another, whose ☰ then
keeps that width; the divider's role, name, value and keys, the entries'
accessible description, and selecting, closing, Previous sessions and Reopen
from the keyboard; strip and chat at 420 px
without overflow and the centred 860 px column at 1600 px; each conversation's
own unsent text across switches; the markers table's rows for completed,
stopped and arriving turns, a conversation reopened elsewhere, selecting and
closing; the invisible × taking no input, close, Previous sessions, one reopen
at a time (all Reopen buttons disabled during a slow, refused reopen and
enabled after it) and reopen; and dragging: one move with the captured revision followed by the
listener's order, none after Escape, a touch swipe, a release outside the
list or over the divider at its edge, an order
changed at the listener during the drag or a lost connection, and a refused
move leaving the list unchanged. Each test also checks that nothing went to
another origin and that no Content-Security-Policy violation occurred.

Not covered in the browser: a page hidden in a background tab and reconnect
snapshots (the markers table's rows for them are in `markers.test.ts`); a cancelled
pointer, lost pointer capture, the window losing focus and a missing order
revision during a drag (checked in `reorder-gesture.test.ts`); a pen drag,
and touch on real touch hardware (a synthetic touch swipe is covered); the × following input the editor holds (that needs over 16,000
characters from an input method); and edge scrolling of a long list during a
drag.

Not tested: Safari, Firefox and Windows browsers, a real network or Tailscale,
and the Qt host itself (`npm run test:window`, `test/session-apps-ui/`).

## Structure

| File                                 | Responsibility                                                              |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `src/main.tsx`                       | Creates the phone Store, the bridge and the chat page's ChatStore           |
| `src/App.tsx`                        | Pairing, connection banner, toasts; the workspace once paired               |
| `src/workspace/Workspace.tsx`        | List, divider and main area; the empty view and held input                  |
| `src/workspace/ChatBar.tsx`          | The bar above the chat: ☰, title, state                                    |
| `src/workspace/PreviousSessions.tsx` | Previous sessions with Reopen                                               |
| `src/list/ConversationList.tsx`      | The conversation list: entries, markers, close, drag wiring, Previous entry |
| `src/list/entries.ts`                | What each entry shows, from the Store (number, icon, markers, last line)    |
| `src/list/reorder-gesture.ts`        | The reorder gesture's rules, without DOM access                             |
| `src/layout/list-width.ts`           | Width rules: strip, full list, snapping, keyboard, narrow windows           |
| `src/layout/stored-layout.ts`        | The remembered width and hidden state in `localStorage`                     |
| `src/layout/useListLayout.ts`        | The layout of this page: preference, window width, remembering              |
| `src/layout/Divider.tsx`             | The draggable, keyboard-operable divider                                    |
| `src/bridge.ts`                      | `NativeBridge` over the gateway: rows/status messages, request mapping      |
| `src/history.ts`                     | Resident history pages (port of SessionView's paging on HistoryRows.mjs)    |
| `src/rows.ts`                        | Port of `SessionView.rowData()`, through `ChatState.chatRow`                |
| `src/styles.css`                     | The frame around the chat; the chat keeps its desktop stylesheet            |
| `build.ts`                           | esbuild bundle (Preact) plus `public/index.html`; no network dependencies   |
| `demo.ts`                            | Synthetic end-to-end demo                                                   |
