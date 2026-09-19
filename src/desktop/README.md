# Desktop interface

This module owns permanent utterance records, sound feedback, and a local control
socket. It does not import Omarchy. Core sensors and processors emit the optional
callbacks in `core/activity.ts`; a desktop adapter only consumes this protocol.
The Omarchy implementation lives in `integrations/omarchy`.

Companion listens on `$XDG_RUNTIME_DIR/companion/control.sock`. The directory is
private (0700), as is the socket (0600). One process owns it at a time. Clients
send and receive newline-delimited JSON; transcripts are data, never commands.
Process-lifetime locks beside the socket and database cover startup, stale-socket
recovery, database recovery, and shutdown. They use `flock` from util-linux.
Lock files stay on disk; kernel locks release automatically on process exit.

On connection and state changes, the server sends:

```json
{
  "type": "state",
  "protocol": 1,
  "ready": true,
  "paused": false,
  "pauseReason": "",
  "mediaPauseAvailable": true,
  "speaking": false,
  "soundsEnabled": true,
  "processing": 0,
  "preview": false,
  "activitySessionId": "listener-run-uuid",
  "activityHistoryCount": 1,
  "history": [
    {
      "id": "stable-uuid",
      "observedAt": 1789600000000,
      "utterance": "Please send this text.",
      "application": "org.gnome.TextEditor",
      "intent": "IGNORE",
      "outcome": "ignored"
    }
  ],
  "sessions": [],
  "previousSessions": [],
  "intents": [
    {
      "name": "SEND_TEXT_TO_APPLICATION",
      "label": "Type text",
      "enabled": true,
      "toggleable": true,
      "inferenceAvailable": true,
      "prefixes": ["insert"],
      "prefixAvailable": true
    }
  ]
}
```

The recent view contains the latest 100 nonempty transcripts, newest first.
`speaking` is the current VAD speech state, independent of the processing count.
It returns to false on silence, pause, end of input, or capture failure. Older
servers omit this optional field; adapters should treat absence as false.
It is a view limit, not a database retention policy. Snapshot the rows when
opening a picker so new utterances cannot displace its selected item.

Commands:

```json
{"action":"toggle-pause"}
{"action":"media-playback","playing":true}
{"action":"toggle-sounds"}
{"action":"set-intent-enabled","name":"SEND_TEXT_TO_APPLICATION","enabled":false}
{"action":"paste","id":"stable-uuid","target":"0x123abc"}
{"action":"stop-agent","id":"question-uuid"}
{"action":"close-agent","id":"question-uuid"}
{"action":"reopen-agent","id":"question-uuid"}
{"action":"send-agent","id":"question-uuid","text":"Please explain that further"}
{"action":"choose-agent","id":"question-uuid","revision":"choice-set-uuid","index":0}
{"action":"stop-agent-run","id":"question-uuid","runId":"running-turn-uuid"}
{"action":"composer-focus","id":"question-uuid"}
{"action":"panel-state","id":"question-uuid","composerFocused":true}
{"action":"activity-history","sessionId":"listener-run-uuid","after":0,"through":1}
{"action":"label-history","id":"utterance-uuid","correct":true}
{"action":"label-history","id":"utterance-uuid","correct":false,"actualIntent":"START_CODING_AGENT_SESSION"}
{"action":"start-history-agent","id":"utterance-uuid"}
```

Replies are `{"type":"result","action":"paste","result":"sent"}` (or `skipped`, `preview`,
`paused`, `listening`, `sounds-enabled`, `sounds-muted`) and
`{"type":"error","action":"paste","message":"..."}`. The action identifies the
request when control replies overtake a slow paste. Sound feedback can be muted independently
of listening. Muting stops current and queued cues. `--no-sounds` sets the initial
state; controls can enable sounds later. This setting lasts for the process's
session. Preview mode is always silent and rejects `toggle-sounds`.

The Activity panel has a separate **current listener run** history. An utterance
joins it only at the pipeline's `finished` callback, after its outcome is known.
There is no 100-row cap here. The in-memory index lasts until listener shutdown;
the permanent SQLite records and recordings keep their existing retention.
Closing/reopening the panel or reconnecting its socket does not begin a new run.

