# Companion browser shell

Status: third slice (2026-11). The desktop chat page in an ordinary browser,
against the existing remote gateway, with the conversation list on its left
and the Activity column on its right.
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
   [one change to the shared chat page](#one-change-to-the-shared-chat-page)):
   streaming transcript, Markdown, tool-group summary rows and origin labels;
4. send a message, queue a follow-up while the agent runs, stop the run,
   answer offered choices and close the conversation;
5. page through older and newer history, as the desktop does;
6. show connection loss and recovery without resending anything;
7. show what Companion heard and decided in an **Activity** column on the
   right, pause and resume listening, start a conversation from typed text,
   and copy, label, delete or start a coding session from what was heard
   (see [Activity](#activity)).

Not yet in the browser: the settings screen, the sound, intent and shortcut
switches, turn timers, message timestamps, Activity history of earlier
listener runs, inserting text into desktop applications, and widgets.

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

## Activity

What Companion heard on the computer, what it decided to do with it, and the
listening controls, in a column on the right of the chat:

```text
┌────────┬┬──────────────────────────────┬┬──────────────────────┐
│ ◖ Act. ││ ☰  title            ready    ││ Activity listening ☰ │
│────────││──────────────────────────────││──────────────────────│
│ list   ││  chat, centred, ≤ 860 px     ││ listening · pause    │
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
  ☰, hiding it with the column's ☰ moves focus back to the bar's ☰.
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
   cancelled or capture lost: the width reached is kept); a press that does
   not move changes and remembers nothing.
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

| Case                                                 | Result                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Initial (nothing remembered)                         | Hidden; 320 px when shown                                   |
| Both entries invalid or of another version           | Hidden; 320 px when shown                                   |
| Only the width invalid; column shown                 | Shown at 320 px                                             |
| Only the shown state invalid; 400 px                 | Hidden; 400 px when shown                                   |
| Remembered width 100 / 900 (out of range)            | 240 / 520 px                                                |
| ☰ in the bar, then ☰ in the column                 | Shown, then hidden; each remembered; the width kept         |
| The Activity entry pressed twice                     | Shown, then hidden (the same entry as ☰)                   |
| Divider dragged to 300 px from the right edge        | 300 px, remembered on release                               |
| Divider dragged to 100 / 900 px from the right edge  | 240 / 520 px                                                |
| Press on the divider without moving                  | Nothing changes or is written                               |
| Left / Right / Home / End on the divider             | +20 / −20 / 240 / 520 px, each remembered                   |
| Reload                                               | Width and shown state as remembered                         |
| Storage refuses writes; 400 px, ☰                   | 400 px, shown, for this page                                |
| Window 1600 px, strip, column 320 px                 | Side by side; chat area 1200 px, its column 860 px, centred |
| Window 1000 px, full list 420, column 520 remembered | Column 520 px; full list 158 px; chat 320 px                |
| Window 700 px, strip, column 520 remembered          | Column 300 px (700 − 321 − 79); chat 320 px                 |
| Window 640 px, strip, column shown                   | Column 240 px beside the chat                               |
| Window 639 / 420 px, column shown                    | Over the chat, right of the list; no divider; no overflow   |
| Window 420 px, column shown, Tab                     | Moves through list and column, never into the covered chat  |
| Focus in the chat, the window narrows under 640 px   | Focus moves to the column's ☰                              |
| Window 420 px, list hidden, column shown             | Over the whole window width                                 |
| Width or shown state changed in another tab          | This tab follows that entry                                 |
| Sign-out and pairing again                           | Layout kept                                                 |

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
   missed while offline.
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

| Event                                                       | Marker                                    |
| ----------------------------------------------------------- | ----------------------------------------- |
| First reading after loading the page, with entries          | not set                                   |
| A new entry arrives while hidden                            | set (count 1)                             |
| Two more arrive while hidden                                | set (count 3)                             |
| A new entry arrives while shown                             | not set, also after hiding                |
| An entry already seen is labelled or changes outcome        | not set                                   |
| The column is shown (☰, Activity entry, or another tab)    | cleared                                   |
| The only new entry is deleted                               | cleared                                   |
| Entries heard while offline, learned after reconnecting     | set                                       |
| An entry deleted elsewhere while offline                    | gone after reconnecting; no longer counts |
| An entry labelled elsewhere while offline                   | label shown after reconnecting; not set   |
| A reconnect without new entries                             | not set                                   |
| A new listener run after catching up, with entries          | set                                       |
| The first reading fails; entries arrive; a retry catches up | not set until caught up                   |
| Pause, resume, speech, processing                           | not set                                   |
| Sign-out and pairing again (first reading)                  | not set                                   |

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
  question, and Start (`start-agent`). It uses the phone Store's draft and
  send rules: the text is kept in this browser until the start is answered,
  a second Start cannot send it again, and a failure keeps the text with
  the explanation. The conversation opens in the background on the
  desktop; here it appears in the list and is **selected** once listed,
  unless what is shown (the selected conversation or Previous sessions)
  changed at any moment since Start was pressed, also to and fro or by Back
  and Forward (`src/activity/select-started.ts`). Waiting for it ends after
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

- **Copy** puts the recognised text on the clipboard ("Copied", or "The
  browser did not allow copying").
- **New coding session** (`start-history-agent`) starts a coding
  conversation from the entry's saved screenshot and text, in the
  background on the desktop. Not for an audio-only entry or one whose
  screenshot was not kept, nor while the listener offers no conversation
  controls or runs in preview mode. The listener's answer does not name the new
  conversation, so it appears in the list with the "not seen" marker and is
  not selected.
- **Correct** and **Incorrect** (`label-history`) label the decision; they
  need a decision (an intent), capture storage on at the listener, and the
  entry's complete saved capture (otherwise the reason is shown, as on the
  phone). Incorrect sends the label and opens "What should it have been?",
  the listener's intents; picking one sends the label with that actual
  intent. On an entry already labelled incorrect, Incorrect only opens the
  choice. Not while the listener runs in preview mode, where labels are
  not saved. The pressed button shows the current label.
- **Delete** (×) is offered only while the listener advertises deletion
  (`historyDeletionAvailable`). It opens a confirmation inside the entry
  ("Delete permanently" or Cancel) and sends `delete-history` only from
  there; not while the entry is still processing. The entry leaves the
  column when the listener reports it deleted.

| Entry and state                                           | Copy | New coding session | Correct / Incorrect                        | Delete ×           |
| --------------------------------------------------------- | ---- | ------------------ | ------------------------------------------ | ------------------ |
| Saved entry with a decision; admitted; deletion offered   | on   | on                 | on                                         | shown, on          |
| Offline                                                   | on   | off                | off                                        | shown, off         |
| Reconnected, before the new snapshot                      | on   | off                | off                                        | shown, off         |
| Deletion not advertised by the listener                   | on   | on                 | on                                         | not shown          |
| Already labelled correct                                  | on   | on                 | on; Correct pressed                        | shown, on          |
| Labelled incorrect → an intent                            | on   | on                 | on; Incorrect pressed; "→ intent"          | shown, on          |
| A request of this entry awaits its answer                 | on   | off                | off                                        | shown, off         |
| A request of another entry awaits its answer              | on   | on                 | on                                         | shown, on          |
| The listener refused the request                          | on   | on (toast)         | on (toast); label unchanged                | shown, on (toast)  |
| No decision (no intent)                                   | on   | on                 | off                                        | shown, on          |
| Audio only (no text, no decision)                         | off  | off                | off                                        | shown, on          |
| Not saved (capture storage was off)                       | on   | off                | off, "requires this entry's saved capture" | shown, on          |
| Capture storage off (or being turned off) at the listener | on   | on                 | off, "requires capture storage"            | shown, on          |
| An older listener that does not report capture storage    | on   | on                 | on (its own rules apply)                   | shown, on          |
| Screenshot not kept                                       | on   | off                | on unless the listener names a reason      | shown, on          |
| The listener names why the capture is incomplete          | on   | per screenshot     | off, "requires … complete saved capture"   | shown, on          |
| Still processing                                          | on   | on                 | on                                         | shown, off         |
| The listener offers no conversation controls              | on   | off                | on                                         | shown, on          |
| The listener runs in preview mode                         | on   | off                | off, "Preview mode: labels are not saved." | not shown          |
| Removed elsewhere while its confirmation is open          | —    | —                  | —                                          | gone; nothing sent |
| Gone or a new run between drawing and the click           | —    | nothing sent       | nothing sent                               | nothing sent       |

Pause and Resume follow the same rule (admitted, Companion running, its own
toggle not awaiting an answer). Start is enabled while admitted, while the
listener offers conversation controls and is not in preview mode, with
text, and no start awaiting its answer. A request of an entry still
awaiting its answer keeps that entry's requests disabled also when the
column is hidden and shown again.

Known limits: `toggle-pause` is the remote role's only listening action and
it toggles, so a Pause pressed at the moment listening was paused elsewhere
resumes it (the button shows the listener's state again at once). The whole
run's history is drawn (it is read in pages, not shown in pages). The
marker's memory is this page's: a reload or a second tab starts from its
own first reading.

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
  the gateway's remote allowlist (`src/remote/protocol.ts`); besides them
  only the phone Store's own `panel-state` selection report and the
  Activity column's requests (see [Activity](#activity)) leave the page. The
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
| Settings, model picker, timers                 | Not in this slice                                                                                      |
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
A scripted backend streams Markdown, tool calls and choices; Activity has
synthetic entries of different kinds (typed, ignored, a started
conversation, audio only, not saved), listening starts paused for media, and
a new entry is heard every 40 seconds (six in all) to show the marker. No
model, microphone, screen capture or personal data is involved. Ctrl+C stops it and
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
a detached snapshot without skipping rows (also when the reader reaches the end by a slow drag before the next page
arrives), and Jump to latest from a detached snapshot followed by a streamed
row; a conversation reopened under the same ID while offline shown at its
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

`activity-layout.test.ts`, `activity-marker.test.ts`,
`activity-actions.test.ts` and `activity-start.test.ts` check the Activity
rules in Node, each with the
cases of its README table above: the column's width and shown state
(defaults, invalid entries, drag and keys, two tabs, wide and narrow windows
with the list), the new-activity marker against the real phone Store (first
reading, events while hidden and shown, labels, deletion, reconnects with and
without entries heard offline, entries deleted and labelled elsewhere while
offline, read through the listener's own history index; a new listener run,
a failed first reading, sign-out; and the phone's default reading only what
is new), which actions each entry offers and one pending request per entry,
and selecting a started conversation (listed before or after the answer,
another selection or a selection undone meanwhile, a failed start,
sign-out, the deadline).

`activity.test.ts` covers the Activity side in the browser: history read in
two pages of 50 and kept live, newest first; the marker set while hidden
(on ☰, the Activity entry and its count) and cleared by ☰ or the Activity
entry, and not set by the first reading after a reload; ☰ and the Activity
entry showing and hiding the same column with focus following ☰; the
divider by pointer and keyboard (no write while dragging or on a press
without moving), width and shown state after a reload and in a second tab,
a storage that refuses writes; at 1600 px list, chat and column side by side
with the chat column centred and at most 860 px, at 700 px the column giving
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
column, while another entry's request goes out; the handlers of an entry
deleted by another client sending nothing when clicked afterwards; at
420 px Tab never reaching the covered chat, and focus moved out of it when
the window narrows; keyboard operation and accessible names; the gateway's unchanged policy, no
policy violation and no request to another origin; never the unscoped
`stop-agent`. With `COMPANION_SHELL_SCREENSHOTS=<directory>` it saves the
column hidden and shown at 420, 760, 1280 and 1600 px.

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
| `src/workspace/Workspace.tsx`        | List, main area and Activity column with their dividers; held input         |
| `src/workspace/ChatBar.tsx`          | The bar above the chat: ☰, title, state, Activity ☰                       |
| `src/workspace/PreviousSessions.tsx` | Previous sessions with Reopen                                               |
| `src/list/ConversationList.tsx`      | The conversation list: entries, markers, close, drag wiring, Previous entry |
| `src/list/entries.ts`                | What each entry shows, from the Store (number, icon, markers, last line)    |
| `src/list/reorder-gesture.ts`        | The reorder gesture's rules, without DOM access                             |
| `src/layout/list-width.ts`           | Width rules: strip, full list, snapping, keyboard, narrow windows           |
| `src/layout/stored-layout.ts`        | The remembered width and hidden state in `localStorage`                     |
| `src/layout/useListLayout.ts`        | The layout of this page: preference, window width, remembering              |
| `src/layout/Divider.tsx`             | The draggable, keyboard-operable divider (list and Activity)                |
| `src/layout/activity-width.ts`       | Activity column width rules: range, keys, wide and narrow windows           |
| `src/layout/useActivityLayout.ts`    | The Activity column's layout of this page: preference, shown, remembering   |
| `src/activity/ActivityColumn.tsx`    | The Activity column: header, listening, start a conversation, history       |
| `src/activity/HistoryEntry.tsx`      | One history entry and its actions                                           |
| `src/activity/entry-actions.ts`      | Which actions an entry offers and enables, without DOM access               |
| `src/activity/new-activity.ts`       | The new-activity marker's rule, without DOM access                          |
| `src/activity/listening.ts`          | The listening state's wording                                               |
| `src/activity/requests.ts`           | Activity requests awaiting their answer, per entry                          |
| `src/activity/select-started.ts`     | Selecting a started conversation unless what is shown changed meanwhile     |
| `src/bridge.ts`                      | `NativeBridge` over the gateway: rows/status messages, request mapping      |
| `src/history.ts`                     | Resident history pages (port of SessionView's paging on HistoryRows.mjs)    |
| `src/rows.ts`                        | Port of `SessionView.rowData()`, through `ChatState.chatRow`                |
| `src/styles.css`                     | The frame around the chat; the chat keeps its desktop stylesheet            |
| `build.ts`                           | esbuild bundle (Preact) plus `public/index.html`; no network dependencies   |
| `demo.ts`                            | Synthetic end-to-end demo                                                   |
