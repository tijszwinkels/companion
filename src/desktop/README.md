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
      "supportsInference": true,
      "inferenceEnabled": true,
      "shortcutEnabled": true,
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
{"action":"set-intent-enabled","name":"SEND_TEXT_TO_APPLICATION","mode":"inference","enabled":false}
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
{"action":"delete-history","id":"utterance-uuid"}
```

Replies are `{"type":"result","action":"paste","result":"sent"}` (or `skipped`, `preview`,
`paused`, `listening`, `sounds-enabled`, `sounds-muted`) and
`{"type":"error","action":"paste","message":"..."}`. The action identifies the
request when control replies overtake a slow paste. Sound feedback can be muted independently
of listening. Muting stops current and queued cues. `--no-sounds` sets the initial
state; controls can enable sounds later. This setting lasts for the process's
session. Preview mode is always silent and rejects `toggle-sounds`.

Successful agent turns emit `{"type":"agent-turn-completed","id":"session-uuid",
"turnId":"turn-uuid"}` once, after their backend and history save finish. This
triggers the `agent-completed` chime through the same sounds toggle. Reconnecting,
restoring a tab, and receiving another completed-status snapshot do not replay
the cue. Failed or stopped turns emit no completion event.

The state snapshot advertises `textInputAvailable` once the live pipeline is
attached. Activity can submit `{"action":"submit-utterance","text":"new session explain this","target":"0x123"}`
after releasing panel focus and restoring the compositor-confirmed application.
Text must contain 1–4000 characters (whitespace-only is rejected); `target` must
match the captured screenshot. The action returns `queued` after bounded FIFO
admission, not after processing. History reports the eventual result. Text and
speech share IDs, ordering, shortcuts, inference, screenshots and persistence;
typed input bypasses ASR and creates no WAV. Explicit text remains available while
the microphone is paused. The UI retains drafts on rejection/disconnection and
does not replay unconfirmed submissions. Its native bridge handoff carries an
opaque request ID so a delayed focus reply cannot submit a replacement draft.

The Activity panel has a separate **current listener run** history. An utterance
joins it only at the pipeline's `finished` callback, after its outcome is known.
There is no 100-row cap here. The in-memory index lasts until listener shutdown;
SQLite records and recordings remain until explicitly deleted.
Closing/reopening the panel or reconnecting its socket does not begin a new run.

`activity-history` returns an object in `result`: `{sessionId, entries, removed,
next, through}`. It reads at most 50 completion positions per request; `after`
is the number already read and `through` is the watermark captured at sync start.
Removed entries keep their positions, so `activityHistoryCount` remains a paging
watermark rather than a visible-card count. `removed` contains content-free
markers `{id, sequence, revision, deleted: true}`.
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

`delete-history` deletes the selected SQLite utterance, its feedback and paste
records, and its UUID-named PNG/WAV (including incomplete `.tmp` files). The
Activity card offers a small cross on hover or keyboard focus when the snapshot
advertises `historyDeletionAvailable: true`. Preview and older listeners do not
offer it. Deletion is immediate, without a confirmation dialog or undo.

Processing entries and entries with a pending paste cannot be deleted. While
deletion is underway, new insert, label and history-agent operations on that row
are rejected. Files are removed first, followed by one SQLite transaction for all
three tables. This is not atomic across SQLite and the filesystem: on an error or
crash some files may already be gone, but the row remains available for retry;
missing files are tolerated. Date buckets are searched by UUID to handle a
changed timezone. Other utterances and directories are preserved.

Successful deletion publishes `{type: "history-deleted", id, sessionId, removed}`
and refreshes recent history. `removed` is omitted for rows from an earlier run.
Current-run clients retain removal markers across reconnects and ignore stale
pages/feedback for those UUIDs. An open recovery picker removes the row too;
if it was selected, the picker cancels instead of pasting a neighbouring row on
shortcut release. Deletion does not erase independent agent conversations that
already used that utterance, external copies, backups, or securely wipe SQLite's
free pages/WAL. It removes the observation from active history and evaluation
storage; it is not a secure-erasure operation.

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

`intents` comes from the router's registered processors. `supportsInference`
identifies processors with an LLM instruction even when context makes them
unavailable. `inferenceEnabled` and `shortcutEnabled` are independent saved
switches; `inferenceAvailable` and `prefixAvailable` describe context eligibility.
`prefixes` identifies the supported voice commands. Listening must also be active.
`enabled` remains a compatibility summary: at least one supported route is enabled.
`IGNORE` is required and cannot be disabled. The UI renders separate accent-colored
Intent and amber Shortcut cards and greys out disabled/unavailable routes. If the
server lacks these independent fields, the refreshed UI requests a listener restart.

`set-intent-enabled` accepts `mode: "inference"` or `mode: "shortcut"`. Omitting
mode preserves the old combined toggle for older clients. Unknown/unsupported
modes, unknown names, nonboolean values, and disabling `IGNORE` are rejected
before any preference write. Success returns `intent-enabled` or `intent-disabled`
after saving and broadcasting state. Each route owns its cancellation generation;
one switch cannot cancel the other's work. Disabled prefixes remain reserved.

Preferences stay in `disabled-intents.json` beside the database, mode 0600,
with atomic replacement and serialized writes. The new shape is
`{"version":1,"disabledInference":[],"disabledShortcuts":[]}`. Legacy name arrays
load as disabled in both modes without an immediate rewrite; the next successful
click saves the versioned format, retaining unknown module names. A failed save
leaves the live switches unchanged. Desktop startup restores preferences before
sensor frames; `--no-desktop` does not load them. Older listeners cannot read the
new format; restore the previous preferences file if rolling back to an old build.

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

`available` means the conversation can accept the choice, including the global
four-agent capacity limit; `voiceAvailable` also
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
The `closed` outcome records an explicit `close session` command after the tab
has been saved and removed; it does not delete its conversation archive.

The `started` outcome means a question was handed to the independent agent
session manager, not that text was typed or an answer succeeded. Pi persists
the question's screenshot and conversation in its own session storage.

Schema version 3 introduced screenshot recording and `intent_feedback`.
Version 4 removes the earlier screenshot/audio path columns. Files link to
`utterances.id` through their UUID filenames; migration preserves the files,
original utterances, and feedback. No file paths are stored in SQLite.

Version 5 adds nullable `utterances.intent_request`, a versioned JSON snapshot of
the actual intent-classification request. It belongs to the observation rather
than `intent_feedback`, since examples must be recorded before anyone labels
them. Opening an older database adds the column without inventing past prompts
or changing existing recordings/labels. Older Companion builds that only
understand schema version 4 will refuse the upgraded database.

Pi's `onPayload` hook runs after provider conversion and before HTTP. We save the
complete body there: exact system instruction text, enabled/dynamic intent
entries, user-message JSON (including captured conversation context), content
order, model, temperature, token limit and provider flags. The snapshot also
records its format version, API, base URL and preparation time. Authentication
headers and API keys are not captured. Normal UI history snapshots do not expose
this potentially long JSON or its conversation excerpts.

The PNG remains in its existing UUID-named file. Inside the recorded body, its
`image_url.url` is replaced at that exact content position with:

```json
{
  "artifact": "utterance-screenshot",
  "mimeType": "image/png",
  "sha256": "<SHA-256 of the captured PNG bytes>"
}
```

This reference means the screenshot belonging to the same `utterances.id`, not
a path or an arbitrary substring to replace in prompt text. Other image-part
fields such as `detail` are preserved. No base64 copy of that image is stored in
SQLite. To reconstruct the request, read that UUID's saved PNG and use
`restoreIntentRequest(intentRequestJson, png)` from `src/core/intent-request.ts`.
It returns the record with `body` restored to the original provider request,
including the inline data URL in the original position. It validates the format
and image checksum; a missing/changed recording must not be replaced with a new
screenshot. Lookup is by UUID across recording date buckets if the machine's
timezone has changed. The helper assembles data only and makes no model request.

The snapshot is immutable once saved. Later streamed messages, changed prompts,
choice sets, labels and reopened conversations cannot change it. Failed model
requests and invalid model answers retain the prepared request. A snapshot is
evidence of what was prepared for transport, not proof that a remote model
received or processed it. A recording failure prevents HTTP and routing, as an
existing PNG/WAV recording failure does. There is no added model call or retry.

Legacy rows, shortcuts that bypass inference, and failures before payload
preparation have `intent_request = NULL`. `--no-desktop` disables this storage
along with the other observation records. Preview still records an inference
request if it calls the detector, while an explicit prefix has no request to
record. The snapshot shares its utterance's lifetime because it lives in the
same row.

For labeled evaluations, join the original observation with its current label:

```sql
SELECT u.id, u.observed_at, u.intent_request, u.recognized_intent,
       f.correct, f.actual_intent
