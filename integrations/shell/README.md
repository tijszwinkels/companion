# Companion browser shell

Status: fifth slice, with inline widgets (2026-11). The desktop chat page in an ordinary browser,
against the existing remote gateway, with the conversation list on its left
and the Activity column on its right.
The goal of the larger project is the whole sidebar in a browser, so the
interface can run on another computer (macOS, Windows) than the listener.

A paired browser can:

1. pair with the gateway and reconnect, exactly as the phone panel does;
2. show the open conversations in a list on the left, as a narrow strip or a
   full list, and switch between them (see
   [conversation list and layout](#conversation-list-and-layout)), with
   unread answers marked the same on every browser and phone (see
   [markers](#markers)); close them, reorder them by dragging, by keyboard
   or with their ⋯ menu (also by touch), and reopen saved ones from
   Previous sessions;
3. show the selected conversation with the **desktop chat page**
   (`../session-apps/chat/Chat.tsx`, shared with the Qt host; see
   [changes to the shared chat page](#changes-to-the-shared-chat-page)):
   streaming transcript, Markdown, tool-group summary rows and origin labels;
4. send a message, queue a follow-up while the agent runs, stop the run,
   answer offered choices and close the conversation;
5. page through older and newer history, as the desktop does;
6. show connection loss and recovery without resending anything;
7. show what Companion heard and decided in an **Activity** column on the
   right, pause and resume listening, start a conversation from typed text,
   and copy, label, delete or start a coding session from what was heard
   (see [Activity](#activity));
8. show how long each running turn has been going, how long the last one
   took and when each message was written, and switch those displays and
   the listener's sound, intent and shortcut switches on a **settings
   screen** (see [Settings, turn timers and message times](#settings-turn-timers-and-message-times));
9. open a tool group in place and read its calls page by page, view a kept
   screenshot over the page, and see and change the conversation's model
   (see [Tool details, screenshots and the model picker](#tool-details-screenshots-and-the-model-picker)).
10. show an agent's **inline widgets** in the chat and use them, when the
    gateway has a frame origin (see [Inline widgets](#inline-widgets)).

Not yet in the browser: Activity history of earlier listener runs, inserting
text into desktop applications, pinned widgets and session applications.

## Conversation list and layout

The arrangement is the same at every window width, as in the agreed design:

```text
┌──────────┬┬──────────────────────────────────────────┐
│ list     ││ ☰  title of the conversation  ready ⚙ ☰ │  ← bar above the chat
│ (strip   ││──────────────────────────────────────────│
│  or full ││ chat, using the whole width              │
│  list)   ││                                          │
│ ◷ Prev.  ││                                          │
│ ⚙ Sett.  ││                                          │
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
  list, the conversation's title and its state as text: `working · 2:16`
  while a turn runs, `working…` while its agent works on a turn without a
  counted start (status `starting` or `running`), else `ready`, or
  `ready · last turn 0:42` (see
  [turn timers](#turn-timers-and-the-last-turn-duration)). On Previous
  sessions, or with nothing selected, the bar has Sign out instead of a
  state. At its right end are the gear that shows the
  [settings screen](#the-settings-screen) and the Activity ☰. Where the
  state does not fit beside the title (a narrow window), it goes on a second
  line under the title. The title keeps at least 64 px; where even that does
  not fit beside the buttons (Sign out, the gear and ☰ in a very narrow
  window), the last of them go on a second line of the bar instead of
  covering the title. Under 480 px the bar's spacing is tighter.
- **The chat** is the unchanged chat page, using the whole width of the area
  between the list and the Activity column (a design change of 2026-11-20:
  the earlier centred column of at most 860 px is gone, for every
  conversation). Its messages keep their gutter opposite the sender; its
  text box is as wide as the chat. With the list hidden it uses the freed
  width. Previous sessions and the settings screen stay in a centred column
  of at most 860 px.
- **Selecting** a conversation (click, or Enter/Space on the focused entry)
  shows it with its own unsent text: drafts are kept per conversation in
  the phone Store, as in slice 1.
- **The ⋯ menu** on each entry (always shown, also in the strip) offers
  Move up, Move down and Close session, by mouse, touch and keyboard; and
  Alt+Shift+Up and Alt+Shift+Down move a focused entry (see
  [moving by key and by the ⋯ menu](#moving-by-key-and-by-the--menu)).
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
   does not move changes and remembers nothing. While a drag is active, a
   press of another pointer on the divider (a second finger, say) is
   ignored: the dragging pointer keeps the drag, and the width it reaches is
   remembered when it is released.
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

| Case                                                                          | Result                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Initial (nothing remembered)                                                  | Strip, shown                                       |
| Both entries invalid or of another version                                    | Strip, shown                                       |
| Only the width invalid; list hidden                                           | Strip, hidden                                      |
| Only the hidden state invalid; 300 px                                         | Full list at 300 px, shown                         |
| Press on the divider without moving                                           | Nothing changes or is written                      |
| Storage refuses writes; 300 px, ☰, ☰                                        | Full list at 300 px for this page                  |
| Divider dragged to 100 px                                                     | Strip, remembered on release                       |
| Divider dragged to 120 px                                                     | Full list at 150 px                                |
| Divider dragged to 300 px                                                     | Full list at 300 px                                |
| Divider dragged to 600 px                                                     | Full list at 420 px                                |
| Divider dragged to 300 px; a second pointer presses it; the first is released | Full list at 300 px, remembered once               |
| Right / Left / Home / End on the divider                                      | Per rule 3, each remembered                        |
| ☰ pressed                                                                    | List and divider hidden; again: shown at its width |
| Reload                                                                        | Width and hidden state as remembered               |
| Window 420 px, full list 300 px remembered                                    | Strip (420 − 321 < 150); 300 px again when wider   |
| Window 470 / 471 px, full list remembered                                     | Strip / full list at 150 px                        |
| Window 600 px, full list 420 px remembered                                    | Full list at 279 px                                |
| Width changed in another tab, then ☰ here                                    | This tab shows that width; ☰ keeps it             |
| Width and ☰ in two tabs at the same moment                                   | Both kept                                          |
| Sign-out and pairing again                                                    | Layout kept                                        |

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
   where the page cannot see it), a changed order or membership, requests
   no longer admitted (offline, or reconnected but before the new snapshot),
   or another move awaiting its answer (one move at a time, see
   [moving by key and by the ⋯ menu](#moving-by-key-and-by-the--menu),
   rule 4; such a move also keeps a press from starting a gesture).
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
9. Reordering by dragging is a mouse and pen gesture for desktop browsers.
   A touch press never starts it: on a touchscreen a swipe scrolls the list
   and a tap selects. By touch, the entry's ⋯ menu has Move up and Move
   down (below); there is no touch drag.

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
| Press or drag while a move (by key or menu) awaits its answer            | 0             | yes / no      |

### Moving by key and by the ⋯ menu

Rule (`src/list/move-steps.ts`, `src/list/EntryMenu.tsx`,
`src/list/entry-focus.ts`):

1. With a conversation's entry focused (its select button, its ⋯ or its
   ×), **Alt+Shift+Up** moves it one place up and **Alt+Shift+Down** one
   place down, the desktop's keys. **Move up** and **Move down** in its ⋯
   menu do the same.
2. A move is one `move-agent` naming the conversation, the conversation it
   goes before (`""` for the end) and the listener's current order
   revision: exactly the request a drag sends, through the list's one move
   path.
3. It is possible under the drag's condition (requests admitted, an order
   revision named) and not at the ends: the first conversation has no Move
   up, the last no Move down, a single conversation neither. There the keys
   do nothing and the menu shows the item unavailable.
4. **One move at a time**, for the drag, the keys and the menu alike: a move
   is pending from the moment it is sent until the listener refuses it (or
   the request fails or is lost), or, accepted, until the list shows
   another order revision (the listener publishes the new order before it
   answers, so this normally ends with the answer). Meanwhile nothing else
   is sent: the keys do nothing, Move up and Move down are unavailable, a
   press does not start a drag and a drag in progress ends without a move.
   The list is marked busy (`aria-busy`) meanwhile. The pending move
   belongs to the page's connection, not to the drawn list: hiding and
   showing the list keeps it.
5. The list never reorders itself: it shows the listener's order. A move
   the listener refuses (the order changed elsewhere before it arrived)
   leaves the list as the listener has it, and the Store's error toast says
   so ("Session order changed; try moving the tab again").
6. Focus stays on the moved entry: on the control that had it after a key
   (its select button, its ⋯ or its ×), on its ⋯ after the menu. (Redrawing in the new order can make the browser drop
   the focus of an entry it moves; the list puts it back, and only then.)
7. When the conversation whose control or menu had focus leaves the list
   (closed here or elsewhere, also while its menu is open), focus goes to
   the entry now at its place, else the last entry, else Previous sessions.

The ⋯ menu:

1. Every entry, in the strip and in the full list, has a ⋯ button, always
   shown because touch has no hover: at the strip's top-left corner (the ×
   has the top-right one) and in the full list as a column of its own at
   the entry's right, at its bottom (clear of the ×), beside the title,
   last line and running time. It is
   named "Actions for" and the title, with `aria-haspopup="menu"` and
   `aria-expanded`.
2. A click, a tap, or Enter or Space on the focused ⋯ opens the menu, with
   focus on its first item; ⋯ again closes it. One menu is open at a time.
3. Its items are Move up, Move down and **Close session** (`close-agent`,
   offered as the × is: while requests are admitted and the editor holds no
   input of that conversation that only it has). An unavailable item stays
   focusable, marked `aria-disabled` and dimmed, and does nothing.
4. Keyboard: Up and Down (wrapping), Home and End move through the items;
   Enter or Space chooses.
5. It closes on a choice and on Escape (focus returns to its ⋯; also with
   focus on the ⋯ itself), on Tab (focus goes on from its ⋯), on a click
   or tap outside (focus goes where the press puts it; a click on nothing
   focusable returns it to the ⋯, and a press there can still start a text
   selection), on
   opening another entry's menu, on focus moving to another control, on the
   list changing between the strip and the full list (focus that was in the
   menu returns to the ⋯), and when its conversation leaves the list
   (focus by rule 7 above).
6. It is drawn over the page next to its ⋯ (below it, or above where there
   is no room), inside the window and above the Activity column, so the
   strip does not clip it. Scrolling the list moves it with its ⋯, but
   never out of the window.
7. The × and dragging stay as they were. A press on ⋯ never starts a drag
   and never selects the conversation.

| Case (A, B, C in this order; by key or by menu; strip or full list) | Move requests              | Order after                  | Focus after                                                   |
| ------------------------------------------------------------------- | -------------------------- | ---------------------------- | ------------------------------------------------------------- |
| First (A) up                                                        | 0                          | A B C; Move up unavailable   | A: the control that had it (key), its ⋯ (menu)                |
| First (A) down                                                      | 1: A before C              | B A C                        | A, the same                                                   |
| Middle (B) up                                                       | 1: B before A              | B A C                        | B                                                             |
| Middle (B) down                                                     | 1: B before `""` (the end) | A C B                        | B                                                             |
| Last (C) up                                                         | 1: C before B              | A C B                        | C                                                             |
| Last (C) down                                                       | 0                          | A B C; Move down unavailable | C                                                             |
| A move while another awaits its answer (key, menu or drag)          | 0 more                     | as the listener answers      | unchanged                                                     |
| Refused: the order changed elsewhere before it arrived              | 1 (refused; error toast)   | the listener's               | unchanged; the next move is sent                              |
| One conversation                                                    | 0                          | unchanged; both unavailable  | unchanged                                                     |
| The entry closed elsewhere while its menu is open                   | 0                          | without it                   | the entry at its place, else the last, else Previous sessions |
| Not admitted (offline, before the snapshot) or no order revision    | 0                          | unchanged; both unavailable  | unchanged                                                     |

| Menu case                                     | Menu                           | Focus after                                |
| --------------------------------------------- | ------------------------------ | ------------------------------------------ |
| Click on ⋯                                    | open                           | its first item                             |
| Tap on ⋯                                      | open                           | its first item                             |
| Enter or Space on the focused ⋯               | open                           | its first item                             |
| ⋯ pressed again                               | closed                         | the ⋯                                      |
| Escape                                        | closed                         | the ⋯                                      |
| A choice (Move up or Move down)               | closed; one move               | the ⋯ of the moved entry                   |
| An unavailable item chosen                    | open; nothing sent             | the item                                   |
| Tab                                           | closed                         | the control after the ⋯ (its ×)            |
| Click or tap outside on nothing focusable     | closed                         | the ⋯                                      |
| Click outside on a control (the text box)     | closed                         | that control                               |
| A press outside dragged over text             | closed; the text selected      | the ⋯ if the press ends in a click         |
| ⋯ pressed, released elsewhere; Escape         | closed                         | the ⋯                                      |
| Another entry's ⋯                             | that one open, this one closed | its first item                             |
| The list becomes the strip (or the full list) | closed                         | the ⋯, if focus was in the menu            |
| Close session from the menu                   | closed; one `close-agent`      | the ⋯; once closed, the entry at its place |

### Markers

The rail's markers, derived with the phone Store's rules from what the
remote role sends (`src/list/entries.ts`):

- **Selected**: the shown conversation (selection background, accent bar).
  Previous sessions is marked the same way while it is shown.
- **Working** (a turning ring around the icon, and `working…` in the bar):
  the conversation's status is `starting` or `running`. It appears when a
  turn starts and goes when the turn ends (done, stopped or failed).
- **Answer not seen** (green dot and tint): the listener's unread mark
  (below). The list, the strip and the phone panel show the same mark, and
  so does every other browser and phone paired with the same listener.

#### Marker source

Rule (`integrations/mobile/src/store.ts`, shared with the phone panel):

1. The listener keeps one unread mark per conversation, `unread`, the same
   for every device ([unread mark](../../src/desktop/README.md#unread-mark)):
   set when a turn completes successfully while no connection shows the
   conversation on a visible page, cleared when any connection shows it on a
   visible page, saved with the conversation.
2. A conversation's marker is the `unread` field of the latest version of
   that conversation this page received (a snapshot's `sessions`, an
   `agent-session` or `agent-restored` event), whenever that version carries
   it as `true` or `false`. A listener with the shared mark sends it with
   every conversation in every snapshot and event.
3. A conversation whose latest version has no `unread` field (an older
   listener, which never sends it) is marked by the page's own rule instead:
   the [fallback](#fallback-for-an-older-listener) below. The page tells the
   two apart per conversation, by the field alone.
4. This page clears the listener's mark only by reporting the conversation as
   visible (the [visible report](#visible-report)); it never clears or sets
   the mark by itself.
5. The "… — answer ready" toast stays the page's own: it is shown when a turn
   completes in a conversation that is not selected and shown on a visible
   page (also behind the settings screen or the narrow Activity column),
   whichever source the marker has.

| Case                                                        | Marker                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Listener sends `unread: true` / `false`                     | shown / not shown, whatever the page's own rule says                               |
| Turn completes while another conversation is shown          | shown (the listener sets it); the toast                                            |
| Turn completes in the conversation shown on a visible page  | not shown; no toast                                                                |
| The conversation is read on another device (or another tab) | goes, with the listener's `agent-session` update                                   |
| Reload, or the first snapshot after pairing                 | as the listener sends it: an answer completed before stays marked until shown      |
| Reconnect                                                   | as the reconnect snapshot sends it, also for changes made while offline            |
| A conversation reopened from Previous sessions              | the saved mark arrives with it; reopened here it is selected and shown, so it goes |
| A conversation reopened elsewhere                           | the saved mark, until a device shows it                                            |
| A conversation started elsewhere, still running             | not shown (nothing completed yet)                                                  |
| Listener without `unread` (older listener)                  | the fallback rule below                                                            |

#### Visible report

Rule (`integrations/mobile/src/store.ts`, `reportSelection`; the shell's
covers in `src/settings/settings-view.ts` and `src/layout/activity-overlay.ts`):

1. The page reports its selection to the listener as `panel-state`
   `{"id": "<conversation or empty>", "visible": <boolean>}`.
2. `visible` is `true` only while all of these hold: the page is visible
   (`document.visibilityState` is `visible`), a conversation is selected, and
   it is shown to the reader: not covered by the settings screen, and not
   covered by the Activity column lying over the chat in a narrow window
   (under 640 px), and no dialog lies over it: the shell's screenshot
   viewer, or on the phone a sheet, a menu or the screenshot viewer (every
   dialog that uses the phone panel's `Modal`). With no conversation selected (the empty
   view, Previous sessions, the phone's Activity page) it is `false`.
   Keyboard focus is never needed.
3. The first report on each connection is sent when its first snapshot has
   arrived. After that the page reports again whenever the selection or
   `visible` changes, and only then: never the same report twice on one
   connection. Resizing the window or dragging a divider changes nothing
   unless it moves the window across the narrow limit while the column is
   shown.
4. Becoming not visible is reported at once, so a turn that completes right
   after counts as not seen. Becoming visible is reported once the current
   browser event has finished: leaving a cover often comes together with a
   change of selection (browser Back from the settings screen goes to
   another conversation), and the conversation that was only underneath must
   not be reported as seen in between.
5. A report that was not delivered is forgotten, so the next change is
   reported in full. Over a lost connection nothing more is done (the
   listener withdraws the connection's visibility itself). Refused by the
   gateway (its request rate, a conversation closed meanwhile), the page
   reports again a second later with what is true then, one attempt at a
   time, so a page that has become hidden never stays counted as visible.
   After five refusals in a row it stops trying by itself until a report is
   accepted or the page reconnects; changes are still reported.
   Refused because the gateway does not know `visible` (a gateway older than
   the shared mark), the page reports `{"id"}` alone from then on, as
   before, until it reconnects.
6. A conversation closed while selected leaves the page showing nothing:
   the page reports `{"", false}`. The listener drops its reports of a
   closed conversation, so after a reopen it is reported again when
   shown.

| Page    | Selected conversation                | What happens next                                     | Sent                                         |
| ------- | ------------------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| visible | none                                 | first snapshot after connecting                       | `{"", false}`                                |
| visible | none                                 | tab hidden, then visible again                        | nothing                                      |
| visible | A, shown                             | select A again                                        | nothing                                      |
| visible | none                                 | select A                                              | `{A, true}` at once                          |
| visible | A, shown                             | select B                                              | `{B, true}` at once                          |
| visible | A, shown                             | the gear shows the settings screen                    | `{A, false}` at once                         |
| visible | A, behind the settings screen        | the gear again                                        | `{A, true}` after the click                  |
| visible | A, behind the settings screen        | browser Back to B                                     | `{B, true}` only (never `{A, true}`)         |
| visible | A, behind the settings screen        | B chosen in the list                                  | `{B, true}` only (never `{A, true}`)         |
| visible | A, behind the settings screen        | a started conversation C is selected underneath       | `{C, false}`                                 |
| visible | A, shown, narrow window              | the Activity column is shown over it                  | `{A, false}` at once                         |
| visible | A, behind the narrow Activity column | the column is hidden                                  | `{A, true}`                                  |
| visible | A, shown, column beside it (wide)    | window narrowed under 640 px, then widened            | `{A, false}`, then `{A, true}`               |
| visible | A, shown, column hidden              | window resized across 640 px                          | nothing                                      |
| visible | A, shown, column beside it           | a divider dragged, the window resized above 640 px    | nothing                                      |
| visible | A, shown                             | tab hidden, then visible again                        | `{A, false}` at once, then `{A, true}`       |
| hidden  | A                                    | a reconnect                                           | `{A, false}` after the new snapshot          |
| visible | A, shown                             | a reconnect                                           | `{A, true}` after the new snapshot           |
| visible | A, shown                             | A closed elsewhere                                    | `{"", false}`                                |
| visible | none (A was closed)                  | A reopened and selected again                         | `{A, true}` again                            |
| visible | B, shown; its report refused (rate)  | a second later                                        | `{B, true}` again                            |
| hidden  | A; `{A, false}` refused (rate)       | a second later                                        | `{A, false}` again                           |
| visible | A, shown; every report refused       | time passes                                           | five more attempts a second apart, then none |
| visible | A, shown; gateway without `visible`  | the refusal arrives                                   | `{A}` (no `visible`), from then on           |
| visible | A, shown                             | a dialog opens (screenshot viewer; phone sheet, menu) | `{A, false}` at once; closed: `{A, true}`    |

The phone panel follows the same rule. Its conversation page is the one on
screen while a conversation is selected and no sheet, menu or screenshot
viewer lies over it (any of them counts as covering, also a sheet that
leaves part of the page visible: a wrong `true` would clear a mark on every
device). In the browser shell the screenshot viewer is such a dialog; it
also closes when the limit page appears.

#### Fallback for an older listener

For a conversation without the listener's `unread` field (rule 3 above),
the Store's own rule: it is set when this page learns of a completed turn it
had not seen, in an event or in a snapshot, unless that conversation is
shown on a visible page, whatever the conversation does now (it may already
run its next turn); and when a conversation this page never saw arrives in
an event and is not shown. It is cleared when this page selects the
conversation while it is shown, when a cover over the selected
conversation lifts (after the current event, as the visible report), or
when it learns the conversation was closed (an event), and on sign-out. A
cover (the settings screen, the narrow Activity column) counts as not
shown.

| Event                                                                                                           | Unread mark                                                                 |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A turn completes in a conversation that is not shown                                                            | set                                                                         |
| A turn completes in the shown conversation, page visible                                                        | not set                                                                     |
| A turn completes in the shown conversation, page hidden (other tab)                                             | set                                                                         |
| A turn completes in the selected conversation while the settings screen covers it                               | set                                                                         |
| A conversation with that mark is selected underneath the settings screen (a started one)                        | kept until it is shown                                                      |
| The cover over a marked selected conversation lifts (the column hidden, the gear)                               | cleared                                                                     |
| Browser Back from the settings screen to another conversation                                                   | the one underneath keeps its mark                                           |
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

The first-snapshot and offline rows are why the listener's mark replaced
this rule: the page keeps no record of what this browser saw before
loading, so after a reload every finished conversation shows as unread,
and reading a conversation on one device does not clear it on another.

#### Tests

`test/shell/markers.test.ts` plays every row of the three tables above
against the real Store in Node (with a stand-in for the page's visibility
and the socket): the marker source with a listener that sends `unread` and
with one that does not, the visible report row by row, and the fallback
rule. `test/shell/shared-unread.test.ts` checks the shared mark end to end
in headless Chromium against the real gateway and listener: a turn
completed while another conversation is shown stays marked after a reload,
showing it clears the mark in a second tab of the same browser, a hidden tab
clears nothing, and the narrow Activity column covers the chat (only
crossing the narrow limit reports). The settings screen's cover is checked
in the browser by `test/shell/settings.test.ts` ("an answer completed behind
the settings screen is marked unread; going back clears it").

## Activity

What Companion heard on the computer, what it decided to do with it, and the
listening controls, in a column on the right of the chat:

```text
┌────────┬┬──────────────────────────────┬┬──────────────────────┐
│ ◖ Act. ││ ☰  title          ready  ⚙   ││ Activity listening ☰ │
│────────││──────────────────────────────││──────────────────────│
│ list   ││  chat, the whole width       ││ listening · pause    │
│        ││                              ││ start a conversation │
│        ││                              ││ history, newest first│
└────────┴┴──────────────────────────────┴┴──────────────────────┘
                                          └ divider
```

- **Showing and hiding.** The column is hidden at first. While it is hidden,
  the ☰ at the right end of the bar above the chat shows it; while it is
  shown, the ☰ at the right end of the column's own header hides it (the
  bar's ☰ is not drawn then; the column takes its place). The **Activity**
  entry at the top of the conversation list, above the conversations and a
  separator, shows and hides the **same** column; it is not a page of its
  own, and the conversation shown in the chat stays shown. Keyboard focus
  follows: showing the column with the bar's ☰ moves focus to the column's
  ☰, hiding it with the column's ☰ moves focus back to the bar's ☰. When
  another tab shows or hides the column while the bar's ☰, or anything in
  the column, has focus here, focus moves the same way instead of being
  lost with what went away.
- **The Activity entry** carries the microphone (struck through while
  listening is paused or Companion is not running) and, in the full list,
  the listening state as its last line (`Listening`, `Paused`, `Paused for
media`, `Not running`), followed by `· 3 new` while new entries are
  marked. At the strip's width it shows the short name `Activity`.
- **Inside the column**, from the top: the listening state with Pause and
  Resume, a box to start a conversation, and this listener run's history,
  newest first.
- **Look**: the chat page's theme, its PanelAction buttons and its message
  panels (`../session-apps/chat/styles.css`): each history entry is a tinted
  rounded panel like an agent's message, its heading in the same small
  muted monospace.

Only actions the gateway's remote role already allows leave the page for
Activity: `activity-history` (reading, by the phone Store), `toggle-pause`,
`start-agent`, `start-history-agent`, `label-history` and `delete-history`.

### Activity column width and hidden state

Rule (`src/layout/activity-width.ts`, `src/layout/stored-layout.ts`):

1. The column is 240 to 520 px wide, 320 px at first. The width remembered
   is always within that range.
2. Dragging the divider between the chat and the column gives the column
   the distance from the pointer to the right edge of the window, within
   240 and 520 px. As for the list's divider, the width follows the pointer
   while dragging and is remembered once, when the drag ends (released,
   cancelled or capture lost: the width reached is kept, also when the
   divider goes away during the drag because the window narrows or another
   tab hides the column); a press that does not move changes and remembers
   nothing; a press of another pointer during a drag is ignored, as on the
   list's divider. (The list's divider is the same component and keeps its
   width the same way.)
3. Keyboard on the focused divider (a separator named "Activity width"):
   Left widens the column by 20 px, Right narrows it by 20 px, Home gives
   240 px, End 520 px. Each key press is remembered.
4. Hiding keeps the width.
5. **Wide window (640 px and wider):** list, chat and column side by side.
   The chat keeps at least 320 px. The column gives way first, but never
   below 240 px: it is shown at its remembered width narrowed to the window
   minus 321 px (chat and the column's divider) minus 79 px while the list
   is shown (the strip and its divider). The list then follows its own rule
   (above) in what the column leaves: the window minus the column and its
   divider.
6. **Narrow window (under 640 px):** the column lies over the chat, from the
   list's right edge (or the window's left edge while the list is hidden) to
   the window's right edge, until it is hidden again; there is no divider.
   The list keeps its own width. The covered chat is inert meanwhile (no
   keyboard focus, no input, hidden from assistive technology); focus that
   was in the chat when the column came over it moves to the column's ☰.
   The window never changes what is remembered.
7. Remembered as two more independent entries next to the list's,
   `companion.shell.layout.activityWidth` and
   `companion.shell.layout.activityShown`, each `{"version":1,"value":…}`,
   with the list's rules: a missing, unreadable, other-version or wrong-type
   entry gives its own default (320 px; hidden); a change writes only its
   own entry; a storage that refuses writes keeps the page's values; not
   cleared on sign-out; other tabs follow each entry they see written.

| Case                                                                          | Result                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Initial (nothing remembered)                                                  | Hidden; 320 px when shown                                  |
| Both entries invalid or of another version                                    | Hidden; 320 px when shown                                  |
| Only the width invalid; column shown                                          | Shown at 320 px                                            |
| Only the shown state invalid; 400 px                                          | Hidden; 400 px when shown                                  |
| Remembered width 100 / 900 (out of range)                                     | 240 / 520 px                                               |
| ☰ in the bar, then ☰ in the column                                          | Shown, then hidden; each remembered; the width kept        |
| The Activity entry pressed twice                                              | Shown, then hidden (the same entry as ☰)                  |
| Divider dragged to 300 px from the right edge                                 | 300 px, remembered on release                              |
| Divider dragged to 100 / 900 px from the right edge                           | 240 / 520 px                                               |
| Press on the divider without moving                                           | Nothing changes or is written                              |
| Left / Right / Home / End on the divider                                      | +20 / −20 / 240 / 520 px, each remembered                  |
| Reload                                                                        | Width and shown state as remembered                        |
| Storage refuses writes; 400 px, ☰                                            | 400 px, shown, for this page                               |
| Window 1600 px, strip, column 320 px                                          | Side by side; chat area 1200 px, the chat as wide          |
| Window 1000 px, full list 420, column 520 remembered                          | Column 520 px; full list 158 px; chat 320 px               |
| Window 700 px, strip, column 520 remembered                                   | Column 300 px (700 − 321 − 79); chat 320 px                |
| Window 640 px, strip, column shown                                            | Column 240 px beside the chat                              |
| Window 639 / 420 px, column shown                                             | Over the chat, right of the list; no divider; no overflow  |
| Window 420 px, column shown, Tab                                              | Moves through list and column, never into the covered chat |
| Window 420 px, column shown, an error toast                                   | The toast and its Dismiss are drawn above the column       |
| Divider dragged to 400 px, the column hidden from another tab before release  | 400 px remembered                                          |
| Divider dragged to 400 px; a second pointer presses it; the first is released | 400 px, remembered once                                    |
| Focus in the chat, the window narrows under 640 px                            | Focus moves to the column's ☰                             |
| Focus on a ☰ or in the column, another tab shows or hides it                 | Focus moves to the other ☰; focus elsewhere stays         |
| Focus on the divider, the window narrows under 640 px                         | Focus moves to the column's ☰ (the divider is gone)       |
| Focus on the divider, another tab hides the column                            | Focus moves to the bar's ☰                                |
| Window 420 px, list hidden, column shown                                      | Over the whole window width                                |
| Width or shown state changed in another tab                                   | This tab follows that entry                                |
| Sign-out and pairing again                                                    | Layout kept                                                |

### The new-activity marker

While the column is hidden and something new was heard, the bar's ☰ and the
Activity entry carry the green dot (the list's "answer not seen" color),
and the full list's Activity entry says how many entries are new. Rule
(`src/activity/new-activity.ts`):

1. An entry is **new** when this page learns of an entry ID of the current
   listener run that it had not seen, while the column is hidden, after
   this page **caught up** with the run's history once: its first reading
   since loading or pairing has finished without an error (the Store read
   every page up to the count the listener reported). Entries learned
   before that are what the reader may already have seen elsewhere, and are
   never new.
2. Learned means from an `activity-entry` event or from a history page,
   including the pages read after a reconnect (entries heard while the page
   was offline) and those of a new listener run started after the page
   caught up. After each reconnect the page reads the run's history again
   from its start (the Store's `rereadActivityAfterReconnect`, on in the
   shell, off on the phone), so an entry deleted elsewhere meanwhile is
   removed and a label given elsewhere is shown; events about them were
   missed while offline. The position reached is kept after each page, so
   a reading refused part way (the gateway's rate limit on a long run)
   continues there on Retry. Retry is offered only while requests are
   admitted (after the reconnect's snapshot), checked again at the press;
   and a reading that is still on its way when a reconnect's snapshot asks
   for the run to be read again is abandoned and starts over from the
   beginning, so it can never skip what changed while offline.
3. A change of an entry already seen (its decision, outcome or label, from
   any client) is not new.
4. Showing the column clears the marker (by either ☰, the Activity entry,
   or another tab, whose shown state this tab follows). An entry learned
   while the column is shown is seen. Hiding the column sets nothing.
5. An entry that is removed (deleted here or elsewhere, or gone with its
   run) no longer counts; the marker goes when no new entry is left.
6. Sign-out clears it; pairing again starts with a new first reading.
7. Listening, pausing, hearing speech and processing are states, not
   entries: they never set it.

| Event                                                                                                    | Marker                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| First reading after loading the page, with entries                                                       | not set                                                                                              |
| A new entry arrives while hidden                                                                         | set (count 1)                                                                                        |
| Two more arrive while hidden                                                                             | set (count 3)                                                                                        |
| A new entry arrives while shown                                                                          | not set, also after hiding                                                                           |
| An entry already seen is labelled or changes outcome                                                     | not set                                                                                              |
| The column is shown (☰, Activity entry, or another tab)                                                 | cleared                                                                                              |
| The only new entry is deleted                                                                            | cleared                                                                                              |
| Entries heard while offline, learned after reconnecting                                                  | set                                                                                                  |
| An entry deleted elsewhere while offline                                                                 | gone after reconnecting; no longer counts                                                            |
| An entry labelled elsewhere while offline                                                                | label shown after reconnecting; not set                                                              |
| The reading after a reconnect is refused part way; Retry                                                 | continues at the page reached; later deletions applied                                               |
| Retry pressed after reconnecting, before the snapshot, after a partial reading; an entry deleted offline | Retry not offered until the snapshot; a reading already on its way starts over; the entry is removed |
| A reconnect without new entries                                                                          | not set                                                                                              |
| A new listener run after catching up, with entries                                                       | set                                                                                                  |
| The first reading fails; entries arrive; a retry catches up                                              | not set until caught up                                                                              |
| Pause, resume, speech, processing                                                                        | not set                                                                                              |
| Sign-out and pairing again (first reading)                                                               | not set                                                                                              |

### Listening, starting a conversation and history entries

- **Listening** shows the desktop's wording (`listeningStatus` of the phone
  Activity page): `Listening`, `Paused` ("Microphone capture is paused."),
  `Paused for media` ("Listening resumes when playback stops.") or `Not
running`, and below it while listening `Hearing speech`, `Processing N…`
  or `Ready for speech`. The column's header carries the same state in
  short. Pause and Resume send `toggle-pause` (the only listening action of
  the remote role).
- **Start a conversation**: a text box (at most 4,000 characters, as the
  gateway allows), a choice between a coding conversation and a quick
  question, and Start (`start-agent`). The text and the choice are kept
  while the column is hidden. It uses the phone Store's draft and send
  rules: the text is kept in this browser until the start is answered,
  a second Start cannot send it again, and a failure keeps the text with
  the explanation. The conversation opens in the background on the
  desktop; here it appears in the list and is **selected** once listed,
  unless what is shown (the selected conversation or Previous sessions)
  changed at any moment since Start was pressed, also to and fro or by Back
  and Forward, and when the listener closed the shown conversation
  (`src/activity/select-started.ts`; the shell alone selects it, the phone
  Store's own selection of a started conversation is turned off with
  `sendDraft(…, { openStarted: false })`). Waiting for it ends after
  10 seconds, on sign-out or when the start fails. Not offered while the
  listener runs in preview mode (it would answer without starting anything,
  and the text would be cleared).
- **History** is this listener run's (earlier runs are not shown), read by
  the phone Store in pages of 50 and kept current by `activity-entry` and
  `history-deleted` events; newest first. Each entry shows the recognised
  text, the time, the application that was in front, the decision
  (the intent's label, or "No intent") and its outcome, and its label once
  labelled. Entries without text (audio only), from an earlier part of an
  utterance, not saved or without a complete saved capture say so, as on
  the phone.

Per entry, the actions follow one rule: an action that asks the listener
for something is **enabled** only while requests are admitted (connected,
after this connection's snapshot; the conversation list's rule), while no
other request of the same entry awaits its answer, and while the entry
allows it. At the click the page applies the same rule again to the
Store's current entry and listener state (the entry still in the run it
was drawn for, requests admitted, the action still allowed) and otherwise
sends nothing. A refused request shows the Store's error toast and leaves the
entry as the listener reports it; nothing is shown as done before the
listener says so. Copy is local and always enabled when there is text.

Keyboard focus is never dropped by the column: an action that is not
available (offline, its request awaiting the answer) keeps its button
focusable, marked unavailable (`aria-disabled`) and drawn dimmed, instead of
disabled, which in Chromium moves focus to the page; focus on a button of an
entry that goes away (deleted here or elsewhere, or with its run) moves to
the entry that takes its place, else the one above, else the History
heading; picking the actual intent closes the choice and returns focus to
Incorrect; focus on the Activity divider when it goes away (the window
narrows under 640 px, or another tab hides the column) moves to the
column's ☰ if the column is still shown, else to the bar's ☰; Retry, once
the reading works again, hands focus to the History
heading.

- **Copy** puts the recognised text on the clipboard ("Copied", or "The
  browser did not allow copying").
- **New coding session** (`start-history-agent`) starts a coding
  conversation from the entry's saved screenshot and text, in the
  background on the desktop. Not for an audio-only entry or one whose
  screenshot was not kept, nor while the listener offers no conversation
  controls or runs in preview mode. The listener's answer does not name the new
  conversation, so it appears in the list, working, and is not selected; it
  gets the "not seen" marker if its answer completes while no device shows
  it.
- **Correct** and **Incorrect** (`label-history`) label the decision; they
  need a decision (an intent), capture storage on at the listener, and the
  entry's complete saved capture (otherwise the reason is shown, as on the
  phone). Incorrect sends the label and opens "What should it have been?",
  the listener's intents except the recognised one (which the listener
  refuses); picking one sends the label with that actual intent. On an
  entry already labelled incorrect, as the Store has it at the click (also
  by another client since it was drawn), Incorrect only opens the choice,
  so the actual intent chosen before is kept. Not while the listener runs in preview mode, where labels are
  not saved. The pressed button shows the current label.
- **Delete** (×) is offered only while the listener advertises deletion
  (`historyDeletionAvailable`). It opens a confirmation inside the entry
  ("Delete permanently" or Cancel) and sends `delete-history` only from
  there; not while the entry is still processing. Once Delete permanently
  is pressed the confirmation says "Deleting…" and neither it nor Cancel
  can be pressed until the listener answers (also after hiding and showing
  the column): Cancel could not stop the deletion. The entry leaves the
  column when the listener reports it deleted; a refusal keeps the
  confirmation with both buttons available again (the toast explains). The
  confirmation stays open until Cancel, the deletion or the entry going
  away (then it is forgotten), also while the column is hidden: a refusal that arrives while it is
  hidden shows it again with the confirmation open. Toasts are drawn above
  the column, also where it lies over the chat.

| Entry and state                                           | Copy | New coding session | Correct / Incorrect                        | Delete ×                                        |
| --------------------------------------------------------- | ---- | ------------------ | ------------------------------------------ | ----------------------------------------------- |
| Saved entry with a decision; admitted; deletion offered   | on   | on                 | on                                         | shown, on                                       |
| Offline                                                   | on   | off                | off                                        | shown, off                                      |
| Reconnected, before the new snapshot                      | on   | off                | off                                        | shown, off                                      |
| Deletion not advertised by the listener                   | on   | on                 | on                                         | not shown                                       |
| Already labelled correct                                  | on   | on                 | on; Correct pressed                        | shown, on                                       |
| Labelled incorrect → an intent                            | on   | on                 | on; Incorrect pressed; "→ intent"          | shown, on                                       |
| A request of this entry awaits its answer                 | on   | off                | off                                        | shown, off                                      |
| A request of another entry awaits its answer              | on   | on                 | on                                         | shown, on                                       |
| The listener refused the request                          | on   | on (toast)         | on (toast); label unchanged                | shown, on (toast)                               |
| No decision (no intent)                                   | on   | on                 | off                                        | shown, on                                       |
| Audio only (no text, no decision)                         | off  | off                | off                                        | shown, on                                       |
| Not saved (capture storage was off)                       | on   | off                | off, "requires this entry's saved capture" | shown, on                                       |
| Capture storage off (or being turned off) at the listener | on   | on                 | off, "requires capture storage"            | shown, on                                       |
| An older listener that does not report capture storage    | on   | on                 | on (its own rules apply)                   | shown, on                                       |
| Screenshot not kept                                       | on   | off                | on unless the listener names a reason      | shown, on                                       |
| The listener names why the capture is incomplete          | on   | per screenshot     | off, "requires … complete saved capture"   | shown, on                                       |
| Still processing                                          | on   | on                 | on                                         | shown, off                                      |
| The listener offers no conversation controls              | on   | off                | on                                         | shown, on                                       |
| The listener runs in preview mode                         | on   | off                | off, "Preview mode: labels are not saved." | not shown                                       |
| Removed elsewhere while its confirmation is open          | —    | —                  | —                                          | gone; nothing sent                              |
| Delete permanently pressed, answer pending                | on   | off                | off                                        | confirmation "Deleting…"; Cancel and Delete off |
| Delete refused by the listener                            | on   | on                 | on                                         | confirmation kept; Cancel and Delete on (toast) |
| Delete refused while the column is hidden, then shown     | on   | on                 | on                                         | confirmation kept; Cancel and Delete on         |
| Gone or a new run between drawing and the click           | —    | nothing sent       | nothing sent                               | nothing sent                                    |

Pause and Resume follow the same rule (admitted, Companion running, its own
toggle not awaiting an answer). Start is enabled while admitted, while the
listener offers conversation controls and is not in preview mode, with
text, and no start awaiting its answer. A request of an entry still
awaiting its answer keeps that entry's requests disabled also when the
column is hidden and shown again.

Known limits: a request whose answer arrives between the column's drawing
and its effects is not timed in the browser; the column has no subscription
of its own (the workspace follows the requests for the whole pairing), so
there is nothing for that answer to miss. `toggle-pause` is the remote
role's only listening action and
it toggles, so a Pause pressed at the moment listening was paused elsewhere
resumes it (the button shows the listener's state again at once). The whole
run's history is drawn (it is read in pages, not shown in pages). The
marker's memory is this page's: a reload or a second tab starts from its
own first reading.

## Settings, turn timers and message times

The listener publishes when each running turn started (`turnStartedAt`, only
while it runs), how long the last one took (`lastTurnDurationMs`), when each
message was written (`createdAt`) and its own clock (`listenerTime` on every
state message); see
[turn and message times](../../src/agents/README.md#turn-and-message-times).
The browser shows them, and a settings screen switches each display off and
on.

### The settings screen

1. It is reached by the **gear** in the bar above the chat (left of the
   Activity ☰; at the bar's right end while the Activity column is shown,
   which then has that ☰) and by the **Settings** entry at the bottom of the
   conversation list, below Previous sessions. In a narrow window, where the
   shown Activity column lies over the main area, the Settings entry also
   hides the column (as its ☰ would), so the settings screen can be seen
   and reached.
2. It takes the place of the chat (or Previous sessions, or the empty view);
   the bar's title says "Settings" and the bar shows no state. The gear is
   pressed (`aria-pressed`), and the list marks Settings as shown instead of
   a conversation. A conversation's chat stays drawn under it, covered and
   inert, so going back finds it as it was: the same scroll position (or
   still following the live end), the same text in the editor.
3. It is left by the gear again, by choosing a conversation (also the one
   underneath) or Previous sessions in the list, and by the browser's Back
   and Forward. Nothing else leaves it: it is this page's own view, not one
   of the Store's pages, so what the Store selects underneath stays as it
   is, also when it changes meanwhile (a conversation started from Activity
   is selected underneath and shown when the settings screen is left; the
   conversation underneath closed elsewhere shows the empty view then).
4. The conversation underneath is **not shown** while the settings screen
   covers it: the page reports it as not visible (see
   [visible report](#visible-report)), so an answer completed meanwhile gets
   the "answer not seen" mark and the toast, as for a conversation that is
   not selected (the Store's `selectionShown` option), and a conversation
   selected underneath it (a started one) keeps its mark. Going back to it
   with the gear, or by Back and Forward, shows it, which clears the mark,
   as choosing it does.
5. Text only the chat editor holds is offered there as on Previous sessions
   (Copy, Discard).

It has two sections. **Display**: three switches with one line each, the
agreed design's wording, this browser's own (rules below). **Listening**:
the listener's Sound feedback switch and one switch per intent and per
shortcut, as the phone panel offers them. These are Companion's own
settings, shared with the computer and every client.

#### Display switches

Rule (`src/settings/display-settings.ts`):

1. Turn timers, Last turn duration and Message timestamps are each **on**
   unless switched off here, and apply at once (rows already shown included).
2. Each is remembered in this browser's `localStorage` as its own entry,
   `companion.shell.display.turnTimers`, `….lastTurnDuration` and
   `….messageTimestamps`, `{"version":1,"value":true|false}`, with the layout
   entries' rules: an entry that is missing, unreadable, of another version
   or not a boolean gives its default (on); a change writes only its own
   entry; a storage that refuses writes keeps the switch for this page; not
   cleared on sign-out; other tabs follow each entry they see written, so
   two tabs switching different switches never undo each other.

| Case                                                | Result                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Nothing remembered                                  | All three on                                                 |
| Turn timers switched off                            | Its entry `false`; the other two not written; on as before   |
| Last turn duration switched off                     | Its entry `false` only                                       |
| Message timestamps switched off                     | Its entry `false` only                                       |
| Switched off, then on again                         | Its entry `true`                                             |
| Reload                                              | As remembered                                                |
| Another tab switches one                            | This tab follows that switch only                            |
| Two tabs switch different ones at the same moment   | Both kept, in both tabs                                      |
| Storage refuses writes; one switched off            | Off for this page; a reload shows it on (nothing remembered) |
| Storage cannot be used at all                       | All on; switches work for this page                          |
| Entry not JSON, of version 2, `"no"`, `0` or `null` | That switch on (its default); the others as remembered       |
| Another tab clears the whole storage                | This tab reloads (the pairing is gone too); all on           |
| Sign-out and pairing again                          | Kept                                                         |

#### Listening switches

Rule (`src/settings/listening-switches.ts`): each switch shows the
listener's current value, also a change made elsewhere (it arrives with the
next state message), and nothing is shown as changed before the listener
says so. It is **available** only while requests are admitted (connected,
after this connection's snapshot), while no request of the same switch
awaits its answer, for Sound feedback while the listener is not in preview
mode, and for an intent or shortcut while it is toggleable and the listener
reports independent intent and shortcut switches. Sound feedback sends
`toggle-sounds`; an intent or shortcut `set-intent-enabled` with its name,
mode and the opposite of the value the Store has at the press. Independent
switches means `inferenceEnabled` and `shortcutEnabled` are booleans on every
intent. An older listener reports per intent only the combined `enabled`
(for deciding from speech and its shortcut together, without
`supportsInference`): each of its intents is shown as one read-only switch
with that value ("Intent and shortcut together"). A refusal
shows the Store's error toast. An unavailable switch stays focusable
(`aria-disabled`, dimmed), so focus is never lost while an answer is on its
way.

| State                                           | Sound feedback | Intent and shortcut switches                   | Note shown                                           |
| ----------------------------------------------- | -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Connected, after the snapshot                   | available      | available                                      | —                                                    |
| Before the first snapshot of the pairing        | not shown      | not shown                                      | "…shown once it is connected."                       |
| Offline, or reconnected before the new snapshot | unavailable    | unavailable                                    | "Shown as Companion last reported them…"             |
| Listener in preview mode                        | unavailable    | available                                      | "Preview mode: sound feedback cannot be changed."    |
| Older listener without independent switches     | available      | one per intent, its `enabled` value, read-only | "Restart Companion to load independent intent and …" |
| An intent that is not toggleable                | —              | that one unavailable                           | its line says "Always on"                            |
| A request of this switch awaits its answer      | unavailable    | that one unavailable                           | —                                                    |
| Changed on the computer or another client       | follows        | follows                                        | —                                                    |

### Turn timers and the last turn duration

Rule (`src/times/turn-times.ts`, `src/times/listener-clock.ts`):

1. A running time is shown only while the conversation has `turnStartedAt`,
   the Turn timers switch is on and its state is known (requests are
   admitted: connected and after this connection's snapshot). Offline, or
   reconnected before the new snapshot, the last known start is not counted
   as if live: the turn may have ended meanwhile.
2. The running time is `Date.now() + offset - turnStartedAt`, with
   `offset = listenerTime - Date.now()` taken when each state message
   arrives (0 without `listenerTime`, an older listener). So the listener's
   clock may be ahead of or behind the browser's.
3. The bar shows `working · m:ss` then, and `working…` with a start not
   counted by rule 1.
4. Without `turnStartedAt`, a conversation with `lastTurnDurationMs` has no
   running turn: the bar shows `ready · last turn m:ss` while the Last turn
   duration switch is on, else `ready`. That holds also in the moment after
   a turn ended in which `status` still says `running` (the listener removes
   the start and sets the duration together, and its status follows once
   the turn is saved). The duration is a stored value, not a count, so it is
   shown whatever the connection. Without either field (an older listener)
   `status` decides: `working…` while `starting` or `running`, else `ready`.
   (The list's turning ring follows `status`, as before.)
5. The list shows rule 1's time on each conversation that has one:
   right-aligned in the full list, under the name in the strip. In a full
   list too narrow for the title (at least 48 px) and the time side by side,
   the time goes on a line of its own, still right-aligned. It is not part
   of the entry's accessible name (which would change every second), but of
   its description: the last line, then "running for 2:16".
6. Times are `m:ss` under an hour and `h:mm:ss` from an hour, whole seconds
   rounded down, in tabular digits; a negative time is `0:00`.
7. The times advance every second without drawing the page again
   (`src/times/turn-ticker.ts`): one timeout for all shown timers, set for
   the next moment one of them reaches a whole second; only the timers'
   text changes. A new offset writes them at once.

| Case                                                             | Bar                      | List         |
| ---------------------------------------------------------------- | ------------------------ | ------------ |
| No turn, no duration                                             | `ready`                  | —            |
| Turn starting (`starting`, started just now)                     | `working · 0:00`         | `0:00`       |
| Running for 2 min 16 s                                           | `working · 2:16`         | `2:16`       |
| One second later                                                 | `working · 2:17`         | `2:17`       |
| Ended, with a duration of 42 s                                   | `ready · last turn 0:42` | —            |
| Ended without a duration (nothing reached the model)             | `ready`                  | —            |
| Status still `running` a moment after the end, with its duration | `ready · last turn 0:42` | —            |
| Status `running` without either time (older listener)            | `working…`               | —            |
| Reopened after a listener restart (stopped, no times)            | `ready`                  | —            |
| Offline, last known running                                      | `working…`               | —            |
| Reconnected, before the new snapshot                             | `working…`               | —            |
| After the new snapshot, still running                            | `working · ` the time    | the time     |
| After the new snapshot, ended while offline                      | `ready · last turn m:ss` | —            |
| Listener's clock 5 min ahead of the browser's, running 2:16      | `working · 2:16`         | `2:16`       |
| Listener's clock 5 min behind the browser's, running 2:16        | `working · 2:16`         | `2:16`       |
| No `listenerTime` (older listener), same clocks, running 2:16    | `working · 2:16`         | `2:16`       |
| Start later than the listener's now (clocks disagree)            | `working · 0:00`         | `0:00`       |
| Running 59:59, then one second later                             | `59:59`, `1:00:00`       | the same     |
| Running 10 h 5 min 3 s                                           | `working · 10:05:03`     | `10:05:03`   |
| Turn timers off, running                                         | `working…`               | —            |
| Last turn duration off, ended with a duration                    | `ready`                  | —            |
| Two conversations running                                        | the shown one's          | each its own |

### Message timestamps

Rule (`src/times/message-time.ts`):

1. A message with `createdAt` shows when it was written, right-aligned on
   its heading line ("You", "Pi"); a message without shows nothing (no time
   is invented), and none shows while the Message timestamps switch is off.
   Tool groups have no heading line of their own and show none. A
   `createdAt` that is not a number, negative, or beyond what a date can
   hold shows none either.
2. The time is the reader's: `createdAt - offset`, in this browser's time
   zone (the listener's zone plays no part), compared with this browser's
   today.
3. Today `HH:MM` (24-hour); yesterday `Yesterday HH:MM`; any other day
   `18 Nov 14:02`, with the year for another year (`3 Dec 2025 09:15`).
   Days are calendar days in the reader's zone (so a 23- or 25-hour day of a
   daylight saving change makes no difference).
4. A message keeps its time while it is updated (streaming text, a queued
   message starting): the listener keeps its `createdAt`.
5. The bridge puts the text into the chat page's rows (`ChatRow.time`, see
   [changes to the shared chat page](#changes-to-the-shared-chat-page)) and
   sends the rows again (only those that changed) when the switch changes,
   when the offset changes and when a new day starts here. The moment the
   next day starts is found on the calendar itself (the first minute after
   now on another date, looked for in order around the wall clock's
   midnight), so a daylight saving change around midnight (a skipped or a
   repeated hour) does not move it; it is taken again with each new offset (this browser's clock may
   have been corrected), and checked at least every hour. The other two
   Display switches do not send the rows again. Any change the page hears
   of on another date than the shown times were made on (a timeout that
   came late, a computer that slept) sends them again too. A publication
   made only for the times is not sent
   when no row's text changed, so the offset's millisecond changes with
   every state message do not draw the chat again.

| Message written (reader's clock)                                | Reader's now         | Shown              |
| --------------------------------------------------------------- | -------------------- | ------------------ |
| 20 Nov 2026 14:02                                               | 20 Nov 2026 16:00    | `14:02`            |
| 19 Nov 2026 16:48                                               | 20 Nov 2026 16:00    | `Yesterday 16:48`  |
| 18 Nov 2026 14:02                                               | 20 Nov 2026 16:00    | `18 Nov 14:02`     |
| 3 Dec 2025 09:15                                                | 20 Nov 2026 16:00    | `3 Dec 2025 09:15` |
| 19 Nov 2026 23:59                                               | 20 Nov 2026 00:00:30 | `Yesterday 23:59`  |
| 20 Nov 2026 00:00                                               | 20 Nov 2026 00:00:30 | `00:00`            |
| 31 Dec 2025 22:00                                               | 1 Jan 2026 08:00     | `Yesterday 22:00`  |
| Listener's clock 2 min ahead; its `createdAt` 14:04             | 20 Nov 2026 16:00    | `14:02`            |
| Listener's clock 2 min ahead; its `createdAt` 00:01 on the 20th | 20 Nov 2026 08:00    | `Yesterday 23:59`  |
| The same moment, reader in Tokyo, listener in Amsterdam         | (Tokyo)              | Tokyo's time       |
| 28 Mar 2026 12:00, Amsterdam (the day before summer time)       | 29 Mar 2026 12:00    | `Yesterday 12:00`  |
| No `createdAt` (saved by an older version)                      | any                  | nothing            |
| `Number.MAX_SAFE_INTEGER` (beyond a date)                       | any                  | nothing            |
| Message timestamps off                                          | any                  | nothing (no field) |
| A streaming answer updated ten times                            | any                  | its first time     |

## Tool details, screenshots and the model picker

Three things the desktop sidebar offers, with the desktop's look and rules.
Each uses the phone panel's requests through its `Store` and `Connection`:
`agent-tool-page`, the authenticated screenshot route, `agent-models`,
`claude-models` and `set-agent-model` (see the
[gateway README](../../src/remote/README.md)).

### Tool details

A tool-group row opens and closes its details in place, as the desktop's
classic view does (`../panel/ToolDetails.qml`, ported in
`src/tools/tool-details.ts`). The bridge sends each tool row an optional
`tools` field (see [changes to the shared chat page](#changes-to-the-shared-chat-page)),
and the page draws what it says and reports the reader's actions.

The rule:

1. A closed group shows only its heading (`▸ 3 tool calls`, with `·
running` or `· failed or stopped`) and asks for nothing.
2. Opening it asks for the first page of its first call
   (`agent-tool-page`, index 0, offset 0, with the conversation's ID and
   tool epoch and the group's revision) and says "Loading tool details…".
3. A page holds at most 8,192 characters of one call: its name, input and
   output, as plain text (the listener's bound). Its status line says which
   call and characters it shows (`Tool 2 of 3 · running · characters
1–8192`). Next page continues in the same call (naming the call's
   revision, so another call's text never follows) and then with the next
   call; From start goes back to the first page; Refresh page loads the
   shown page again; Copy page copies it. A page replaces the one shown.
4. One request per group at a time; the actions wait while it is on its
   way. A failure (the listener's refusal in its words, a lost answer, or no
   answer within 10 s) is shown with **Try again**, which asks again for the
   page that failed: the same call and offset, read afresh with the group's
   current revision (without the call revision a Next page named, which the
   listener would refuse again if the call changed meanwhile). Nothing is
   retried by itself.
5. While the turn runs and more calls arrive, the group's count follows and
   the page shown stays, with "New tool output is available. Refresh this
   page to update it." above its status line.
6. Only the latest request's answer is applied, and only to the
   conversation lifetime (ID and tool epoch) and group it was asked for.
   Switching to another conversation closes every open group (also when the
   reader comes back), as on the desktop; a conversation closed and reopened
   under the same ID is another lifetime: its groups start closed and the old
   answers are dropped.
7. Losing the connection clears every open group's page and says
   "Disconnected. Reload after reconnecting."; after reconnecting (once the
   new snapshot arrived) the group offers Try again, which asks for the page
   that was on its way, had failed or was shown, and loads only when the
   reader asks.
8. A tool row without stored calls (an old single tool message) opens to its
   own input and output, without a request.

A group in an older page loaded while scrolling up opens too: the listener
looks its calls up in the conversation's whole transcript, as long as the
lifetime and the group's revision are still the ones the page has.

`test/shell/tool-details.test.ts` plays the rule's table through the real
bridge with a stand-in Store: closed; opening; loaded one page; more pages
(next page in the call, the next call, From start); failed and retried
(also a refused continuation, read afresh);
opened while the turn still runs and more calls arrive; the conversation
switched and back; closed and reopened under the same ID; disconnected while
loading and back; plus closing an open group, a row without stored calls and
the deadline (also on a later page, which Try again asks for again, also
after a reconnect). `test/shell/details-browser.test.ts` opens a group in the real
page against the gateway and listener and pages through it.

### Screenshots

A message whose screenshot the listener kept shows the desktop's View
screenshot control; choosing it shows the image over the page
(`src/screenshots/`), scaled down to fit, with the conversation's title and
a close button.

The rule:

1. **Kept**: the message's screenshot was saved and the gateway put its
   authenticated route (`api/screenshots/<conversation>`) in place of the
   listener's file URL. Only that exact route is used (`screenshotPath` in
   `src/rows.ts`); the heading says "screenshot attached" and View
   screenshot is offered.
2. **Not kept** (capture storage was off: "screenshot not saved"), or no
   route ("screenshot unavailable"): today's text, no control.
3. Opening shows "Loading screenshot…", then the image. The rest of the page
   is inert meanwhile; Tab stays in the viewer.
4. **Removed since the message was drawn** (the gateway answers 404): the
   viewer says "Companion no longer has this screenshot." and the row then
   shows "screenshot unavailable" without the control, for that
   conversation lifetime. The gateway grants a connection a screenshot when
   it relays the screenshot's route on that connection, so a 404 counts as
   removed only for a fetch asked and answered on the same connection after
   its snapshot arrived, for a row of the live window (which that snapshot
   relayed). Otherwise (asked before the snapshot, answered on a newer
   connection, or a row of an older page kept from an earlier connection,
   as after a gateway restart) it is shown like a lost connection (rule 6),
   with Try again.
5. **Fetch refused** (401, 403 or another refusal): "Companion did not allow
   this browser to load the screenshot.", no Try again.
6. **Disconnected** (the gateway cannot be reached, or a server error): "Could
   not load the screenshot. Check the connection and try again." with Try
   again. An answer the browser cannot show as an image: "The screenshot
   could not be shown.", with Try again.
7. **Closed** by its × button, by Escape or by a click outside the image
   (beside it or on the backdrop), and by browser Back. Focus returns to
   where it was (View screenshot), or to the bar's heading when that control
   is gone (rule 4). Closing aborts a request on its way.
8. **A second one opened** replaces the first: its request is aborted and its
   image revoked. The viewer also closes when another conversation or
   lifetime is shown, and on sign-out.

**How the request is authorised, and why nothing leaks.** The image is
fetched with `fetch()` from the gateway's own origin, with the device token
in the `Authorization: Bearer` header, `credentials: 'omit'`, `cache:
'no-store'` and `referrerPolicy: 'no-referrer'` (`fetchScreenshot` in
`../mobile/src/screenshots.ts`, shared with the phone panel). Its address is
the bare route, without the token or any query. The image is shown from a
`blob:` address made from the answer, which holds only the image and works
only in this document; it is revoked as soon as the image element has
loaded it (the element keeps showing what it decoded), and otherwise when
the viewer closes or shows another one. So:

- **No URL carries the token**: neither the request's address nor the
  image's. The image's address leads nowhere once the image is shown, so
  opening it in another tab or copying it gets nothing, and never a
  credential.
- **No cache**: the gateway answers `Cache-Control: private, no-store`, and
  the request asks for no caching too.
- **No referrer**: the gateway sends `Referrer-Policy: no-referrer`, the
  request sets it as well, and the request goes only to the page's own
  origin.
- **No history**: the page's address never changes; the viewer's history
  entry (so that Back closes it, the phone panel's `Modal`) holds only a
  number.
- **No storage**: nothing about the screenshot is written to
  `localStorage` or `sessionStorage`.

The gateway's Content-Security-Policy is unchanged: `img-src 'self' blob:`
already allows the image.

`test/shell/screenshot-viewer.test.ts` plays the rule's table (kept; its
address revoked once loaded; not decodable; not kept; removed since drawn;
a 404 before the connection was admitted, answered on a newer connection,
or asked again once admitted; fetch refused; disconnected; closed; a second
one opened) against the viewer's state and the row data, with the bridge's
checks. `test/shell/details-browser.test.ts` opens a kept screenshot in the
real page, closes it each of the three ways with focus back on View
screenshot, checks that the image requests' addresses are exactly the bare
route, that the image's `blob:` address is revoked while it is shown, that
the page's address and storage are unchanged, and that a screenshot deleted
on the listener's side ends as "screenshot unavailable" with focus on the
bar's heading.

### Model picker

In the bar above the chat, next to the conversation's state, a button names
the model its next turn uses; it opens the desktop footer's picker
(`../panel/ModelPicker.qml`, rules in `src/models/model-choice.ts`) below
the bar.

The rule:

1. **Pi conversations**: the button names the conversation's own choice;
   without one, the profile's default once the list was read, else the model
   of its last turn. The picker offers "Use coding default · <model>" (or
   quick-question), which clears the conversation's choice, then the pinned
   models (Show all models lists every model). A choice the list no longer
   has is still shown, marked "(unavailable)".
2. **Claude Code conversations**: the listener's Claude models, the
   configured default marked; the conversation's own model is always
   listed. Its effort is fixed ("Effort · high · fixed. Same Claude history;
   effort stays as it started."), as the listener decides: a Claude Code
   conversation's model can change for its next turn, its effort cannot.
3. **Idle and running**: a choice applies to the next turn, and the listener
   accepts it while a turn runs, so the picker offers it then too.
4. The list is read when the reader first opens the picker (`agent-models`
   or `claude-models`, kept in the Store), not for every conversation shown.
   Until it has loaded (or failed) nothing can be chosen. **The list fails to
   load**: its failure is shown with ↻, and the profile default (Pi) or the
   conversation's own model (Claude Code) can still be chosen, as on the
   desktop.
5. A choice sends `set-agent-model` for this conversation; one at a time
   ("Changing the model…"; the list keeps keyboard focus meanwhile and only
   says it is unavailable). **The change is refused**: the listener's
   words, and the picker shows the conversation's model again. If the
   picker was closed meanwhile (or the reader moved on), the refusal is a
   toast. An answer that arrives after signing out (or a new pairing) is
   dropped.
6. **Changed elsewhere** (the desktop, a phone): the conversation's next
   update shows it here, in the button and the picker.
7. Nothing can be chosen while not connected (after reconnecting, once the
   new snapshot arrived).
8. **No conversation shown** (Previous sessions, nothing selected) and **the
   settings screen open**: the bar has no picker. The picker belongs to one
   conversation lifetime: another conversation starts with it closed.
9. Keyboard: the button opens and closes it (Enter, Space); Tab moves
   through its controls; the model list is a native select; Escape closes it
   wherever the focus is and returns focus to the button. A click outside closes it, and so does
   keyboard focus moving on to another control of the page. At 420 px it
   stays inside the window.

`test/shell/model-choice.test.ts` plays the rule's table for the data it
shows (Pi and Claude Code, idle and running, a quick question, an unlisted
choice, changed elsewhere, the list not read yet, loading or failed, a
change on its way, not connected). `test/shell/details-browser.test.ts`
covers the rows that need the page against the real gateway and listener:
opened by keyboard, Show all models, a change during a running turn reaching
the listener, a refusal shown, Escape with focus back, a refusal arriving after
the picker was closed (a toast), Tab out of the picker closing it, a change made
elsewhere appearing, the settings screen and Previous sessions without a
picker, and a Claude Code conversation's models and fixed effort.

Known limit: the picker keeps its "change on its way" state while it is
drawn. Leaving the conversation for the settings screen and coming back
while a change is still on its way draws it anew, so a second choice can be
sent then. If the two changes overlap at the listener, it refuses the
second ("its model/effort is already being changed") before changing
anything, and the picker shows that refusal.

The same file checks the layout with an open tool group, the open picker and
the viewer at 420, 1280 and 1600 px: no horizontal overflow, the picker and
the image inside the window. With `COMPANION_SHELL_SCREENSHOTS` set it saves
screenshots of each.

## Inline widgets

Agents can show **widgets**: small interactive pages under a message. The
gateway serves each widget's page to a paired browser on its own origin, the
**frame origin**, and sends the browser that page's address as
`widget.frameUrl` (`<frame origin>/f/<handle>/`) when it is configured with
one ([gateway README](../../src/remote/README.md#widget-and-application-frames));
without it the browser receives no address. Pinned widgets, session
applications, permission controls and a Settings → Widgets page are not part
of this step. The phone panel (`integrations/mobile`) keeps its placeholder
card.

A message with a widget is drawn by the shell's own component
(`src/widgets/InlineWidget.tsx`): the bridge gives every widget row a
`frameUrl` (the gateway's address when it is valid, else '') and offers the
component, and the chat page uses it for such rows (see
[changes to the shared chat page](#changes-to-the-shared-chat-page)):

- **With a frame address**: directly under the agent's message, a rounded
  panel as wide as an agent message (the chat's whole width less the
  gutter opposite the sender, like the other messages) with a small header,
  🧩 and the widget's name (and, at its right, the message's time while
  Message timestamps is on, as on message headings), above the widget's
  page in an iframe:
  `sandbox="allow-scripts allow-same-origin allow-forms"` (no popups, no top
  navigation, no modals), an `allow` attribute that grants no feature and
  explicitly denies camera, microphone, geolocation, clipboard, payment,
  USB, serial, Bluetooth, display capture, fullscreen and autoplay
  (features it does not name keep the browser's default for a frame of
  another origin, and the page's own Permissions-Policy denies camera,
  microphone and geolocation to every frame), `referrerpolicy="no-referrer"`
  and `loading="lazy"`. The frame is
  on another origin than the shell, so `allow-same-origin` gives it only its
  own origin's storage, never the shell's. The address is used exactly as
  the gateway sent it.
- **Without one** (no frame origin configured): a small card with the same
  header and one line, "Widgets are not set up for this browser, so only
  the widget's name is shown." No frame, no request.

The widget row's own text (the widget's `describe()` fallback, which the
desktop's classic view shows) is not drawn: the frame shows the widget
itself, and the agreed design has no text there.

**Height.** The frame is as tall as the widget's content within the
desktop sidebar's bounds for an inline widget (`WidgetSurface.qml`:
`minimumFitHeight` 100 and `maximumFitHeight` 420 theme units), here
100–420 px (the shell's theme unit and text scale are 1). Taller content
scrolls inside the frame. Until the first height arrives the frame is 100 px
tall, or as tall as the same address was last shown in this page.

### Rule: frame states

Rule (`src/widgets/frame-state.ts`, drawn by `src/widgets/InlineWidget.tsx`):

1. A widget message without a valid frame address (absent, or not exactly
   `http(s)://host[:port]/f/<43 base64url characters>/` without user,
   query or fragment) shows the **not set up** card.
2. A widget message with one shows the panel with its frame **loading**: the
   frame shows "Loading the <name> widget…" over it and takes no input
   (keyboard focus included) until it is shown.
3. It is **shown** at the frame's first `geometry` message. host.js sends the
   first one only after the widget drew its first state.
4. It has **failed** when the frame sends `error` before it was shown (the
   widget's first state could not be drawn), or when no `geometry` arrived
   within 10 seconds during which the frame was visible (see the visibility
   rule; a frame out of sight may not be drawn by the browser at all, so the
   10 seconds start again each time it becomes visible). A view whose
   handle ended (the gateway answers 404 for its page) never reports and
   fails this way. The panel then shows "The <name> widget could not load.",
   the reason (the frame's error text, or "Its page did not answer within
   10 seconds."), "The conversation and the widget's saved data are
   unchanged." and **Try again**. When the page's own policy refused the
   frame (the gateway's frame origin was set up or changed after this page
   was loaded, so its `frame-src` does not name it), it fails at once with
   "This page was opened before widgets were set up for it. Reload the page
   to show them."; Try again cannot help there, a reload does. The frame is removed, so it makes no
   requests. Try again creates a new frame for the same address (loading).
5. An `error` after the widget was shown changes nothing here; host.js shows
   it inside the frame, as on the desktop.
6. **Disconnected**: while the shell's requests are not admitted (offline,
   reconnecting, or reconnected before the new snapshot), a shown frame is
   greyed with "Disconnected · reconnecting…" over it, takes no input and
   is told it is not visible (so it stops polling). Its state is kept and
   its deadline paused. A frame that was not shown yet (also one opened
   while disconnected, or one that was loading when the connection went) is
   not in the page meanwhile: the panel keeps its height with the same
   label, nothing loads, and a new frame loads once requests are admitted.
   Try again is unavailable while disconnected.
7. Back with the **same address** (the device's handles lived on): the frame
   continues where it was, without loading again. A polling failure it
   showed in its own status line meanwhile (the network went before it was
   told it is not visible) goes once its polling works again (host.js,
   embedded only; on the desktop the line stays as before), unless
   something else wrote the line since (an action's error stays, even with
   the same text). Back with a **new
   address** (the handles ended, for example the gateway restarted): the row
   changes, the old frame is removed and the new address loads.
8. A **conversation switched and back**: the frame goes with the chat and
   loads again when the conversation is shown again, at the height it last
   had in this page (heights of the last 100 addresses are kept in memory).
9. The **widget removed from the message**: the panel and its frame are
   removed; the message is drawn as text.
10. **Two widgets in one conversation**: each has its own panel, frame, state
    and messages; nothing one frame sends reaches the other's panel.

| Case                                                   | Shown                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| No `frameUrl`, or one of another shape                 | Not set up card, no frame                                                                                 |
| `frameUrl`, nothing reported yet                       | Panel, frame loading under "Loading the <name> widget…"                                                   |
| First `geometry` 180                                   | Shown, 180 px                                                                                             |
| `error` "boom" before any `geometry`                   | Failed: "The <name> widget could not load. boom", Try again                                               |
| No `geometry` within 10 s visible (also: upstream 404) | Failed: "… Its page did not answer within 10 seconds.", Try again                                         |
| The page's policy refuses the frame (set up later)     | Failed at once: "… This page was opened before widgets were set up for it. Reload the page to show them." |
| 10 s pass while out of view, then 9 s in view          | Still loading                                                                                             |
| Try again                                              | A new frame, loading; shown at its first `geometry`                                                       |
| `error` after shown                                    | Still shown                                                                                               |
| Connection lost                                        | Greyed, "Disconnected · reconnecting…", no input, `visible: false`                                        |
| Conversation opened while disconnected                 | No frame in the page (nothing loads) until admitted, then loading                                         |
| Back with the same address                             | The same frame, shown, `visible: true`; not loaded again                                                  |
| Back with the same address after a failed poll         | The error line inside the frame goes at the next successful poll                                          |
| Back with a new address                                | New frame for the new address: loading, then shown                                                        |
| Conversation switched and back                         | Loads again, at its last height until its first `geometry`                                                |
| Widget removed from the message                        | Message as text, frame removed                                                                            |
| Two widgets, one reports 300                           | Only that panel is 300 px tall                                                                            |

### Rule: messages between the shell and a frame

Rule (`src/widgets/frame-messages.ts`, `src/widgets/height-throttle.ts` and
`integrations/widgets/host.js`):

1. Frame → shell, exactly these fields: `{"type":"geometry","height":N}` (the
   widget's content height in CSS pixels) and `{"type":"error","text":"…"}`
   (its first state could not be drawn).
2. Shell → frame, exactly these fields:
   `{"type":"theme","theme":{"foreground":"#rrggbb","background":"#rrggbb","accent":"#rrggbb","muted":"#rrggbb","scale":1}}`
   and `{"type":"visible","visible":true|false}`. Nothing else is ever
   posted to a frame: no device token, conversation ID or other value.
3. The shell acts on a message only when its `source` is that panel's own
   iframe window and its `origin` is exactly the origin of the panel's frame
   address, and when it has exactly one of the two shapes. Anything else is
   ignored: another window (the shell itself, the widget's inner frame,
   another panel's frame), another origin, extra or missing fields, another
   type, a height that is not a finite number, a text that is not a string.
4. A `geometry` height is rounded and clamped to 100–420 px (negative to
   100, huge to 420). The panel applies at most one height per 100 ms: the
   first at once, then the last one received in each interval; equal
   heights are not applied again. An `error` text is cut to 200 characters.
5. The shell posts to a frame only after its `load` event, with the frame
   origin as the target origin: `theme` (the chat's own colours, scale 1)
   and `visible` at each load, then `visible` when it changes.
6. host.js talks to its parent only when its page came from the socket route
   (`bootstrap.api` is the marker `location`) and is framed: the browser
   shell. It accepts messages only from `window.parent`, only `theme` (four
   `#rrggbb` colours and a scale within 0.4–6) and `visible` (a boolean),
   with exactly those fields, as plain objects (not arrays); everything else
   is ignored. Embedded, it does not poll until the shell's first
   `visible: true`. It posts with the
   target origin `*` (it cannot know the shell's origin: the shell frames it
   without a referrer), which reveals nothing: `frame-ancestors` lets only
   the gateway's pages frame it, and the messages carry only a height and
   an error text. On the loopback route (the desktop panel and the pop-out)
   it installs no listener for its parent and posts nothing to it.
7. A message from a frame that is not loaded yet is checked like any other
   (its window is the panel's frame); a message that arrives after its frame
   was removed (or replaced by Try again or a new address) is ignored: its
   panel's listener is gone or its window is no longer the panel's frame.

| Case                                                   | Result                                                   |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `geometry` 180 from the frame, frame origin            | Applied: 180 px                                          |
| `error` "boom" from the frame before shown             | Failed with "boom"                                       |
| `error` with a text of 1,000 characters                | Its first 200 characters shown                           |
| `geometry` from the shell's own window                 | Ignored                                                  |
| `geometry` from the widget's inner frame (`top`)       | Ignored                                                  |
| `geometry` from another panel's frame                  | Ignored by this panel                                    |
| `geometry` from the frame's window, another origin     | Ignored                                                  |
| `geometry` with an extra field, or `height` a string   | Ignored                                                  |
| `geometry` `NaN` or `Infinity`                         | Ignored                                                  |
| `geometry` −50 / 0 / 99.6 / 5000                       | 100 / 100 / 100 / 420 px                                 |
| 1,000 `geometry` messages in one burst, last 410       | The first at once, then at most one per 100 ms; 410 last |
| A message before the frame's `load` event              | Checked like any other                                   |
| A message after the frame was removed                  | Ignored                                                  |
| host.js: `visible` false from the parent               | Polling stops                                            |
| host.js: `theme` with `"red"` or a scale of 50         | Ignored                                                  |
| host.js: any message from another window               | Ignored                                                  |
| host.js: an array with `type` and `visible` properties | Ignored                                                  |
| host.js embedded, before the first `visible`           | No polling                                               |
| host.js on the loopback route, framed or not           | No listener for its parent, nothing posted to it         |

### Rule: visibility

Rule (`src/widgets/frame-visibility.ts`): a frame is **visible** when its
panel is in view (it intersects the window after the transcript's
scrolling clipped it), the browser tab is not hidden, the chat is not
covered by this page's own screens (the settings screen, or the Activity
column lying over the chat in a narrow window; `src/widgets/chat-cover.ts`)
and the shell's requests are admitted. The shell tells the frame when this
changes. The widget page polls its state every 400 ms only while it is
visible (host.js; a hidden tab stopped it before as well), and only after
the shell first said it is visible, so a frame the reader cannot see
starts no polls (a poll already on its way still completes, and the
browser's lazy loading may fetch the page of a frame near the view before
it is visible). A conversation that is not shown has no frames at all.

| Case                                   | Visible | Polls                           |
| -------------------------------------- | ------- | ------------------------------- |
| In view                                | yes     | yes                             |
| Scrolled out of view                   | no      | no, until scrolled back         |
| Hidden tab                             | no      | no, until the tab is shown      |
| Behind the settings screen             | no      | no, until the settings are left |
| Behind the narrow Activity overlay     | no      | no, until the column is hidden  |
| Activity beside the chat (wide window) | yes     | yes                             |
| A different conversation shown         | —       | no (the frame is removed)       |
| Disconnected                           | no      | no, until admitted again        |

### Rule: scrolling over a widget

A wheel or a finger over a widget goes to the widget's page, in another
process; when that page cannot scroll any further, the browser scrolls the
transcript instead, and neither the chat page nor the shell sees the
reader's input. The chat page would take such a scroll for a layout change
and, at the live end, pull the view straight back. So while at least one
widget frame is in the transcript (`src/widgets/frame-scroll.ts`), a scroll
of the transcript toward its start, with the transcript's height and its
content's height unchanged since the previous scroll event (or size
change), counts as the reader's: the shell sends the chat page a synthetic
`wheel` on the transcript before the page's own scroll handler runs, which
is how the page notes the reader's input. A panel watches only while its
frame is in the page (not after it failed, nor while it waits for the
connection). Layout changes that move the
view change one of the heights; the chat page's own scrolls toward the
start happen only then. A chat without widgets is not watched.

| Case                                                     | Reader's scroll |
| -------------------------------------------------------- | --------------- |
| Toward the start, heights unchanged (wheel over a frame) | yes             |
| Toward the end, heights unchanged                        | no (not needed) |
| The content shrank and the browser pulled the view back  | no              |
| The content grew, or the window was resized              | no              |

### Security

- **Policy.** The shell's Content-Security-Policy is the gateway's: with a
  frame origin configured it gains exactly `frame-src <frame origin>` from
  the gateway ([headers rule](../../src/remote/README.md#rules-headers)).
  This step changes neither the gateway nor its policy; the shell's frames
  load only from that origin.
- **Nothing given to a frame.** The shell puts nothing into a frame's
  address (it is used exactly as the gateway sent it) and posts only
  `theme` and `visible` (rule above). The frame's origin differs from the
  shell's, so it cannot read the shell's `localStorage` (the device token),
  its DOM or its socket.
- **Layout.** A frame changes only its own height, within 100–420 px and at
  most ten times a second; a hostile `geometry` (negative, huge, not a
  number, at a high rate) is clamped or ignored. It cannot move, resize or
  cover anything else, open popups or navigate the shell.
- **WebRTC.** Widget code (the innermost sandboxed frame) could open an
  `RTCPeerConnection` and send STUN/ICE packets anywhere, because Chromium
  does not enforce CSP `webrtc 'block'`. host.js now makes
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `mozRTCPeerConnection` and
  `WebTransport` undefined (and not redefinable) in the inner document with
  a script that runs before frame.js loads the widget's code, on both routes
  (pop-out and browser alike); the desktop's native widget view already
  does the same in every frame (`NativeWidgetView.qml`, same list). It is a
  `data:` script: the inner document inherits host.js's own policy as well,
  which allows no inline scripts. The inner document's policy
  (`frame-src 'none'`) and the sandbox (no popups) leave widget code no
  fresh window to take the constructors from (checked in Chromium: a child
  frame it creates is not reachable, `window.open` returns null). No
  bundled widget uses WebRTC. `src/remote/README.md` still describes the
  gap as open; this step does not change files under `src/`.
- **Residual risk** (unchanged from the frame origin's design): a frame on
  another port of the same host name is the same site, so a renderer
  exploit in a widget could reach the shell's process; see the gateway
  README.

### Known limits

- **Older pages after a long disconnection.** A widget in an older history
  page the reader has loaded (above the live window) keeps the frame
  address it was loaded with. When the shell was disconnected for more than
  the gateway's 30-second grace period, that address has ended, and the
  widget shows its own "Not found" error inside the frame (host.js's status
  line) instead of updating. Jump to latest and scrolling up again, or
  reloading the page, loads the page again with a new address. Widgets in
  the live window get their new address with the new snapshot. Refreshing
  the resident older pages after a reconnect would need new logic in the
  paging model (its existing refresh detaches the reader's view), so it is
  left for later.

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
  session → `close-agent`, history → `agent-history-page`, tool details →
  `agent-tool-page`. These are all in
  the gateway's remote allowlist (`src/remote/protocol.ts`); besides them
  only the phone Store's own `panel-state` selection report, the
  Activity column's requests (see [Activity](#activity)) and the settings
  screen's `toggle-sounds` and `set-intent-enabled` (see
  [listening switches](#listening-switches)) and the model picker's
  `agent-models`, `claude-models` and `set-agent-model` leave the page,
  and the screenshot viewer's authenticated image request. The
  Store reads this run's Activity history (`activity-history`), as on the
  phone.
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
- Refused over a connection limit, the page shows the limit page instead of
  retrying (see [the limit page](#the-limit-page)).
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

### The limit page

The gateway admits 8 remote connections, at most 4 per paired device (a
browser's tabs count for its device), and refuses a newcomer with close code
4429 and the reason `device` or `total` (see
[Limits](../../src/remote/README.md)). Rule (the phone Connection,
`integrations/mobile/src/connection.ts`, shared with the phone panel):

1. Refused with reason `device`, the page says: "This browser already has
   four Companion tabs connected. Close one you do not need, then Retry."
2. Refused with reason `total`, it says: "Companion already has eight
   browsers and phones connected. Close one you do not need, then Retry."
3. The limit page lies over the whole page with a Retry button (focused).
   The page underneath stays as it was, inert. Nothing reconnects by itself
   while it is shown: not after a delay, not when the tab becomes visible,
   not when the network returns. No other tab is closed, and the page names
   no other device.
4. Retry tries once. Admitted, the page continues as after any reconnect
   (the new snapshot, then the visible report). Refused again, the limit
   page shows again. If the network is down at that moment, the page shows
   "offline" and reconnects when the network returns, as before.
5. A refusal with code 4429 and any other reason, or none (an older
   gateway), keeps the earlier behaviour: "Too many phones are connected.
   Retrying…" and a retry with backoff.

| Case                                                                     | Result                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Fifth tab of one browser (reason `device`)                               | the limit page with the `device` text and Retry                      |
| Ninth connection in all (reason `total`)                                 | the limit page with the `total` text and Retry                       |
| 4429 with an unknown reason or none                                      | the banner "Too many phones are connected. Retrying…", retried       |
| Limit page shown; time passes, the tab is hidden and shown, network back | no new connection                                                    |
| Refused (named) while the browser already reports itself offline         | the limit page; the network's return reconnects nothing              |
| Retry after another tab was closed                                       | connected; the limit page goes                                       |
| Retry while the limit still holds                                        | refused again; the limit page shows again                            |
| A second tab opened while the limit page is shown                        | that tab is refused too and shows its own limit page; nothing closes |

`test/shell/limit-page.test.ts` plays the table: the reasons and the
automatic-reconnect rows against the real Connection in Node with a stand-in
socket (the Connection is the phone panel's too), and the fifth tab, the
second tab, Retry and the `total` limit in headless Chromium against the
real gateway for the shell. `test/mobile/limit-and-unread.test.ts` checks
the phone panel's limit page in the browser (the fifth tab, Retry after a
tab closed, the `total` limit).

Known limit: if the browser reports going offline just before the named
refusal arrives, the page treats it as a network loss and makes one more
attempt when the network returns; if the limit still holds, that attempt is
refused and shows the limit page.

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
set itself; the browser's pull-back is the one scroll toward the start after
which the scroll range did not grow and the view sits at its new end, having
either been beyond it or moved less than a pixel (`pulledBack` in
`Chat.tsx`; positions can be fractional, sizes are whole pixels). "Within
one viewport" includes exactly one viewport. No input events are interpreted for paging, so
a touch pan (which the browser reports as pointerdown, pointercancel and then
scroll events only) counts like any other scroll. The bridge answers `newer`
with the next page below the snapshot, or joins the live rows when the
snapshot already ends where they start, and `older` with the previous page;
it sends nothing while a page is pending, after a failure (also when the
page has not shown that failure yet and the reader's scroll goes on), or at
a boundary the listener answered with an empty page.

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
there and asks for nothing), a scroll bar or a finger held still for more
than a second before scrolling away from it (it leaves the end), and one
touch gesture that pans to the live end, rests there and pans back without
lifting the finger (it leaves the end again). A detached snapshot shorter
than two viewports, where both edges are always near, is reached by
detaching at an ordinary size and then making the window very tall: a scroll
toward the end asks for the newer page, one toward the start for the older.
`bridge.test.ts` has the rule's decision (`pageToAsk`) as a table, a table
for `pulledBack` (fractional positions, a reader's 1- and 3-pixel scroll at
the very end, a reader landing 1 or 3 pixels before a new end, pull-backs
to a fractional end and by half a pixel), and checks that an arriving page
reaches the page as rows before the status that ends loading, while a failed
or refused page leaves a queued streamed edit to its 30 ms coalescing and
then delivers it, and that after a failed page only Retry asks again: the page never sees a
request settled while it still shows the previous rows, so a scroll that
continues meanwhile (a key's smooth scrolling, a fling) cannot ask for the
page after one it has not shown yet.

### Changes to the shared chat page

`Chat.tsx` is shared with the Qt host (`TrustedChatView.qml`). Six changes
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
   pressed in the transcript (for a finger, until it is lifted, also after
   the browser cancels its pointer to pan), and the end of such a press
   counts as input: a scroll bar or a finger held still for more than a
   second before moving used to be pulled back to the end. A scroll without input (a layout
   change) still keeps the page at the live end.
3. A row may carry one optional field, `time` (`protocol.ts`), the text of
   when the message was written; the page draws it as
   `<span class="message-time">` at the end of the message's heading line
   ("You" and "Pi" headings; not tool groups). Without the field the page's
   output is exactly what it was: the Qt host never sends it, so nothing
   changes there (`test/shell/chat-heading.test.ts` compares the page's
   HTML with a reference drawn before the change). The shell's stylesheet
   aligns it right; `ChatState.mjs` and QML are unchanged.
4. A tool row may carry one optional field, `tools` (`ChatToolDetails` in
   `protocol.ts`): whether the group is open, its status line, the page's
   text and which actions are offered. With it, the row's heading opens and
   closes the details in place (`aria-expanded`) and the page draws them
   (`ToolGroup` in `Chat.tsx`), reporting the reader's actions through one
   optional bridge method, `toolDetails(sessionId, key, action)`. Without
   the field the row is exactly as before: its heading opens the classic
   view. The Qt host sends neither, so nothing changes there
   (`chat-heading.test.ts` again compares with the reference drawn before
   the change). The shell's stylesheet styles the details.
5. The status may carry one optional field, `classicView` (`protocol.ts`):
   `false` hides the composer's Classic view button, as the browser has no
   classic view (the bridge sends it). Absent (or `true`) the page draws
   exactly what it drew before: the Qt host never sends it
   (`chat-heading.test.ts` compares the composer, for several statuses, with
   `fixtures/chat-composer-reference.txt`, drawn by the base revision's
   `Chat.tsx`; with `false` only the button is gone). `bridge.classicView()`
   stays: a widget card's link still calls it and gets the notice (the
   browser shell itself draws widget rows with its own component, item 6).
6. A host may draw widget messages itself: a row's `widget` has an optional
   `frameUrl` and `NativeBridge` an optional `inlineWidget` component
   (`protocol.ts`). Only when a widget row carries `frameUrl` (an address,
   or '' for "not set up") and the bridge has the component does the page
   draw that row as `<div class="message assistant inline-widget-message">`
   around the component (one `.message` per row, as before) instead of its
   "shown in the classic view" card; the browser shell's bridge sends the
   field for every widget row ([inline widgets](#inline-widgets)). The Qt
   host sends neither, so its page is exactly as before:
   `test/shell/chat-heading.test.ts` draws every kind of row, a widget row
   included, without the field (with a host that has no `inlineWidget`,
   one whose every member is a function, and one with a component) and
   with it but without a component, and compares each with the reference
   drawn by the base revision; with the field and a component only the
   widget row differs. `ChatState.mjs` and QML are unchanged.

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
  host's order is QML and not changed here. For the same reason a scroll
  that goes on right after a failed page, before the page shows the error,
  can ask again there (`SessionView.loadOlder`/`loadNewer` clear the error);
  this was already so for older pages before this change. The browser bridge
  refuses both after a failure.

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
   touch screen the same with a finger resting before it pans, and with a
   finger that pans down to the end, rests there and pans back up without
   lifting); a scroll
   without input still keeps the view at the live end (the existing
   `test/session-apps-ui/surface.qml.in` case);
7. the classic view (unchanged QML) still pages as before, and the existing
   Qt suites (`npm run test:window`, `test/session-apps-ui/`) pass.

### Differences from the desktop chat

Shown as unavailable through the existing `status` fields, not by changing
the chat page:

| Desktop feature                           | In the browser                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Recording into the text box               | `recording.available: false` (no Record button)                                                                            |
| Listener-owned and agent-proposed drafts  | The draft is kept in this page per conversation, as on the phone; `draftUnsaved` is always empty                           |
| Classic view                              | No Classic view button (`classicView: false`)                                                                              |
| Widgets                                   | Inline widgets in the chat when the gateway has a frame origin ([inline widgets](#inline-widgets)); pinned widgets not yet |
| Tool details                              | In place, as in the classic view (see [tool details](#tool-details))                                                       |
| Session applications                      | `application: null`                                                                                                        |
| Screenshots                               | View screenshot opens the viewer (see [screenshots](#screenshots)); no zoom                                                |
| Voice target, voice hints, focus shortcut | `voiceTarget: false`, `voiceStatus` and `focusShortcut` empty; choices are clicked                                         |
| Model picker                              | In the bar above the chat (see [model picker](#model-picker)); no Pi effort picker                                         |
| Pop-out windows, Alt+number               | Not in the browser                                                                                                         |
| Alt+Shift+Up/Down                         | Move a focused list entry, as the ⋯ menu does (see the list)                                                               |

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
reader's own. The page itself requests nothing from another origin, except
inline widget pages from the gateway's frame origin when one is configured
(see [inline widgets](#inline-widgets)).

## Build, demo and tests

```sh
npm ci
npm run shell:build      # → integrations/shell/dist (index.html, app.js, app.css)
npm run shell:demo       # synthetic listener + gateway on http://127.0.0.1:8788 (frames on 8789)
npm run test:shell       # builds, then runs the unit and headless Chromium suites
```

The demo prints a pairing code; open the URL in a desktop browser and enter it.
A scripted backend streams Markdown, tool calls and choices; Activity has
synthetic entries of different kinds (typed, ignored, a started
conversation, audio only, not saved), listening starts paused for media, and
a new entry is heard every 40 seconds (six in all) to show the marker.
The gateway also runs a frame origin on the next port (`--frame-port N` picks
another), and the city-trip answer is followed by an inline packing-list
widget whose items can be ticked off; its actions run in the demo process
(`test/widget-node-renderer.ts`), not in the isolated widget renderer.
For the times, the invoice conversation was asked "yesterday" and continued
today (the listener's clock is set back by a day for its first turn only),
the flaky-test conversation's turn keeps running (its timer counts), and the
others show how long their last turn took. The bug-fix conversation has a
tool group (one call's output is long enough to page through), the city
trip kept its synthetic screenshot (View screenshot), and the bar's model
picker lists two Pi models. No
model, microphone, screen capture or personal data is involved. Ctrl+C stops
it and deletes its temporary directory, also while it is still starting (a
second Ctrl+C during the cleanup deletes the directory at once). `--port N`
picks another port.

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
it started, and checks that no temporary directory is left; and that the
demo's snapshot has exactly one widget, under the city trip, with a frame
address on its frame origin that serves the widget's page.

The [inline widget](#inline-widgets) rules have one table each:

- `inline-widget-rules.test.ts` (Node) plays the rows that need no browser:
  frame addresses of every shape, the page rows with and without the
  shell's component, the frame states (loading, shown, error before and
  after shown, deadline, Try again, nothing from a failed frame, the
  remembered height), every message case of the shell's side (source
  window, origin, fields, types, clamping, the 100 ms throttle with a
  controlled clock including a 1,000-message burst and removal while a
  height waits, the theme and visible messages) and the visibility table.
- `inline-widgets.test.ts` runs the built shell in headless Chromium against
  the frame fixture (`test/frame-fixture.ts`: a real gateway with a frame
  origin on a second loopback port, a real listener and widget service,
  synthetic widgets in `widget-page.ts` whose reducers run in Node): a
  widget inline at the width of the agent's message, its iframe's
  attributes, an action in it changing its state, the frame unable to read
  the shell's `localStorage`, the gateway's policy exactly its base plus
  `frame-src <frame origin>`, 420 and 1600 px without overflow; shown at
  the content height (and 420 at most), failed with the widget's own error
  and Try again loading a new frame, the probe widget seeing no
  `RTCPeerConnection` and no reachable child window; not set up without a
  frame origin (no frame, no request to another origin); an ended view
  (upstream 404) failing after 10 seconds in view; disconnected (greyed,
  inert, not visible), back with the same address without loading again
  and polling again, a conversation opened while disconnected loading
  nothing until admitted, and a new address after a gateway restart, loaded;
  hostile and malformed messages (out of bounds, not a number, extra
  fields, another type, from the shell's own window, from the widget's
  inner frame, from another panel's frame, an error after shown) and a
  1,000-message burst; a conversation switched (no frames, no polling) and
  back (loaded again at the remembered height); a widget removed from its
  message; and visibility: out of view at the live end, shown and polling
  when scrolled into view with the wheel, not visible and not polling when
  scrolled out, polling again when back, not visible behind the settings
  screen and behind the Activity column over the chat at 420 px; at the
  live end, a wheel over a widget's frame leaving the end and staying there
  (it was pulled back before); a page loaded before the gateway had a frame
  origin failing at once with the reload reason, and showing the widget
  after a reload; while disconnected only the frame inert, its label
  readable. The tests check
  that no request left the gateway's origin and the frame origin, and most
  that no policy violation occurred (not the late-setup case, which
  depends on one: the page's own `frame-src` refusal). With
  `COMPANION_SHELL_SCREENSHOTS=<directory>` it saves every state (loading,
  shown, failed, disconnected, not set up) at 420 and 1280 px.
- `widget-host.test.ts` takes widget documents from the real loopback and
  socket routes and frames them from a test page, with every window's
  `message` listeners counted from before any script runs: on the loopback
  route (at the top level, as the pop-out, and framed) host.js installs only
  its own frame's listener and posts nothing to its parent; from the socket
  route, framed, it adds the listener for the shell, posts only `geometry`
  with exactly its fields, stops polling on `visible: false` (counted at the
  test server) and resumes on `true`, ignores malformed `visible` and
  `theme` messages and messages from its own inner frame, applies a valid
  theme, and on both routes widget code sees none of `RTCPeerConnection`,
  `webkitRTCPeerConnection`, `mozRTCPeerConnection` and `WebTransport` in
  its own world, and cannot define them again.

`chat-heading.test.ts` also draws every kind of row without `frameUrl` with
three kinds of host and compares each with the reference, and with
`frameUrl` (an address and '') shows that only the widget row changes, and
only with a host component (see
[changes to the shared chat page](#changes-to-the-shared-chat-page)).

`layout.test.ts` and `reorder-gesture.test.ts` check the list's pure rules in
Node, each with the cases of its README table above: the remembered width and
hidden state (initial, invalid, dragged, keys, narrow windows, reload), the
entries' icons (also without `Intl.Segmenter`), changes from two tabs, and the
reorder gesture (every row of the reordering table, plus the drawn insertion
line). `move-steps.test.ts` has the moving table's request side (first,
middle and last × up and down, one conversation, not admitted, no
revision, a conversation no longer listed), checks each step against the
listener's own insertion, the keys (Alt+Shift+Up/Down and what is not), and
the one-move-at-a-time rule as sequences (accepted before or after the new
order arrives, refused, lost, a reset). `markers.test.ts` plays every row of the three markers tables
(marker source, visible report, fallback) against the real phone Store in
Node (with stand-ins for history, storage, page visibility and the socket),
read through the list's own derivation. `limit-page.test.ts` plays the limit
page's table: in Node against the real phone Connection with a stand-in
socket (each reason, an unknown or missing reason, nothing reconnecting by
itself, Retry admitted or refused), and in the browser against the real
gateway (the fifth tab, a sixth opened meanwhile, Retry refused while the
limit holds and admitted after a tab closed, the ninth connection in all).
`shared-unread.test.ts` checks the listener's shared unread mark in the
browser: a turn completed while another conversation is shown stays marked
after a reload, a second tab of the same browser showing it clears it in
both, a tab hidden behind another reports so and clears nothing, and the
narrow Activity column covers the chat (only crossing the narrow limit
reports).

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
that every request and socket goes to the
gateway's origin only; no Content-Security-Policy violation under the
gateway's real policy; and no horizontal overflow at 420 px and 1280 px. With
`COMPANION_SHELL_SCREENSHOTS=<directory>` it also saves screenshots of
synthetic conversations at 420, 760, 1280 and 1600 px, with the list as strip
and as full list (keep them out of Git).

`list.test.ts` covers the list and layout with real pointer and key input: at
1280 px the strip next to the chat, the divider dragged under and over the snap
point and beyond the maximum, the width remembered only on release, a press
on the divider without moving changing nothing, ☰ hiding
the list with the chat then as wide as the window, width and hidden state after
reloads, a narrow window showing the strip without changing what is
remembered, a storage that refuses writes keeping the page's width; a layout change in one tab followed by another, whose ☰ then
keeps that width; the divider's role, name, value and keys, the entries'
accessible description, and selecting, closing, Previous sessions and Reopen
from the keyboard; strip and chat at 420 px
without overflow and, at 1600 px, the chat, its messages and its text box
as wide as the main area; each conversation's
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

`list-menu.test.ts` plays the two tables of
[moving by key and by the ⋯ menu](#moving-by-key-and-by-the--menu) in the
browser: first, middle and last × up and down × by key and by menu, in the
strip and in the full list (24 cases), each with the request, the order at
the listener and in a second page, and focus; no Classic view button in the
chat; a move held pending (by a wrapper around the page's `WebSocket.send`)
while further keys and the menu send nothing; a move refused because the
order changed elsewhere, with the toast; the entry closed elsewhere while
its menu is open (also the last); one conversation. Then the menu table:
opened by click, Enter and Space, its names and roles, arrow keys, Home and
End, closed by Escape, a choice, Tab, a click outside on text and on the
text box, a press outside that selects text, Escape on its ⋯ after a press
released elsewhere, another entry's menu, the list becoming the strip, and
Close session from the menu. The pending move survives hiding and showing
the list. At 420 px with touch emulation: a tap opens it, Move
up by tap, a tap outside closes it, the list scrolled until the open menu's
⋯ leaves a short window keeps the menu inside it, a tap on the entry still
selects; at 420 and 1600 px no overflow, the menu inside the window. Nothing in it waits a
fixed time: a move is sent within its key or click handler, so the page's
count of sends says at once whether one went out. With
`COMPANION_SHELL_SCREENSHOTS` it saves an open menu in the strip at 420 and
1280 px and in the full list at 1280 px.

`times.test.ts` and `listening-switches.test.ts` check the rules of
[Settings, turn timers and message times](#settings-turn-timers-and-message-times)
in Node, each table row by row: the turn timer cases through the listener
clock's offset and the ticker with a controlled clock and timeouts (each
second, across an hour, two timers, a new offset), the elapsed-time format,
the message time cases in named time zones (today, yesterday, older, another
year, midnight, the listener's clock ahead, Tokyo and Amsterdam, a daylight
saving day, no or invalid `createdAt`), the Display switches' storage (each
switch, reload, two tabs, refused and unusable storage, invalid entries), the
bridge's rows with and without `time` (switched off they are exactly the Qt
host's), a streaming answer keeping its time, a new offset sending the
changed rows again and one that changes no time sending nothing, midnight
passing (from 30 seconds before it) and a corrected clock moving the wait
for it, the moment the next day starts (also in Nuuk the night its clocks
skip the hour before midnight, through the bridge too), a state message on a new date with an unchanged offset, the other two
switches sending no rows, the midnight that came twice in St. John's (2010); and the Listening switches' availability and
notes (also for the historical payload with only `enabled`, and a partial
one). `markers.test.ts`
has the rows of an answer completed behind the settings screen and of a
conversation selected underneath it.
`chat-heading.test.ts` draws every kind of row with the shared chat page in
headless Chromium and compares the HTML with `fixtures/chat-rows-reference.txt`,
drawn by the base revision's `Chat.tsx` before `ChatRow.time` existed
(`chat-rows-page.ts` says how to draw it again), and checks that with `time`
each "You" and "Pi" heading ends with it and nothing else changes (in
the DOM: the time is the last element of the row's own heading).

`settings.test.ts` covers them in the browser with a controlled listener
clock and a shifted page clock in another time zone: running turns counting
in the bar and the list (strip, under the name; full list, right-aligned),
advancing when both clocks move on while nothing in the document changes
but the timers' text (a mutation observer), the
listener's clock behind the browser's, two conversations, a message's time
in the reader's zone and clock, the last turn's duration when a turn ends;
offline the last known start not counted and, after a gateway restart and
the new snapshot, the new turn counted from its own start; the settings
screen from the gear and the list's entry, by mouse and keyboard, leaving
by the gear, a conversation, Previous sessions and Back, the gear's place
with the Activity column shown; each Display switch hiding its display at
once, its own storage entry, a reload, another tab switching one, a storage
that refuses writes; the sound, intent and shortcut switches sending
`toggle-sounds` and `set-intent-enabled`, following changes another client
makes, focus kept on a switch while its answer is on its way, unavailable
and sending nothing offline; 420 and 1600 px without overflow, at 1600 px the
messages and the text box as wide as the chat area and the time at the
heading's right; at 375 px a long last duration under the title with the
title and every bar button in the window; an answer completed behind the
settings screen marked unread (and announced), cleared by going back (the gear, or Back to a page whose answer completed
meanwhile), kept when another conversation is chosen; the reader's scroll position the same
after Settings and back, with no history request; at 420 px the Settings
entry hiding the Activity column that lay over the chat, and the switches
reachable by keyboard; the conversation underneath closed elsewhere leaving
the settings screen with its focused switch and scroll position; at 375
and 360 px the bars of Previous sessions and the empty view with no button
over the title; the full list at 150 px with a ten-hour time on its own
line under a title that keeps its room, and the entry's description ending
in "running for" and the time; at 1600 px the text box itself as wide as
the chat and each message's gutter opposite its sender. With `COMPANION_SHELL_SCREENSHOTS=<directory>` it saves the
settings screen, running timers (strip and full list), timestamps and all
switches off at 420, 1280 and 1600 px.

`activity-layout.test.ts`, `activity-marker.test.ts`,
`activity-actions.test.ts` and `activity-start.test.ts` check the Activity
rules in Node, each with the
cases of its README table above: the column's width and shown state
(defaults, invalid entries, drag and keys, two tabs, wide and narrow windows
with the list), the new-activity marker against the real phone Store (first
reading, events while hidden and shown, labels, deletion, reconnects with and
without entries heard offline, entries deleted and labelled elsewhere while
offline, read through the listener's own history index, a reading refused
part way and continued by Retry; a Retry pressed after reconnecting but before the
snapshot, its reading abandoned and started over so an offline deletion is
applied; a new listener run,
a failed first reading, sign-out; and the phone's default reading only what
is new), which actions each entry offers, when Incorrect sends and which
actual intents are offered, and one pending request per entry, open
delete confirmations forgotten when their entry leaves the history, and
selecting a started conversation (listed before or after the answer,
another selection or a selection undone meanwhile, the shown conversation
closed elsewhere through the Store's `sendDraft`, the phone's default
unchanged, a failed start, sign-out, the deadline).

`activity.test.ts` covers the Activity side in the browser: history read in
two pages of 50 and kept live, newest first; the marker set while hidden
(on ☰, the Activity entry and its count) and cleared by ☰ or the Activity
entry, and not set by the first reading after a reload; ☰ and the Activity
entry showing and hiding the same column with focus following ☰; the
divider by pointer and keyboard (no write while dragging or on a press
without moving), width and shown state after a reload and in a second tab,
a storage that refuses writes; at 1600 px list, chat and column side by side
with the chat as wide as the area between them, at 700 px the column giving
way, at 420 px the column over the chat without overflow; pause and resume
through the listener, paused for media; starting a coding conversation and
a quick question (keyboard), each selected in the list, and the box
offline; Copy (clipboard), Correct, Incorrect and the actual intent (stored
by the listener), New coding session, Delete after a confirmation that
Cancel leaves without a request, actions offline; a label the listener
refuses (its saved screenshot removed after drawing) leaving the entry
unlabelled; no delete control when the listener does not advertise it, and
in preview mode neither Start nor New coding session, the typed text kept;
one request per entry at a time, also across hiding and showing the
column and with its answer arriving while the column is hidden, while
another entry's request goes out; the recognised intent not offered as the
actual intent; the handlers of an entry
deleted by another client sending nothing when clicked afterwards; at
420 px Tab never reaching the covered chat, and focus moved out of it when
the window narrows; focus on a ☰ or in the column's text box moving to the
other ☰ when a second tab shows or hides the column; focus kept on Correct
and Start while their requests await the answer, on the next entry after a
deletion confirmed with the keyboard, and on Incorrect after picking the
actual intent; a deletion on its way showing "Deleting…" with Cancel
unavailable (also after hiding and showing), and a refused one keeping the
confirmation, also when refused while the column is hidden or after it was
shown again; the error toast's Dismiss reachable above the column at
420 px; a divider drag ended by another tab hiding the column remembering
the width reached; a second pointer tapping the list's or the Activity divider
during a mouse drag ignored, the width reached remembered once on release; focus on the divider moving to the column's ☰ when the window
narrows and to the bar's ☰ when another tab hides the column; the Coding / Quick question choice and the text kept across
hiding the column; an Incorrect press handler drawn before another client
chose the actual intent sending nothing (invoked through Preact's listener
table); keyboard operation and accessible names; the gateway's unchanged policy, no
policy violation and no request to another origin; never the unscoped
`stop-agent`. With `COMPANION_SHELL_SCREENSHOTS=<directory>` it saves the
column hidden and shown at 420, 760, 1280 and 1600 px.

Not covered in the browser: reconnect snapshots (the markers tables' rows
for them are in `markers.test.ts`); a cancelled
pointer, lost pointer capture, the window losing focus and a missing order
revision during a drag (checked in `reorder-gesture.test.ts`); moving by key
or menu while not admitted or without an order revision, and a drag while a
move awaits its answer (both by the same `movable` condition, checked in
`move-steps.test.ts` and `reorder-gesture.test.ts`); a pen drag,
and touch on real touch hardware (a synthetic touch swipe is covered); the × following input the editor holds (that needs over 16,000
characters from an input method); and edge scrolling of a long list during a
drag.

Not covered in the browser for inline widgets: a touch pan over a widget
(the scrolling rule is about scrolls, whatever moved them; only the wheel
is tested), a hidden tab (the
visibility table's row is in `inline-widget-rules.test.ts`; host.js already
stopped polling in a hidden tab before), and a frame whose own page
navigates elsewhere (its messages then have another origin and are
ignored, a Node table row).

Not tested: Safari, Firefox and Windows browsers, a real network or Tailscale,
a widget drawn by the isolated widget renderer (the fixture's renderer runs
reducers in Node; the browser draws the widget from its bundle either way),
and the Qt host itself (`npm run test:window`, `test/session-apps-ui/`).

## Structure

| File                                   | Responsibility                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `src/main.tsx`                         | Creates the phone Store, the bridge and the chat page's ChatStore             |
| `src/App.tsx`                          | Pairing, connection banner, toasts, the limit page; the workspace once paired |
| `src/workspace/Workspace.tsx`          | List, main area and Activity column with their dividers; held input           |
| `src/workspace/ChatBar.tsx`            | The bar above the chat: ☰, title, state, model, gear, Activity ☰            |
| `src/workspace/BarState.tsx`           | The bar's state: `working · 2:16`, `working…`, `ready · last turn 0:42`       |
| `src/workspace/focus-hand-off.ts`      | Focus kept when a focused ☰ goes away because another tab changed the column |
| `src/workspace/PreviousSessions.tsx`   | Previous sessions with Reopen                                                 |
| `src/list/ConversationList.tsx`        | The conversation list: entries, markers, close, drag wiring, Previous entry   |
| `src/list/entries.ts`                  | What each entry shows, from the Store (number, icon, markers, last line)      |
| `src/list/reorder-gesture.ts`          | The reorder gesture's rules, without DOM access                               |
| `src/list/move-steps.ts`               | Moving one place by key or menu; one move at a time, without DOM access       |
| `src/list/EntryMenu.tsx`               | An entry's ⋯ menu: drawing, placing, keyboard, closing                        |
| `src/list/entry-focus.ts`              | Focus kept on an entry when the list draws it in a new order or it goes       |
| `src/layout/list-width.ts`             | Width rules: strip, full list, snapping, keyboard, narrow windows             |
| `src/layout/stored-layout.ts`          | The remembered width and hidden state in `localStorage`                       |
| `src/layout/useListLayout.ts`          | The layout of this page: preference, window width, remembering                |
| `src/layout/Divider.tsx`               | The draggable, keyboard-operable divider (list and Activity)                  |
| `src/layout/activity-width.ts`         | Activity column width rules: range, keys, wide and narrow windows             |
| `src/layout/useActivityLayout.ts`      | The Activity column's layout of this page: preference, shown, remembering     |
| `src/layout/activity-overlay.ts`       | Whether the Activity column lies over the chat now (for the visible report)   |
| `src/activity/ActivityColumn.tsx`      | The Activity column: header, listening, start a conversation, history         |
| `src/activity/HistoryEntry.tsx`        | One history entry and its actions                                             |
| `src/activity/entry-actions.ts`        | Which actions an entry offers and enables, without DOM access                 |
| `src/activity/new-activity.ts`         | The new-activity marker's rule, without DOM access                            |
| `src/activity/listening.ts`            | The listening state's wording                                                 |
| `src/activity/requests.ts`             | Activity requests awaiting their answer, per entry                            |
| `src/activity/select-started.ts`       | Selecting a started conversation unless what is shown changed meanwhile       |
| `src/activity/ActionButton.tsx`        | Buttons that stay focusable while unavailable (`aria-disabled`)               |
| `src/settings/SettingsScreen.tsx`      | The settings screen: Display and Listening sections                           |
| `src/settings/display-settings.ts`     | The Display switches and their `localStorage` entries                         |
| `src/settings/useDisplaySettings.ts`   | The Display switches in a component, following changes                        |
| `src/settings/listening-switches.ts`   | The listener's sound, intent and shortcut switches, without DOM access        |
| `src/times/listener-clock.ts`          | The listener clock's offset from each state message                           |
| `src/times/turn-times.ts`              | What the bar and the list show about turns, without DOM access                |
| `src/times/turn-ticker.ts`             | Advances every shown running time each second, without drawing the page       |
| `src/times/TurnTimer.tsx`              | One running time on the page, written by the ticker                           |
| `src/times/message-time.ts`            | A message's time text for the reader                                          |
| `src/times/page-times.ts`              | The page's time parts, handed from `main.tsx` to the workspace                |
| `src/bridge.ts`                        | `NativeBridge` over the gateway: rows/status messages, request mapping        |
| `src/history.ts`                       | Resident history pages (port of SessionView's paging on HistoryRows.mjs)      |
| `src/rows.ts`                          | Port of `SessionView.rowData()`, through `ChatState.chatRow`                  |
| `src/tools/tool-details.ts`            | Open tool groups, their pages and requests (port of ToolDetails.qml)          |
| `src/screenshots/screenshot-viewer.ts` | The viewer's state: request, image, failures, without DOM access              |
| `src/screenshots/ScreenshotViewer.tsx` | The viewer over the page (the phone panel's Modal)                            |
| `src/models/model-choice.ts`           | What the model picker shows and offers, without DOM access                    |
| `src/models/ModelPicker.tsx`           | The model button and picker in the bar                                        |
| `src/styles.css`                       | The frame around the chat; the chat keeps its desktop stylesheet              |
| `src/widgets/InlineWidget.tsx`         | Inline widget panels: header, frame, states, messages, visibility             |
| `src/widgets/frame-address.ts`         | Which frame addresses are used (exactly `<origin>/f/<handle>/`)               |
| `src/widgets/frame-state.ts`           | The frame states rule, without DOM access                                     |
| `src/widgets/frame-messages.ts`        | Messages to and from a frame: checks, height bounds, theme                    |
| `src/widgets/height-throttle.ts`       | At most one applied frame height per 100 ms                                   |
| `src/widgets/frame-visibility.ts`      | The visibility rule                                                           |
| `src/widgets/frame-scroll.ts`          | Scrolling over a widget counts as the reader's scroll                         |
| `src/widgets/chat-cover.ts`            | Whether the settings screen or the Activity overlay covers the chat           |
| `build.ts`                             | esbuild bundle (Preact) plus `public/index.html`; no network dependencies     |
| `demo.ts`                              | Synthetic end-to-end demo                                                     |
| `synthetic-window.ts`                  | A synthetic window picture (PNG) for the demo's kept screenshot and tests     |