`activity-history` returns an object in `result`: `{sessionId, entries, next,
through}`. It reads at most 50 entries per request in completion order; `after`
is the number already read and `through` is the count captured at sync start.
`next: null` ends that sync. A new or changed card is independently published as
`{type: "activity-entry", sessionId, entry}`. An entry contains the ordinary
history fields plus `sequence`, `revision`, nullable boolean `correct`, and
nullable `actualIntent`. Revisions prevent delayed pages from overwriting newer
feedback. The adapter renders newest first. The current run is not attached to
every state snapshot, so microphone updates do not resend an ever-growing list.

`label-history` accepts only completed entries from this run, and only a
registered intent for an explicit correction. Disabled/context-ineligible
intents are still valid labels: feedback describes the intended action, not an
instruction to run it. A null prediction cannot be labeled. Original prediction
and outcome remain unchanged. Label correct sets actual intent to the prediction;
label incorrect without a selection records null. Voice feedback updates these
same rows and refreshes any corresponding current-run cards.

`start-history-agent` loads the selected utterance's saved PNG and opens a new
coding session with that original observation. A missing/corrupt recording is an
error; it never captures a different current screen as a substitute. Preview
does not start an agent or save a UI feedback label.

History **Insert** uses the existing `paste` request and shared keyboard queue,
never Enter. The adapter first relinquishes panel focus and restores the ordinary
application that was active at the click. An intervening focus change cancels
that handoff. `panel-state` also accepts optional `keyboardFocused`; this covers
Activity as well as composers, since Hyprland's `activewindow` can still name the
underlying application while a layer owns its keys. Refocusing the panel or
changing the ordinary target invalidates queued insertion. Copy is a local,
plain-text clipboard action and does not create a delivery/feedback record.

`intents` comes from the router's registered processors. `enabled` is the user's
switch; the two availability flags describe current context eligibility for the
LLM and for explicit prefixes, independently of that switch and microphone pause.
A route is usable when enabled, context-eligible, and listening. `IGNORE` is the
required no-action fallback and cannot be disabled. Older servers omit `intents`;
adapters must show no controls until a server supplies registrations.

`set-intent-enabled` returns `intent-enabled` or `intent-disabled` after saving and
broadcasting the new state. Unknown names, nonboolean values, and disabling
`IGNORE` are rejected. Preferences live in `disabled-intents.json` beside the
desktop database, with mode 0600 and atomic replacement. Writes are serialized
across clients, and a failed save leaves the live switch unchanged. Desktop
startup restores them before accepting sensor frames; `--no-desktop` does not
load desktop preferences.

The optional `agentActions` snapshot field describes the selected conversation's
ephemeral composer controls. Changes also arrive as
`{"type":"agent-actions","actions":{...}}`, without resending transcripts:

```json
{
  "sessionId": "question-uuid",
  "stopRunId": "",
  "choices": [
    {
      "sessionId": "question-uuid",
      "revision": "choice-set-uuid",
      "index": 0,
      "label": "Tests",
      "description": "Run the tests",
      "available": true,
      "voiceAvailable": true,
      "voiceReason": ""
    }
  ]
}
```

`available` means the conversation can accept the choice; `voiceAvailable` also
accounts for reserved labels and permanent-prefix collisions. Adapters additionally
require an online, listening connection before highlighting voice labels. Show
these controls only for the matching selected conversation. A nonempty `stopRunId`
enables the exact `stop` shortcut for that running turn. Choice sets and run IDs are
also included in live session patches, but are never restored from disk.

`choose-agent` and `stop-agent-run` require the sending connection to own the
selected conversation reported by `panel-state`. They return `submitted` or
`stopped`, or an error when the supplied choice/run has expired. Send IDs and the
option index, never the displayed text as a payload. Clients must not retry an
unacknowledged selection automatically; retain the freeform draft and refresh
state after reconnecting. See [conversation choices](../agents/README.md) for
tool syntax, exact voice matching and lifecycle rules.