FROM utterances AS u
JOIN intent_feedback AS f ON f.id = u.id
WHERE u.intent_request IS NOT NULL;
```

Use a left join to include unlabeled observations. `json_extract(intent_request,
'$.body.messages[0].content')` returns the saved system prompt. Replaying the same
request reproduces its inputs, not a promise of identical output from a changed
model server or a nondeterministic inference engine.

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
to 4000 characters and queue while that session is answering, with at most eight
pending messages. Submission starts or queues a new turn in the same Pi session,
without another screenshot. Message IDs
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
generation. `CONTINUE_OPEN_AGENT_CONVERSATION` is available whenever an agent
conversation is selected in the visible sidebar. A focused composer retains the
exact strong default instruction; an unfocused composer uses an instruction to
judge whether the utterance belongs to that conversation. Activity, Previous
sessions and hidden panels do not qualify. Explicit `continue session`
continues to require a visible conversation, without requiring composer focus.

The detector's user-message JSON includes `interaction.agentConversation`: the
selected title and first two/last two non-empty user or assistant text bubbles.
Overlapping positions appear once in chronological order. Roles and message
states distinguish queued requests, partial answers and failed messages. Tools,
notices and non-text content are excluded. Previously saved HTML bubbles retain
their plain-text fallback after the HTML feature was removed.
The title is bounded to 200 Unicode code points and each of up to four messages
to 2000, retaining the beginning/end around an omission marker. Truncation is
flagged. These are copied values from speech end, before asynchronous screen
capture and transcription; later streaming or renaming cannot rewrite them.
The detector treats these excerpts as quoted context, not instructions.

Continuation rechecks the generation and target existence before calling the
session manager, so even leaving and returning to the same tab or composer cannot
redirect an old utterance. Title/text updates alone do not invalidate a target.
Running conversations remain eligible and freeform follow-ups use the existing
FIFO queue. The generation is not sent to the model; transcript excerpts are
not added to routine UI state reads or forwarded as new conversation messages.

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

### Destination feedback

`Activity.outcome` optionally carries `agent-session` or `new-agent-session` as
its third argument when a processor accepts speech. This does not alter the stored
`started` outcome or signal completion of the agent turn. New coding/quick-question
sessions play `agent-started`; accepted continuations and choices play `agent-sent`.
Application typing/recovery retains `sent`. Completion retains `agent-completed`.
Preview, rejected delivery, cancellation and close have no success sound. All cues
share the existing mute/cancellation queue and are checked against real Silero VAD
using synthetic audio. No speaker-to-microphone acoustic guarantee is implied.

### Lazy tool transcript pages

Consecutive tool calls are one `kind: "tool"` message, with empty `text`/`input`
and `toolGroup: {count, revision}`. Its server-generated UUID remains stable as
calls start, update and finish. An intervening user, assistant or notice starts a
new group. Updates to an older call retain that group's original position.
Snapshots and incremental events contain these summaries only. Ordinary text
still has the 1,000,000 UTF-16-unit display budget; a group consumes one of the
800 display rows, regardless of its call count or output length.

Expansion sends a private request on the existing socket:

```json
{
  "action": "agent-tool-page",
  "requestId": "opaque-click-id",
  "id": "session-uuid",
  "epoch": "live-tab-uuid",
  "groupId": "group-uuid",
  "revision": "group-revision-uuid",
  "index": 0,
  "offset": 0
}
```

The sending connection must own the selected conversation through `panel-state`.
`epoch` is the session's live `toolEpoch`, regenerated on reopen and omitted from
archives. IDs select existing session/group records, never files or URLs. The
usual result/error envelope echoes the bounded `requestId`, including admission
errors. The result echoes the group identity, revision and position and adds
`{text, state, callRevision, next}`. Continuations within the same call send its
`callRevision`; appending sibling calls does not expire that immutable version.
Reading another call or explicitly refreshing uses the current group revision.
`next` is `{index, offset}` or null. Index selects a call;
offset counts UTF-16 units in its name, input and result, separated by blank lines.
Each page contains at most 8,192 units (under 50 KiB even with worst-case JSON
escaping), against the socket's existing 2 MiB write-backpressure threshold.
Requests remain under its 32 KiB input bound and 16 outstanding-control limit.
Replies go only to the requester, never through session broadcasts.

The portable panel and native client create the details reader only on expansion.
Next page replaces the current page; Copy page copies exactly the displayed text,
and ordinary selection/Ctrl+C remain available. Refresh page retains the current
call and offset; From start returns to the first call. A group update marks the
loaded page as an older snapshot and offers explicit refresh without clearing
its text or losing the reader's position. It does not fetch repeatedly while
tools stream. A changed call revision rejects continuation, preventing mixed
chunks from different outputs. Collapse destroys the page.
Disconnect, tab lifetime changes and removal invalidate pending requests; delayed
responses cannot populate another conversation. Read errors and a 10-second UI
request timeout offer retry within the expanded group. Tool text is always plain
text, including anything that resembles HTML, a URL or a command.

Full tool text is stored in `.companion-sessions/tool-transcripts.sqlite`,
using a private directory (0700), database (0600), atomic SQLite transactions and
UTF-16LE blobs. Session JSON normally remains an atomic, compact display snapshot;
preserve both files when backing up or moving conversations. Legacy JSON tools migrate
when read, keeping their original archive untouched until the next normal save.
If migration cannot write the database, legacy groups page their text from the
existing JSON on explicit expansion. That fallback temporarily parses the old
archive and preserves its inline tool records on later saves; it never keeps a
body-filled live view or sends those bodies in ordinary snapshots. New tool
history always uses SQLite. Raw legacy records do not each consume a display row.
If the separate tool database is missing or damaged, compact archives still
reopen their ordinary chat, screenshots and widgets. Their tool groups retain
validated references and report detail-read errors; restoring the database can
recover those contents. Legacy truncation already performed by older versions
cannot be reconstructed.
The Pi adapter no longer applies its old 16 KiB display truncation, and drops
completed calls from its active-input map. Pi's own model history is independent.

Storage admission has separate resource limits: 256 MiB of current tool text and
100,000 calls per conversation, excluding SQLite overhead. Exceeding either fails
explicitly before replacing the last committed details; no text is cut to fit.
The existing Pi RPC 8 MiB frame rejection also remains an explicit transport
safeguard, not a panel-history cap. Cumulative running updates are coalesced into
our 40 ms flush, with at most 16 MiB / 128 latest active partials pending per
conversation. Final results supersede pending partials; stop/completion flush
accepted partials before marking calls terminal. Deferred write errors fail the
turn explicitly. Actual writes remain synchronous, so slow storage can delay a
flush, but bursts no longer write each superseded cumulative body. Tool records are
retained on disk with archived conversations. This adds no automatic deletion or
retention policy. Running the old listener against compact archives cannot show
these details; downgrade requires the matching implementation or a legacy backup.