Disabled intents are omitted from the next detection prompt. Their explicit
prefixes are consumed as skipped commands, never reinterpreted by the LLM or a
shorter prefix. Disabling during inference invalidates that result even if the
intent is re-enabled before the answer arrives. It also cancels a processor still
waiting to type; a keyboard process already typing may leave partial text and is
recorded as interrupted. Accepted independent agent sessions and explicit manual
history recovery keep their existing controls.

`media-playback` reports whether any desktop media player is playing and returns
`media-recorded`. Adapters must send a boolean, report changes, and resend current
state on reconnect. Only send it when the snapshot advertises `mediaPauseAvailable`;
older servers omit this flag. Microphone mode enables it; `--text` and `--wav` ignore
reports. Each connection owns its report. Listening auto-pauses while any connected
reporter says true; disconnect removes only that reporter's state. Loss of all
reporters releases the media pause, leaving any manual pause intact.

`pauseReason` is `media`, `manual`, or an empty string while listening. Media pause
uses the same cancellation path as manual pause: stop recording and discard pending
dictation. Existing independent agent sessions and manual history recovery continue.
An explicit `toggle-pause` while paused resumes listening, overriding playback until
all reporters stop playing. The next playback period rearms auto-pause. Repeated true
reports preserve that override. A manual pause always survives playback ending.

One paste per connection runs at a time; pause/mute and agent controls run independently
with a bounded maximum of 16 outstanding control requests per connection.
Close your overlay before asking
to paste, and pass the window address from when the user opened it. Companion
waits 150 ms for unmapping and checks focus again before literal keyboard input.
Control characters become spaces; no Enter key is sent and the clipboard is
preserved. Manual recovery is available while microphone capture is paused.
Recovering an utterance still being classified supersedes an automatic delivery
which has not yet started, preventing duplicate delivery when inference finishes.
Recovery of an utterance already being typed is rejected. All automatic and
manual keyboard output shares one queue, with focus checked after waiting.
For composer-focused dictation, `sent` confirms keyboard delivery only; it does
not acknowledge that Pi accepted the Enter submission. The `application` column
records the captured ordinary window, which may be behind the focused composer.
CLI delivery messages distinguish that composer from the captured window.
Focus lookups have a five-second deadline. All text delivery uses `wtype -d 1`,
adding 1 ms between characters, matching the local Voxtype configuration.
Typing gets a separate budget of five seconds plus 5 ms per UTF-16 code unit:
this includes wtype's existing 4 ms of key-down/up waits and the extra 1 ms.
The shared keyboard queue stays occupied through typing and any explicit Enter;
cancellation still interrupts the keyboard process. Longer text therefore has
time to complete without extending a stalled focus lookup's deadline.

SQLite lives at `~/companion/utterances.sqlite`. It uses WAL and has no automatic
deletion. `utterances` stores the exact transcript, speech-end timestamp, active
application/window identity, recognized intent, and final processing outcome.
Schema version 2 adds `delivery_started_at` to both tables, committed immediately
before starting keyboard input. The automatic row is `delivering` until completion.
An unavailable application or unsuccessful classification is represented by
NULL, not an inferred label.
The `started` outcome means a question was handed to the independent agent
session manager, not that text was typed or an answer succeeded. Pi persists
the question's screenshot and conversation in its own session storage.

Schema version 3 introduced screenshot recording and `intent_feedback`.
Version 4 removes the earlier screenshot/audio path columns. Files link to
`utterances.id` through their UUID filenames; migration preserves the files,
original utterances, and feedback. No file paths are stored in SQLite.

The sensor pipeline saves the exact captured PNG before intent routing, at
`~/companion/data/YYYY-MM-DD/screenshots/<utterance-id>.png`. The day uses the
observation's local date, not the later write time. Custom database paths use
their parent directory as the data root. The file is written privately and
renamed into place only once complete. Shutdown waits for accepted writes.
These renames prevent readers seeing partial files during ordinary operation;
they do not guarantee power-loss durability because files and directories are
not explicitly synced. An unclean process exit can leave an unused `.tmp` file;
recording readers should only use the final `.png` and `.wav` filenames.
A failed capture or old record has no screenshot file. A failed screenshot
write keeps the transcript, records an error, and prevents routing that observation.

Speech for each retained
transcript is saved as `~/companion/data/YYYY-MM-DD/audio/<utterance-id>.wav`.
These uncompressed 16 kHz mono PCM16 WAVs use the same encoder and complete sample
buffer as Voxtype's input, including the utterance's segmentation padding. They
share the screenshot writer's private atomic publication and UUID filenames.
The pipeline attempts audio and screenshot writes independently, even if a late
ASR result arrived after cancellation. It awaits both before clearing its owned
sample buffer; cancellation still prevents routing. An audio failure still allows
the screenshot to be saved, and a screenshot failure still allows the audio to be
saved. Storage failure leaves the transcript available and prevents the action.
Successful writes survive later delivery failures and `IGNORE` decisions.

Older records and supplied `--text` input have no audio. The storage boundary
remains a nonempty transcript: failed/empty transcription, untranscribed cancelled
jobs, and overload drops create no recording or history row. `--no-desktop`
disables both audio and screenshot persistence.
File replay with `--wav` uses the same recording behavior as microphone input;
use `--no-desktop` for a replay that should not enter the permanent history.

The default database's first startup copies the old
`$XDG_STATE_HOME/companion/utterances.sqlite` (default
`~/.local/state/companion/utterances.sqlite`) and `disabled-intents.json`, preserving
the originals as a fallback. Source and destination process locks prevent racing
an older listener. SQLite backup includes committed WAL data, and the destination
is published only after copying succeeds. Existing destination databases are
authoritative and are never overwritten. Custom databases never import personal
history. The control socket remains in `$XDG_RUNTIME_DIR`.

The standalone voice shortcuts **“label previous correct”** and **“label previous
incorrect”** register as `LABEL_PREVIOUS_CORRECT` and `LABEL_PREVIOUS_INCORRECT`.
They have no LLM instructions. Unlike dictation prefixes, they accept an empty
payload; additional text is rejected. Successful labeling records the command's outcome
as `labeled` and plays the success cue. Preview mode writes no feedback.

`intent_feedback` contains exactly these columns:

| Column              | Meaning                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                | Primary key and foreign key to `utterances.id`; one current label per example.                                 |
| `correct`           | Required SQLite boolean (0 or 1) from explicit feedback.                                                       |
| `recognized_intent` | The original selected intent copied at labeling time.                                                          |
| `actual_intent`     | Nullable intended intent, default NULL. “Correct” copies the recognized intent; “incorrect” clears it to NULL. |

The preceding example is selected by insertion order before the command, skipping
other labeling commands. This survives restarts and wall-clock changes. Repeated
feedback updates that example rather than labeling a labeling command. If the
preceding example has no selected intent, the shortcut skips without jumping to
older speech. Feedback never changes the original intent, processing outcome, or
paste events. Both inferred and explicitly prefixed intents can receive feedback.

`paste_events` references `utterances.id` and records every manual recovery
attempt, target application/address, timestamps, and actual outcome. An ignored
utterance subsequently pasted successfully is a useful evaluation candidate,
not an automatically assigned ground-truth correction. For example:

```sql
SELECT u.transcript, u.application, u.recognized_intent,
       p.target_application, p.completed_at
FROM utterances AS u
JOIN paste_events AS p ON p.utterance_id = u.id
WHERE u.recognized_intent = 'IGNORE' AND p.outcome = 'sent';
```

Failure or cancellation after keyboard input starts is `interrupted`: some text
may have landed. This applies to both automatic sends and manual pastes, including
pause, shutdown, timeout, and nonzero process exit. Work cancelled before keyboard
input starts is `cancelled`. Startup recovery uses the persisted delivery marker
to distinguish these cases after a crash. Migration preserves uncertainty for
unfinished or previously failed/cancelled legacy sends/pastes, which lacked that
marker. Reclassified records retain their old label in `legacy_outcome`;
previously completed records retain their timestamps. Migration also repairs a
version 0 database left by an interrupted first-time setup. The original
intent/outcome stays intact when a user recovers text manually.

An intermediate version-2 schema had delivery markers but no `legacy_outcome`.
Its old and new failed rows cannot be distinguished, so migration conservatively
marks ambiguous failed sends/pastes as `interrupted` and preserves their labels.
Once provenance columns exist, subsequent opens leave new cancellations intact.

## Agent sessions

The optional `sessions` array in each state snapshot contains complete chat
state for reconnects. A session has `id`, `title`, `status`, `model`, `error`,
`updatedAt` (epoch milliseconds), and `messages`. Status is `starting`, `running`,
`completed`, `cancelled`, or `error`.
Each message has `id`, `kind` (`user`, `assistant`, `tool`, or `notice`), `text`,
`toolName`, `input`, `state` (`running`, `done`, or `error`), and a boolean
`screenshot` attachment indicator. An optional `screenshotUrl` is a local file URL
for the private original PNG. It may be absent on older/missing attachments; keep
the question text visible. Image bytes never travel to the UI socket. URLs are
computed from the validated session UUID, not trusted from serialized content.

Between snapshots, `{"type":"agent-session","session":{...}}` carries current
session metadata and **only changed messages**. Upsert by session/message ID in
arrival order; do not replace the entire conversation with this partial array.
Streaming updates are coalesced every 40 ms; a terminal status flushes pending
messages immediately. `{"type":"agent-removed","id":"..."}` removes a tab.
All messages share the ordered socket with snapshots. A newly seen session opens
and selects its panel tab once; further updates and reconnects do not reopen it.

The optional `previousSessions` snapshot array and
`{"type":"agent-history","sessions":[...]}` contain summaries only: the session
metadata above without `messages`. They are sorted by latest turn first and must
not automatically open tabs or invoke a model. `reopen-agent` emits
`{"type":"agent-restored","session":{...}}` with the complete transcript, then an
updated history list. Replace that session, select it explicitly even if its ID
was seen before, and reveal the panel. It returns `reopened`. Closing first stops
the agent and saves its final state; a failed save keeps the tab open and returns
an error. Failed reopen keeps the history entry available for retry. Adapters
must show control errors in the panel as well as retaining drafts.

Snapshots and PNGs live in `~/companion/agents/.companion-sessions`, separate from
Pi's resumable transcript. Writes atomically replace private files. Startup is
read-only and discovers only these snapshots; unfinished turns become stopped.
The question is saved before launching Pi and the transcript at turn completion,
Stop, Close, and orderly shutdown. A hard crash can lose unsaved current output.
No retention limit or legacy Pi-session import is applied.

Agent controls return `stopped`, `closed`, `reopened`, or `submitted`. Follow-ups are bounded
to 4000 characters and rejected while that session is still answering. Submission
starts a new turn in the same Pi session, without another screenshot. Message IDs
are unique across turns, so a later answer cannot overwrite an earlier bubble.
Adapters clear the submitted draft only after its successful reply; failed sends
retain it. Drafts typed after submission must not be cleared by an older reply.

`panel-state` reports the visible, selected agent session plus whether its composer
actually owns keyboard focus. Use an empty `id` and `composerFocused: false` for
a hidden panel, Activity, or another non-conversation page. Send changes to either
field and resend after connecting; the response is `panel-recorded`. The owning
connection's loss clears this state. Unknown session IDs and a focused empty ID
are rejected. These reports also update the keyboard delivery focus guard.

At speech end, the sensor frame captures the session ID, focus, and a local
generation. The classifier sees the ID/focus and gains
`CONTINUE_OPEN_AGENT_CONVERSATION` only when that composer was focused. A
continuation rechecks the generation and target existence before calling the
session manager, so even leaving and returning to the same tab cannot redirect
an old utterance. Explicit `message coding agent` requires a visible session but
not composer focus. The generation is not sent to the model.

Older clients may still send `composer-focus`, which reports the session whose composer actually owns keyboard focus,
or `id: ""` when none does. It returns `focus-recorded`. The owner connection's
loss also clears it. This legacy report alone does not establish a visible tab
for speech routing; current adapters use `panel-state` instead.
Hyprland keeps its previous ordinary `activewindow` while a layer surface receives
keys; the extra focus revision detects that transition. Speech records this revision
before capture and checks it at delivery and again before Enter. A history recovery
request may include `composer` with its focus ID from shortcut press time.

Agent controls remain usable while microphone
capture is paused or a keyboard delivery is pending. Agent sessions belong to
the application lifetime, independently of each bounded sensor job.
