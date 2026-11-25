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
  "sessionControlsAvailable": true,
  "sessionOrderRevision": "opaque-order-revision",
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

The recent view contains the latest 100 records, newest first, including
audio-only failures (an empty transcript with `transcriptSource: "audio-only"`).
`speaking` is the current VAD speech state, independent of the processing count
(with several [microphones](#microphones-and-listening-browsers), true while any
of them hears speech).
It returns to false on silence, pause, end of input, or capture failure. Older
servers omit this optional field; adapters should treat absence as false.
It is a view limit, not a database retention policy. Snapshot the rows when
opening a picker so new utterances cannot displace its selected item.

### State stream, conversation sync and backpressure

The **first** `state` message on every connection is complete and authoritative,
including `sessions`, `sessionOrderRevision` and `previousSessions`. A client that
applies the ordered conversation events (`agent-session`, `agent-order`,
`agent-history`, `agent-removed`, `agent-restored`) to its retained conversations
declares so with `incrementalSessions: true` in `panel-state`. From then on, for
the rest of that connection, routine `state` messages **omit** those three fields:
absence means "unchanged since the connect snapshot and the events after it".
Activity/status fields (`speaking`, `processing`, `history`, `intents`,
`agentActions`, …) are still complete in every `state`. Speech, processing,
cleanup and outcome updates therefore no longer resend every open transcript.
Reconnects hydrate from a full snapshot again. Treat absent conversation fields
in the first `state` after connecting as empty, as for older listeners without
sessions. Adapters that do not send the field (older installed shells) keep
receiving complete snapshots. An older listener ignores the field and always
sends complete snapshots, which new clients apply as before.

### Listener time

Every `state` message carries `listenerTime`: the listener's clock, in epoch
milliseconds, when it built that message. The connect snapshot always has it,
and so does every later `state` (it is not one of the omitted conversation
fields). Older listeners omit it.

A client whose clock may differ from the listener's (another machine, a phone)
keeps an offset: on receiving a `state` message, `offset = listenerTime -
Date.now()`. It then shows a running turn as `Date.now() + offset -
turnStartedAt`, and converts a message's `createdAt` to its own clock as
`createdAt - offset` before formatting it. Update the offset from each `state`
message; the error is the delivery delay of that message (usually well under a
second, more over a slow relay). Without `listenerTime`, use offset 0. A
client on the listener's machine can also use offset 0. Clamp a negative running
duration to zero.

The listener has one ordered queue per connection. A line is written directly
while the socket is idle; after `write` reports backpressure, later lines wait
for `drain`. Events, replies, errors, `agent-select` and `agent-draft` keep their
order and are never dropped individually. An unwritten `state` is superseded by
the next one: the newer snapshot is appended after the events it already
reflects, so a client never receives a snapshot older than a preceding event.
A client under backpressure may therefore not see every intermediate state (for
example a brief `speaking: true`); the latest state is always delivered.
One slow client does not delay others. Bounds: a connection whose unwritten
ordered backlog exceeds 16 MiB, or whose socket does not drain for 30 seconds,
is closed; the UI reconnects and hydrates. A single message larger than the
backlog bound (such as a large connect snapshot) is still written when the
connection is idle. Queued lines belong to their connection and are never
replayed to a later one.

Commands:

```json
{"action":"toggle-pause"}
{"action":"media-playback","playing":true}
{"action":"toggle-sounds"}
{"action":"set-intent-enabled","name":"SEND_TEXT_TO_APPLICATION","mode":"inference","enabled":false}
{"action":"set-transcription-cleanup","enabled":true}
{"action":"set-capture-storage","enabled":false}
{"action":"paste","id":"stable-uuid","target":"0x123abc"}
{"action":"stop-agent","id":"question-uuid"}
{"action":"close-agent","id":"question-uuid"}
{"action":"reopen-agent","id":"question-uuid"}
{"action":"send-agent","id":"question-uuid","text":"Please explain that further"}
{"action":"choose-agent","id":"question-uuid","revision":"choice-set-uuid","index":0}
{"action":"stop-agent-run","id":"question-uuid","runId":"running-turn-uuid"}
{"action":"composer-focus","id":"question-uuid"}
{"action":"panel-state","id":"question-uuid","composerFocused":true,"incrementalSessions":true}
{"action":"agent-draft-result","requestId":"draft-request-uuid","outcome":"inserted","reason":""}
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
Text must contain 1–8000 characters (whitespace-only is rejected); `target` must
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
SQLite records and recordings remain until explicitly deleted, except the
superseded attempts of a continued utterance (see the `superseded` outcome below).
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
registered intent for an explicit correction. It also requires capture storage
and the entry's own saved capture ([capture storage](#capture-storage)); a
refused label writes nothing. Disabled/context-ineligible
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
`IGNORE` is required and cannot be disabled. The UI renders one card per registered
activity, in router order, containing only its supported modes: an accent-colored
(blue) intent-recognition control and an amber voice-shortcut control that keeps its
phrases visible. Each control toggles only its own mode, shows explicit On/Off (or
Always on) text, and waits for the next snapshot rather than changing optimistically;
the card title is not a control. An enabled route without context stays On and says
it needs conversation context. Cards form a responsive grid that adds columns in wide
panels and wraps at enlarged reader zoom. Cards in one row share the tallest card's
height and title height, so their edges and first controls line up. Transcription and
Storage sit side by side when two readable cards fit and stack at full width otherwise.
If the server lacks these independent
fields, the refreshed UI requests a listener restart and disables the controls.

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

`transcriptionCleanup` in the state snapshot is `{"enabled":bool}`, or null when
the listener has no cleanup support (the UI then hides its switch).
`set-transcription-cleanup` requires a boolean, saves
`transcription-cleanup.json` beside the database (mode 0600, atomic, serialized),
then applies the switch and broadcasts. It returns `cleanup-enabled` or
`cleanup-disabled`. A missing file means off. See
[transcription cleanup](../../docs/transcription-cleanup.md).

### Capture storage

Archiving captured audio and screenshots is off unless the user turns it on
([guide](../../docs/capture-storage.md)). The state snapshot carries
`captureStorage: {enabled, pending, saved, warning}`: `enabled` is the
effective state, `pending` is `""`, `"enabling"` or `"disabling"`, and
`saved: false` with a content-free `warning` means the effective state may
differ from the saved preference (an unreadable file, or an Off that could not
be saved). Older listeners omit the field; clients treat that as unavailable.

`set-capture-storage` requires a boolean and is refused for remote clients.
Enable saves `capture-storage.json` (0600, flushed, atomic, serialized) before
opening admission. Disable closes admission at once, waits for publications
already past their final check, then saves; the reply follows that barrier.
Results are `capture-storage-enabled` and `capture-storage-disabled`; a failed
save is an error reply, and storage then stays (or remains) off.

History entries carry `captureStorage` (`"on"`, `"off"` or null for older rows),
`inputKind` (`"speech"`, `"typed"` or null), `screenshotSaved` and `audioSaved`
(whether that file was published; null for older rows), a derived
`labelingUnavailable` reason (null when no original-media problem is known),
and `screenshotUnavailable` (true when the original was not saved or has
been found missing/corrupt). Publication fields remain unchanged when an
original is later lost. Activity page reads validate current originals,
and failed label/history-image reads publish an updated card to all clients.
The additive `capture_storage`, `input_kind`, `screenshot_saved` and
`audio_saved` database columns preserve publication provenance; current
availability is derived. `"off"` means the capture was deliberately not saved.
While storage is off, or when an entry has a `labelingUnavailable` reason or
lacks a complete PNG (and WAV for speech), `label-history` and the spoken label
shortcuts are refused. Speech is admitted from a recorder-position bound passed
by the listener (`SensorPipeline.submit`'s `capturedFrom`, on the policy clock).
File replay instead retains its start admission through every segment,
including after Off/On transitions. `start-history-agent` requires a validated
original screenshot and never substitutes another one; its admission precedes
the asynchronous original-image read.

History entries (snapshot `history`, `activity-entry` and Activity pages) carry
`cleanupEnabled` (true/false/null), `cleanupStatus` (`cleaned`, `fallback`,
`no-text` or null), `cleanedText` and `cleanupFallback`. `utterance` is always
the raw transcript.

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

`agentActions` is the **voice** projection: it follows the voice target (see
[pop-out windows](#pop-out-windows)), and its `sessionId` is empty when there is
none. A view that should keep showing its own conversation's choices when it is
not the voice target uses the per-connection view projection below.

**View controls.** After a desktop connection's first `panel-state` report,
the listener sends that connection, and only that connection,
`{"type":"agent-view-actions","actions":[...]}` with one `agentActions`-shaped
entry per conversation it shows: its main view's conversation while it owns
the panel selection, and each of its own visible pop-out windows. That is
exactly the set `choose-agent` and `stop-agent-run` accept from that
connection, at most nine entries. `available` and `stopRunId` use the same
rules as `agentActions`, including busy turns, closing conversations and the
global running limit. No entry claims a label is speakable: `voiceAvailable` is
always false, and `voiceReason` only says why an unavailable choice cannot be
selected (empty for an available one). A view takes its voice hint only from
`agentActions` when that has the same `sessionId` and an entry with the same
choice `revision` and `index`. The event is resent only
when that connection's entries change. That covers choices replaced or cleared,
a run starting or ending, capacity changing elsewhere, a window opening or
closing, and another connection taking the panel selection (which retracts the
main-view entry). An empty array means the connection shows no conversation.

Compatibility: an older listener never sends the event. A client that has not
received one on the current connection keeps the older behavior of showing
controls only for the `agentActions` conversation, and it forgets the
projection when the connection drops. Remote connections never receive it;
the phone gateway also refuses it as a desktop-only event. Clicks still send
the stored session ID, revision and index, and the listener rechecks them, so
an outdated projection can only produce a refused request, never another
conversation's choice.

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

SQLite lives at `~/companion/utterances.sqlite`. It uses WAL. Its only automatic
deletion is the retirement of superseded attempts described below. `utterances`
stores the exact transcript, speech-end timestamp, active application/window
identity, recognized intent, and final processing outcome.
Schema version 2 adds `delivery_started_at` to both tables, committed immediately
before starting keyboard input. The automatic row is `delivering` until completion.
An unavailable application or unsuccessful classification is represented by
NULL, not an inferred label.
The `closed` outcome records an explicit `close session` command after the tab
has been saved and removed; it does not delete its conversation archive.

The `superseded` outcome marks a provisional speech attempt that was replaced
because the user resumed speaking before it committed to an action. It plays no
sound and is not a failure. The retranscribed whole utterance follows as its own
row. An attempt replaced before its transcript arrived has no row at all. Since
2026-09-27 a superseded row is removed, with its PNG/WAV, once the final record
of its utterance has its own row and WAV; its Activity card is never published
then, and `history-deleted` (without `removed`) is sent. A final attempt that
failed before its transcript records the earlier words with the combined WAV
and its true outcome. Residual superseded rows remain only after a failed write
or removal, a crash, or a paste/feedback reference. Older `superseded` rows are
not touched. See [final-only retention](../../docs/speech-timing.md#final-only-retention).

`utterances.transcript_source` (nullable, additive, no schema version change) is
`earlier-attempt` when the stored text came from an earlier attempt of the same
continued utterance: a recovered failure or a D2 fallback. It is `audio-only`
for a failed continued utterance that yielded no usable text: the transcript is
empty, the WAV is kept, and paste recovery and history-agent questions refuse
the row. Older checkouts would show such a row as an empty utterance. NULL means
unspecified, including all older rows and typed input; it does not prove that
the whole recording was transcribed. History entries carry it as
`transcriptSource`.

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

Transcription cleanup adds nullable `cleanup_enabled`, `cleanup_status`,
`cleaned_text` and `cleanup_fallback` columns to `utterances` without changing
the schema version. Older builds keep opening the database and ignore them, so
switching back needs no migration. NULL means unknown: older rows, rows written
by an older checkout, or utterances that never reached routing.

Requests prepared while transcription cleanup is on are saved as **version 2**
records with `"promptVariant":"json-cleanup-v1"`; the bare-name prompt keeps the
unchanged version 1 format. Exact-replay export skips version 2, and older
builds refuse it as unsupported rather than mixing it into bare-name data.

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

For a read-only exporter and exact-request model-comparison CLI, see
[intent evals](../../docs/intent-evals.md). It changes only the model ID, freezes
explicit labels and requires `--send` before sending recordings to configured
endpoints. It never runs detected actions or restarts Companion.

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

Only while [capture storage](#capture-storage) is on, and only for observations
admitted while it was on, the sensor pipeline saves the exact captured PNG before
intent routing, at
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

Under the same rule, speech for each retained
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

Older records and supplied `--text` input have no audio. Transcript history still
requires nonempty text. While capture storage is on, empty ASR results have a
separate diagnostic recording:
`~/companion/asr-empty/YYYY-MM-DD/<clip-uuid>/audio.wav` and `metadata.json`.
This separate top-level `asr-empty/` tree stays outside successful recordings in
`data/`. The date uses the observation time; custom database paths use their parent
as the storage root. No empty history row, screenshot, application context, or intent
is saved.

Only a confirmed final ASR `empty` outcome qualifies, with at least 128 ms of input and
strongest-128-ms-window RMS at or above 0.0005. Live audio has already passed the
VAD requirement of 128 ms of voiced frames. These are the existing speech gates;
they do not establish that the sound is intelligible. Silence rejection,
punctuation-only output, worker errors, untranscribed cancelled jobs, overload
drops and provisional attempts replaced by resumed speech do not create these clips.
An empty provisional attempt is retained only after 1.2 s pass after its
endpoint without a continuation. The helper exposes empty **text**, so this does
not distinguish zero raw tokens from special-token-only output.

The transcriber may retry an empty first pass once with padding
([details](../../docs/short-phrase-recognition.md#empty-result-retry)). Retention uses
the final outcome: a recovered transcript follows the ordinary transcript path, and
its WAV is the original, unpadded segment. A clip is retained when the retry is still
empty or was skipped; its diagnostic `emptyRetry` field records which. A retry that
returns punctuation or fails is not retained, matching those first-pass outcomes.
The saved audio is always the captured segment, never the padded retry input.

Each clip keeps the complete 16 kHz mono PCM16 segment, using the ASR conversion.
Metadata version 1 contains its UUID, pipeline frame ID, observation timestamp,
sample rate/channel count, and the numeric transcription diagnostic. An
`asr-recorded` log links the job ID to the saved UUID. The private directory (0700)
and files (0600) are published together by renaming a temporary directory after
both writes finish; readers must ignore `.tmp` directories. Writes are not fsynced.
The pipeline awaits storage before clearing samples, including when cancellation
arrives after ASR completes. Storage failures report the `recording` error stage.

These diagnostic clips survive restart and remain until explicitly removed from
the filesystem; they are not listed or deleted through transcript history. Remove
the clip's UUID directory to remove both files. `--no-desktop` disables their
persistence along with ordinary audio and screenshot persistence.
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
as `labeled` and plays the success cue. Preview mode writes no feedback. While
capture storage is off, for a command spoken while it was off, or for a target
without its saved capture, the command is `skipped`: nothing is written and no
success cue plays.

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

### Microphones and listening browsers

Companion may hear through several microphones at once: the computer's, and
one per paired browser that switched on **Listen here**. The rules (periods,
Pause, continuation per microphone, stored audio) are in
[microphones and listening periods](../sensors/audio/README.md); this section
is the control-socket protocol. Everything here exists only in live
microphone mode; otherwise `microphones` is absent and the actions are refused.

The state snapshot carries:

```json
{
  "microphones": {
    "computer": true,
    "listening": [
      { "id": "computer", "kind": "computer", "name": "Computer" },
      { "id": "<stream uuid>", "kind": "browser", "name": "Phone" }
    ],
    "streams": true
  }
}
```

- `computer`: the computer's microphone switch (D8) is on.
- `listening`: the microphones that listen now, the computer's first, then
  each listening browser (its stream ID and its paired device's name) in the
  order the streams started. The computer is listed only while its ordinary
  listening period runs (not between a lost recorder and its retry, nor while
  Record has the microphone). Empty while paused, and when the computer's
  switch is off and no browser listens: Companion then hears nothing.
- `computerAvailable`: present, and false, only on a listener without a
  desktop, whose computer has no microphone (`computer` is then always false
  and no switch is offered; see [running without a desktop](#speech-without-a-desktop)).
  Absent everywhere else.
- `streams`: a remote connection may open an audio stream.
- Absent in older listeners and outside microphone mode: no switch, and no
  browser can listen.

`speaking` is true while **any** microphone hears speech.

`{"action":"set-computer-microphone","enabled":false}` (desktop and remote
connections) switches the computer's microphone off or on; the results are
`computer-microphone-off` and `computer-microphone-on`. Off ends the
computer's current listening period without cancelling accepted
utterances; on starts a new one unless paused. Not stored: every listener run
starts with it on, like the sound switch. Manual recording still uses the
computer's microphone while it is off.

**Audio streams** (remote connections only; desktop connections are refused).
The remote gateway relays a listening browser's microphone on its existing
connection for that browser; there is no second socket.

- `{"action":"audio-start","deviceName":"Phone"}` opens the connection's
  stream and answers `{"streamId":"<uuid>"}`. The gateway adds `deviceName`
  (the paired device's name, 1–100 characters); a client cannot set it. A
  second `audio-start` on the same connection replaces its stream (the old
  one ends as `replaced`). Refused while paused (`Listening is paused`), at
  shutdown, and when eight listening periods exist (open streams and ended
  ones whose voice detector is still closing; the gateway allows four
  streams). The stream's capture-storage admission is taken now.
- `{"action":"audio-chunk","data":"<base64>"}`: one piece of 16 kHz mono
  signed 16-bit little-endian samples, 2–8192 bytes (an even number), strict
  base64 of at most 10,924 characters. Pieces carry no `requestId`, never wait,
  take no slot and are **not answered** when accepted; a refused piece (no
  stream, malformed) is answered with an error as any request. A piece that
  would make more than 5 seconds of sound (or 250 pieces) wait for the
  stream's voice detector ends the stream (`slow`); sound more than three
  seconds behind real time (plus 1% of the stream's age for clock drift, at
  most 10 seconds) ends it too (`stalled`), whether pieces stopped or only
  trickle.
- `{"action":"audio-stop","streamId":"<uuid>"}` ends the connection's stream:
  `stopped`, or `not-streaming` when it has none. With `streamId` it ends the
  stream only if it is that one (the gateway always names it, so a late stop
  never ends a newer stream). It never waits and takes no slot, so it is
  never refused as busy.
- `{"type":"audio-ended","streamId":"<uuid>","reason":"paused"}` is sent to
  the owning connection only when its stream ended without its asking:
  `paused`, `replaced`, `slow`, `stalled`, `failed` or `shutdown`. It may
  arrive before the answer to the `audio-start` that opened the stream. A closed connection
  ends its stream silently.

`audio-start` and `set-computer-microphone` are listening controls, like
`toggle-pause` (at most 16 in flight per connection).

Activity entries (and `history` rows) of speech a browser heard carry
`microphone` with the device's name; the computer's speech and typed text
have none. It is not stored in the database, so earlier runs' entries never
have it.

**What a paired device can now do** (decision D4, accepted by the user). A
paired device's speech is the user's speech at the computer. By speaking it
can do everything speech can do there, including what its typed requests may
not: type into the application in front on the computer ("insert …",
"enter …", automatic dictation), and start conversations and quick questions
with a fresh screenshot of the computer's window. Which conversation its
speech addresses, and which view "go to session N" changes, follow that
device's own tab (see [speech follows the device that recorded
it](#speech-follows-the-device-that-recorded-it)). Like every conversation a paired device
is shown, such a conversation's saved screenshot (capture storage on) can then
be opened on that device: by speaking, a paired device can therefore obtain a
new screenshot of the computer's window, which its typed requests cannot
(they never capture one). It can also switch the computer's microphone off
and on, as it could already pause listening. It still cannot hear the
computer's microphone or another browser's, fetch a screenshot by any other
route, or use Record.

### Speech follows the device that recorded it

Approved by the user (2026-11-25): **speech goes to whatever is open on the
device that recorded it.** Every utterance carries the microphone that heard
it (`microphone` on the transcript: the computer's, or one browser's stream);
the rule uses only that. The pipeline passes it to
`Activity.interactionContext(microphone)` at speech end, exactly where the
desktop's context has always been captured. Source:
[`browser-views.ts`](browser-views.ts) and the runtime's
`browserInteractionContext`, `navigateBrowser` and `showStartedInBrowser`.

1. **Heard by the computer's microphone** (and typed text): exactly as
   before. The spoken-to conversation is the voice target above (the desktop
   sidebar or an active pop-out window); "go to session N" moves the
   desktop. Browsers do not follow.
2. **Heard by a browser's microphone:** the spoken-to conversation is the one
   the connection that owns the stream reports as selected (`panel-state`
   `id`), also while its page is hidden or its settings screen covers it
   (those reports say `visible: false` and keep the `id`). The desktop's
   selection, pop-out windows and voice-navigation choice play no part. A
   connection that reports no conversation (Activity, Previous sessions), or
   a stream whose connection is gone, gives an utterance with no
   conversation, as on a desktop that shows none; it never falls back to the
   desktop's. A remote connection reports no composer focus, so a follow-up
   is judged with the ordinary unfocused instruction (the prompt text is
   unchanged). `agentTargetSource` is `browser`; `agentView` names the
   connection and the stream.
3. **"Go to session N" heard by a browser's microphone** selects conversation
   N in that browser tab only, counted in the shared order as on the desktop
   (the order is captured at speech end). It is sent as
   `{"type":"agent-select","id","streamId","from","orderRevision"}` to that
   connection alone; `from` is what the tab showed at speech end. "Pop out
   session N" is refused (`popoutHost` is false for a browser). No
   voice-navigation choice is recorded: once the tab reports the new
   selection, its next utterance addresses it.
4. **A conversation started by a browser's speech** (new session, quick
   question, a Claude or Pi session) opens with `openInBackground: true`, so
   desktop panels keep their selection and are not revealed, and that tab is
   sent `{"type":"agent-select","id","streamId","from","started":true}`.
   Before, every desktop panel selected and revealed a conversation started
   by speech (`AgentSessionState.announce`); that is unchanged for the
   computer's speech.
5. **Unchanged on purpose:** typing into the application in front on the
   computer by a browser's speech (D4), the computer's screenshot at a quick
   question (D17), one Pause for everything, sounds on the computer. These
   belong to a later step. (Without a desktop there is no application, no
   screenshot and no sound: see [speech without a desktop](#speech-without-a-desktop).)

**Staleness, mirrored from the desktop.** On the desktop, an utterance is
delivered only while the interaction revision is unchanged since speech end
(any selection, focus, pop-out or navigation change advances it, also away
and back), its target is still the voice target and the conversation is
open; otherwise the follow-up, close or choice is skipped ("The selected
agent conversation or its focus changed"). For a browser's utterance the
same check uses that connection's own **view revision**, which advances on
every change of its reported selection (also away and back), when one of its
reports is refused and its selection dropped (also a report the gateway
itself refuses as malformed), when its conversation closes, and when its page
has gone while its requests still drain (`withdraw-visibility`); a closed
connection has no view at all. A browser's sound can wait for the voice
detector (up to five seconds, for example while the detector loads), so the
view is the one the tab showed when the sound at speech end **arrived**: if
the view changed after that, the utterance counts as changed since speech
end (the piece being read gives the time, so a change at most one piece,
100 ms, before the speech end can still count as before it). Such an
utterance names no conversation at all, so none of the later conversation's
title or text reaches the intent request. In the same way, a "go to session
N" whose sound arrived before the order of open conversations (or its
membership) last changed is refused: N is counted in the order the speaker
saw. Desktop changes do not
affect it, and a browser's changes do not affect the computer's utterances.
The stream that heard the utterance may end meanwhile: accepted speech
continues (as everywhere), and the tab still shows what the speaker saw. Its
navigation is checked again immediately before dispatch: the connection, its
view revision (the token), the order revision, the conversation at that
position, and that the stream that heard it is still that connection's open
stream (the gateway passes `agent-select` only for that stream). A started
conversation is shown only while the view revision is unchanged and the
stream is open; otherwise it waits in the list, in the background.

| Microphone | What is open | Utterance            | Meanwhile (speech end → delivery)         | Result                                                 |
| ---------- | ------------ | -------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Computer   | desktop X    | follow-up            | —                                         | X                                                      |
| Computer   | desktop X    | go to session 3      | —                                         | the desktop selects 3; no browser is told              |
| Computer   | desktop X    | new session          | —                                         | the desktop selects and reveals it, as before          |
| Computer   | desktop X    | follow-up            | browser A selects another conversation    | X                                                      |
| Computer   | desktop X    | follow-up            | the desktop selects another conversation  | skipped, as before                                     |
| Browser A  | A shows Y    | follow-up            | —                                         | Y (not X)                                              |
| Browser A  | A shows Y    | follow-up            | A hidden or under its settings screen     | Y                                                      |
| Browser A  | A shows Y    | go to session 3      | —                                         | A is asked to select 3; desktop and B unchanged        |
| Browser A  | A shows Y    | go to session 9      | — (only three open)                       | nothing                                                |
| Browser A  | A shows Y    | go to session 3      | the order changed                         | nothing                                                |
| Browser A  | A shows Y    | pop out session 1    | —                                         | refused                                                |
| Browser A  | A shows Y    | new session, quick … | —                                         | started in the background; shown in A only             |
| Browser A  | A shows Y    | close session        | —                                         | Y closes (not X)                                       |
| Computer   | desktop X    | close session        | —                                         | X closes, as before                                    |
| Browser A  | A shows Y    | new session          | A selects another conversation            | started in the background; not shown anywhere          |
| Browser A  | A shows Y    | follow-up            | A selects another (or away and back to Y) | skipped                                                |
| Browser A  | A shows Y    | follow-up            | the desktop selects another conversation  | Y                                                      |
| Browser A  | A shows Y    | follow-up            | A's stream ends                           | Y                                                      |
| Browser A  | A shows Y    | go to session 3      | A's stream ends                           | nothing                                                |
| Browser A  | A shows Y    | follow-up            | A's connection closes                     | skipped                                                |
| Browser A  | A shows Y    | follow-up            | Y closes                                  | skipped                                                |
| Browser A  | A shows Y    | follow-up            | Pause                                     | cancelled, as all accepted work                        |
| Browser B  | B shows none | follow-up            | —                                         | no conversation: not delivered, never to the desktop's |
| Browser B  | B shows none | go to session 1      | —                                         | B is asked to select 1; A and the desktop unchanged    |

Tests: `test/unit/speech-follows-device.test.ts` runs this table through the
real gateway, the real control socket, the real processors, synthetic audio
and the test recogniser; `test/unit/pipeline-one-microphone-reference.test.ts`
is unchanged.

Known limits, kept on purpose (minor, and their fix needs new structure):
the tab checks `from` (what it showed) rather than a token of its own, so a
go-to that crosses the reader's own click away and back on the wire (a
few milliseconds), or speech while the tab moves between Activity and
Previous sessions (both report no conversation), can still select; an
`agent-select` already queued in the gateway's output when the stream ends
still reaches the tab that heard the speech; and a conversation a browser's
speech started carries `openInBackground: true` to every client, as
conversations started from a paired device's typed request or by an agent
already do (remote clients ignore it). A browser's stop and choice
identities (the running turn, the offered choices) are read at speech end
like the desktop's, so with a detector that is seconds behind, "stop" can
reach a turn that started in the same conversation after the words were
spoken (the desktop has the same timing, with less delay). A visit away
from Activity that the gateway refuses for its request rate, followed by a
return to Activity, leaves a pending go-to valid (the tab is back on what it
showed at speech end). Sound also waits briefly in the browser before it
is sent (its 100 ms piece, and the page's own work); a click in the tab
within that moment after the speech end can count as before it, as a click
within the voice detector's own delay does on the desktop. And when another
device reorders the conversations while the browser is still speaking, and
the tab receives that new order before the `agent-select`, "go to session N"
counts N in the new order (the desktop's navigation has the same timing).

Also kept on purpose (decided after review): the updated shell and gateway
in front of an older listener route a browser's speech as before (to the
desktop's conversation): update the listener, the gateway and the shell
together. And a reorder on another device while the browser's last piece of
sound is still on its way can change what N means, also after the browser has
finished speaking (the tab receives the new order before the
`agent-select`); preventing it needs the tab's order sent with its sound.

Left out on purpose: speech from the computer's microphone following a
browser on the same machine (switch the computer's microphone off and Listen
here on in that browser instead), choosing a target by voice other than "go
to session N", and a per-device setting for any of this.

### Running without a desktop

`npm start -- --headless` starts the listener on a machine without a desktop
(a server or a VM), reached only through the gateway from a browser. Without
the option nothing changes.

**Rule.** Everything that serves conversations stays: the control socket
(for the gateway), the conversations and their store, Previous sessions,
widgets and their private socket, agents and their wake timers, the
same-user session API when asked for. Everything that touches the computer's
own desktop is absent: its microphone, screenshots of a window, typing into
an application, sounds, media pause, the panel browser and pop-out windows.
An absent ability is never a crash, a hang or a silent nothing: a request for
it is refused with a reason starting "This Companion runs without a desktop"
(for any client, desktop or remote), or the state says it honestly. Speech
stays too, with paired browsers as the only microphones ("Listen here"):
voice detection, recognition and intent routing run on the machine; see
[speech without a desktop](#speech-without-a-desktop) for its rule.

| Ability                                                | With a desktop                          | Without a desktop: what the user sees                                                                                                      | Without a desktop: what an agent gets                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed conversations (start, send, Stop, close, reopen) | As described in this guide              | The same, from a paired browser through the gateway                                                                                        | The same turns, in the agent directory                                                                                                                           |
| Conversation store, Previous sessions, wakes           | Yes                                     | The same                                                                                                                                   | The same session tools and wake timers                                                                                                                           |
| Widgets inline, pinned, session applications           | Yes                                     | The same, on the gateway's frame origin; the widget renderer is headless Chromium in its sandbox                                           | The same widget tools                                                                                                                                            |
| Widget pop-out window                                  | A native Chromium window                | Refused: "Widget pop-out requires a Wayland desktop" (only the native panel offers it)                                                     | —                                                                                                                                                                |
| Listening, Pause and Resume                            | On, with Pause and Resume               | On from the start, with Pause and Resume (one Pause for every listening browser); nothing is heard until a browser switches Listen here on | Spoken input from listening browsers                                                                                                                             |
| The computer's microphone switch                       | Offered (`microphones.computer`)        | Not offered (`microphones.computerAvailable: false`); `set-computer-microphone` is refused: "… and has no microphone of its own."          | —                                                                                                                                                                |
| Listen here (a browser's microphone)                   | With the gateway's `--allow-microphone` | Offered, the same; the only microphones                                                                                                    | —                                                                                                                                                                |
| Speech: where it goes                                  | The desktop's or the tab's view         | The view of the tab that heard it (rule below)                                                                                             | Follow-ups and new conversations as with a desktop                                                                                                               |
| Speech the desktop would type ("insert …", "enter …")  | Typed into the application in front     | Never typed: Activity shows "Not typed: this Companion runs without a desktop" (Skipped)                                                   | —                                                                                                                                                                |
| Plain dictation, no intent model (the default)         | Typed, as the model decides             | A message to the conversation the listening tab shows; with none: "Not delivered: this tab shows no conversation" (Skipped)                | The words, as a follow-up                                                                                                                                        |
| Record into the text box                               | The desktop panel                       | Refused: "… and has no microphone to record with." (`start-recording`, `stop-recording`, `recording-append-result`)                        | —                                                                                                                                                                |
| Sound feedback                                         | Cues through `pw-play`                  | The switch stays off; `toggle-sounds` is refused: "… and has no sound feedback."                                                           | —                                                                                                                                                                |
| Typing into applications                               | `wtype` into the focused window         | Refused: "This Companion runs without a desktop: it cannot type into applications." (`paste`, `submit-utterance`)                          | —                                                                                                                                                                |
| Screenshots of a window                                | With each utterance, and at start       | None are taken; spoken and typed input carry none, and Activity names no application                                                       | Conversations start without a screenshot                                                                                                                         |
| Media pause                                            | Reported by the native panel            | `mediaPauseAvailable: false`; `media-playback` is refused: "… it does not pause for media playback."                                       | —                                                                                                                                                                |
| Panel browser                                          | The native panel opens the page         | —                                                                                                                                          | Not opened: "this Companion panel has no built-in browser. This Companion runs without a desktop; it has no panel browser." (instead of "no panel is connected") |
| Pop-out conversation windows                           | The native panel                        | —                                                                                                                                          | The tool is not offered (no native panel); a request still answers `unsupported`: "… it has no conversation windows."                                            |
| Intent and shortcut switches                           | Shown in settings                       | Shown, for the intents of this mode (no typing intents)                                                                                    | —                                                                                                                                                                |

`--headless` cannot be combined with options that need the desktop or its
microphone: `--text`, `--wav`, `--device`, `--seconds`, `--preview`,
`--graph`, `--paused`, `--no-desktop`, `--no-startup-capture` and `--phone`.
`--no-sounds` is accepted and changes nothing. `--intent-model` is accepted
only with `--headless` (below). The control socket still needs
`XDG_RUNTIME_DIR`, and the locks need `flock`; the widget renderer needs `bwrap` and Chromium at
`/usr/lib/chromium/chromium`, as on the desktop. The transcription cleanup
switch is neither loaded nor offered. Speech needs the recognition worker and
its model (`asr.workerBinary`, `asr.modelDir`; see the
[installation guide](../../docs/installation.md), steps 2 and 3) and the
bundled voice detector model: both are loaded before the control socket
opens, and a missing one stops the start with its reason, as with a desktop.

The runtime directory holds the control socket that the gateway finds by
its path, so a headless start refuses one that another user could replace
(`assertPrivateDirectoryPath` in `src/remote/private-directory.ts`, the same
rule as the same-user session API's). `XDG_RUNTIME_DIR` must be set, absolute
and canonical; no component of it may be a symbolic link; every directory
above it must be owned by this user or root and writable by nobody else,
unless it is root-owned and sticky (like `/tmp`); and the directory itself
must be a real directory owned by this user and closed to everyone else
(`chmod 700`). A trailing slash is refused, and `/` itself counts as an
ancestor. The ordinary `/run/user/<uid>` passes. The check is made by
path once at start. The default start does not make it.

The browser reaches it through the gateway, started separately with the same
`XDG_RUNTIME_DIR` and serving the browser shell instead of the phone app; its
transport rules are the same as with a desktop (see the
[gateway guide](../remote/README.md)). For example, on loopback with widget
frames on a second port:

```sh
npm run shell:build
bin/companion-remote serve --app-directory integrations/shell/dist \
  --frames-listen 127.0.0.1:8788 --frame-origin http://127.0.0.1:8788 \
  --allow-microphone
bin/companion-remote pair   # in a second terminal: a one-time code for the browser
```

Both ports stay on the server's loopback. A browser on another computer
reaches them with the same port numbers through a tunnel bound to that
computer's loopback, for example
`ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 -L 127.0.0.1:8788:127.0.0.1:8788 server`,
and opens `http://127.0.0.1:8787/`. The page then has the gateway's loopback
origin, and widget frames load from `http://127.0.0.1:8788`; forwarding only
the first port leaves conversations working and widgets blank.

`ExitOnForwardFailure=yes` covers the local side only: `ssh` exits instead of
running on when it cannot set up a requested forward, for example because a
local port is already in use. It does not check the server side: the forwards
are set up even when nothing listens on the server's ports (the gateway or
its frame listener not running), and each connection through them then fails
on its own while `ssh` keeps running. Both server listeners must be running.

The gateway's loopback ports are not private on the server: while the
gateway is down, another user of that machine could bind them and a
reconnecting tab would hand its device token to them (see "TCP route" in the
[gateway guide](../remote/README.md#reaching-it-from-a-phone-over-tailscale)).
This setup assumes a server whose other users are trusted.

Each server needs its own gateway origin, so its own local port numbers
(`--port`, `--frames-listen` and `--frame-origin`, the same numbers on both
ends of its tunnel). The browser keeps a pairing per origin, and an open tab
reconnects to its port by itself: if that port later leads to another
server, the tab sends the first server's device token to it, and the
refusal ends the tab's pairing. Never reuse a server's ports for another
server, not even from another browser profile.

Two desktop abilities are left as they are, because only a local desktop
panel or an explicit opt-in reaches them: a widget pop-out still opens when
the listener inherits a working `WAYLAND_DISPLAY` and a local panel asks for
one (the gateway never does), and the opt-in Claude Code desktop tools
(`claude-tools.json`, see `src/agents/claude/parity/README.md`) are still
offered and fail without a compositor.

`--allow-microphone` lets the gateway's own page use the microphone, so
**Listen here** works; without it conversations work but no browser can
listen (the page is served with `Permissions-Policy: microphone=()`).

Whether anything can listen is decided in one place
(`DesktopRuntime.nothingCanListen`): without a desktop and without attached
microphones it would be true, and the runtime would show listening as paused
at start and refuse Resume. The listener attaches the listening browsers
(and the router) before the control socket opens, so the answer is false from
the first snapshot on, and Pause and Resume apply to the browsers as one
Pause for everything.

#### Speech without a desktop

Every utterance comes from a listening browser's stream, so [speech follows
the device that recorded it](#speech-follows-the-device-that-recorded-it)
applies to all of them: the spoken-to conversation is the one the tab that
heard it shows (not another tab of the same device, nor the desktop's),
"go to session N" selects in that tab, and a conversation started by speech
is shown in that tab. No screenshot is taken anywhere on this path: frames
carry none (`SensorFrame`), the router hands them only to processors that
never read one (`ScreenlessProcessor`), a conversation starts without one,
and its Activity entry names no application.

The microphones state is
`{"computer": false, "computerAvailable": false, "listening": [...], "streams": true}`:
`computerAvailable` appears (always false) only without a desktop, so the
state with a desktop is exactly as before; the browser shell then offers no
switch for the computer's microphone. Listening starts on, as with a desktop:
nothing is heard until a tab switches Listen here on, so starting paused
would only add a click.

**The rule.** Commands work by their spoken prefix, with or without an intent
model, exactly as on a desktop: "new session …", "new claude session …",
"new pi session …", "quick question …" (quick questions use Pi), "continue
session …", "close session", "go to session N", "label previous correct" /
"incorrect", and an offered choice's label or "stop" for the running turn of
the conversation the tab shows. "pop out session N" is refused (a browser has
no windows). What the desktop would type into the application in front has no
application here:

- **"insert …" and "enter …"** are never typed and go nowhere else. Activity
  shows them as "Not typed: this Companion runs without a desktop", Skipped
  (`TYPING_WITHOUT_DESKTOP`, a prefix-only processor).
- **Everything else, without an intent model** (the default): a message to
  the conversation the listening tab shows (`CONTINUE_OPEN_AGENT_CONVERSATION`,
  with its usual checks: the tab's view and the conversation unchanged since
  the speech). When the tab showed none at speech end (Activity, Previous
  sessions, or a view that changed while the sound waited for the voice
  detector), the words are not delivered anywhere: Activity shows "Not
  delivered: this tab shows no conversation", Skipped (`NO_CONVERSATION_SHOWN`).
  When the tab showed Y at speech end but changes before delivery (during
  recognition), the follow-up's own check refuses it: Activity shows
  "Continue the open agent conversation", Skipped. The fixed rule is
  `NoIntentModel` (`src/core/no-intent-model.ts`): no intent request is made.
  It cannot tell side talk from a request: everything that is not a command
  becomes a message of the shown conversation, and so goes wherever that
  conversation's agent sends its turns (for example its model provider).
- **Everything else, with an intent model** (`--intent-model`): the model
  chooses among this mode's intents, which never include typing or
  `NO_CONVERSATION_SHOWN`; with no conversation shown it usually answers
  IGNORE. The request carries no image and no `application`; the prompt is the
  desktop's with one sentence added: "This utterance was spoken into a
  browser connected to a Companion that runs without a desktop: …"
  (`WITHOUT_SCREEN_NOTE`). These requests are not recorded for evaluation
  (the recording format holds exactly one screenshot). The model is the
  `llm` section of the configuration (`baseUrl`, `model`, `requestProfile`,
  `timeoutMs`) with the key in `COMPANION_LLM_API_KEY`, as with a desktop.

| Utterance                     | The tab shows a conversation Y | The tab shows none (also: another tab of the device shows Y) |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------ |
| follow-up, plain dictation    | Y, as a message                | not delivered (no model); as the model says (model)          |
| insert …, enter …             | not typed                      | not typed                                                    |
| new session …, quick question | started, shown in this tab     | started, shown in this tab                                   |
| go to session N               | this tab selects N             | this tab selects N                                           |
| stop (Y's turn runs)          | Y's turn stops                 | words like any others (no run named)                         |
| close session                 | Y closes                       | skipped                                                      |
| anything, while paused        | not heard                      | not heard                                                    |

While paused nothing is heard: Pause ends every browser's stream (the tab is
told `paused`) and `audio-start` is refused ("Listening is paused") until
Resume. Pause, as everywhere, cancels accepted speech that has not been
delivered yet.

Tests: `test/headless-voice-table.ts` holds this table (utterance × what the
listening tab shows × intent model absent or present, and the paused row);
`test/unit/headless-voice.test.ts` and `test/unit/headless-voice-model.test.ts`
play it against a real `src/cli.ts --headless` and a real gateway, with real
speech (part of the public fixture) through the real voice detector, the test
recogniser (`test/fixtures/asr-scripted.cjs`), the synthetic Claude Code and,
for the model, a synthetic OpenAI-compatible server on loopback.
`test/shell/headless.test.ts` switches Listen here on in the built shell
(Chromium's fake microphone playing the same fixture) and sees the words
reach the conversation the tab shows.

## Agent sessions

The panel tab controls use a local 1.25× scale on top of the host theme. At the
default theme scale the rail is 80 logical pixels wide, session tabs are
60 × 77.5, Activity is 60 × 80 and Previous sessions is 60 × 75. Icons, labels,
close controls and tab tooltips grow together. Overall panel width and reader
zoom are unchanged; the conversation has 16 fewer logical pixels of width.
Session tabs scroll independently. On surfaces shorter than 305 theme-scaled
pixels, the whole rail can also scroll to keep its controls reachable without
overlap.

The optional `sessions` array in the connect state snapshot (and in every state
snapshot for a client that did not declare `incrementalSessions`) contains
complete chat state for reconnects. A session has `id`, `title`, `status`, `model`, `error`,
`updatedAt` (epoch milliseconds), and `messages`. Status is `starting`, `running`,
`completed`, `cancelled`, or `error`.
Optional turn times (see [turn and message times](../agents/README.md#turn-and-message-times)):
`turnStartedAt` is present exactly while a turn runs (from `starting` until the
turn has finished or failed, or until Stop, which removes it at once) and holds its start in epoch milliseconds
on the listener's clock; `lastTurnDurationMs` is the last finished turn's
duration in milliseconds, whatever its outcome. Show a running duration only
while `turnStartedAt` is present; never keep counting after it disappears.
Both change together when the turn's work ends; `status` follows a moment
later, once the turn is saved, so it can briefly still be `running` without
`turnStartedAt`.
`unread` (boolean) is the listener's shared unread mark, the same for every
client; see [unread mark](#unread-mark). Older listeners omit it.
Each message has `id`, `kind` (`user`, `assistant`, `tool`, or `notice`), `text`,
`toolName`, `input`, `state` (`running`, `done`, or `error`), and a boolean
`screenshot` attachment indicator. Optional `createdAt` is when the listener
created the message (epoch milliseconds, listener clock); it does not change when
the message is updated, and messages saved by older versions have none. An optional `screenshotUrl` is a local file URL
for the private original PNG. It may be absent on older/missing attachments; keep
the question text visible. Image bytes never travel to the UI socket. URLs are
computed from the validated session UUID, not trusted from serialized content.

Between snapshots, `{"type":"agent-session","session":{...}}` carries current
session metadata and **only changed or newly entering window messages**. Upsert by
session/message ID, then retain and order exactly the IDs in `session.history.ids`.
Do not replace the window with this partial array or retain evicted IDs. For older
listeners without `history`, use the legacy unbounded arrival-order upsert.
Streaming updates are coalesced every 40 ms; a terminal status flushes pending
messages immediately. `{"type":"agent-removed","id":"..."}` removes a tab. The
listener never publishes `agent-session` for a conversation that is no longer
open, so a late flush cannot add a closed tab back to an incremental client.
Session metadata may carry `harness: "claude-code"` with
`claudeCode: {model, effort}`; absence means a Pi conversation. `claudeCode.model`
is the next turn's model. The panel and standalone window then list the
`claude-models` result (exact Claude IDs) instead of Pi's models, never request
Pi's `agent-models` for it, and show the fixed effort instead of an effort
picker.
`set-agent-model` with a listed Claude ID changes that conversation's next turn;
other names are refused. `set-agent-thinking` is refused for such a conversation.
Clients that do not know these fields ignore them.
All messages share the ordered socket with snapshots. A newly seen session opens
and selects its panel tab once; further updates and reconnects do not reopen it.
Exception: a live-only `openInBackground: true` marks a tab an agent tool opened
without requesting focus. Clients add it to the rail without selecting it or
revealing the panel. A user message may carry `origin: {kind: "agent",
sessionId, title, depth}`; it was written by another conversation's agent and is
labelled with that title instead of **You**. See [session lifecycle
tools](../agents/README.md#session-lifecycle-tools).
`origin: {kind: "application-event"}` marks host-recorded user edits from the
conversation's session application. Live-only `application` (absent means
HTML chat) describes that application: `id`, `name`, code `version`, state
`revision`, desktop-only `viewUrl`, `text`, `eventMode`, optional `eventStatus`
and `error`. `chatAccess` holds requested capabilities, read permission,
sending status `{grantId, allowed, remaining, busy}` and a permission revision.
Remote/phone snapshots omit `viewUrl`; the gateway passes `chatAccess` on
without `send.grantId` ([what a remote client receives](../remote/README.md#application-chat-access)). See
[session applications](../session-apps/README.md).

The separate trusted `set-application-chat-read` and
`set-application-chat-send` commands take `{id, applicationId,
version, revision, allowed}`. A desktop connection must still show the
conversation, including after a queue wait; a paired remote connection must
show it under its own rule ([application chat access from a paired
device](#application-chat-access-from-a-paired-device)). App identity,
code version and permission revision must match. The returned permission status
is ephemeral; close/reopen, listener restart and successful code replacement
reset it. No agent tool or app-view route can grant it. Sidebar and pop-out
HTML surfaces mount the native consent component below the trusted escape bar;
its dedicated native Client route never becomes an authored-page bridge. These
mounted controls now provide separate read and send disclosures, allow/revoke
controls and sending quota/busy status. They require exact-identity confirmation,
never optimistically change permission, and never retry an uncertain grant.
The authored sender API remains pending; the backend enforces five attempts per
explicit grant, one active slot, two-second spacing and late pre-model checks.
Stop revokes sending before awaiting the queue. See the
[read contract and required disclosure](../session-apps/README.md#optional-chat-read-checkpoint)
and [sender backend contract](../session-apps/README.md#sending-backend).

### Model selection, ordering and spoken navigation

`sessionControlsAvailable` advertises the new controls; older servers omit it and
clients hide/disable them. `sessions` is in authoritative visible order. The client
must preserve that order when applying incremental message updates. A move sends
`{"action":"move-agent","id":"...","beforeId":"...","revision":"..."}`.
An empty `beforeId` appends. Unknown IDs, self-targets and stale revisions fail
without moving anything. The server publishes
`{"type":"agent-order","ids":["..."],"revision":"..."}` after a move or
membership change; apply it without reselecting a tab. The response is `moved`.
Reconnect snapshots include the latest `sessionOrderRevision`. Order lasts for
the listener process; new/reopened sessions append, and listener restart keeps
saved conversations in Previous sessions as before.
If a dragged conversation disappears, the client cancels the gesture and restores
rail scrolling. Each new drag captures its own order revision.

`{"action":"agent-models"}` returns `{models: string[], pinned?: string[], warning?: string,
thinkingLevels: {[model: string]: string[]}, coding: string, quickQuestion: string,
codingThinking: string, quickQuestionThinking: string}` from Pi availability,
Pi-resolved scopes and Companion profile settings. Concurrent refresh requests
share discovery; timeout or malformed data returns an error. Failure of the optional pins helper preserves the full catalogue, omits
`pinned` and includes a fixed `warning`; clients show all models with that notice.
An empty resolved scope instead returns `pinned: []`. Clients discover on
the first conversation needing the catalogue in each connection and on explicit
refresh, then reuse it across tab changes. Failed discovery requires explicit
refresh or reconnect to retry. A cached catalogue stays usable during refresh.
The UI initially shows pinned models, profile default and any selected override;
Show all models exposes the remaining catalogue without changing Pi's pins.
Only an override excluded from the full successful catalogue is unavailable.
Both menus pin rows and conversation until selection or cancellation.

`{"action":"claude-models"}` returns `{models: string[], model: string}`: the
listener's allowlist of exact Claude model IDs plus the configured
`claudeCode.model` (`model`), for a Claude Code conversation's picker. It reads
only the configuration file and starts no process, so it is independent of Pi
discovery; a broken configuration returns an error. Clients request it on the
first Claude Code conversation in each connection and on refresh from such a
tab, with the same caching and retry rules as `agent-models`. An older listener
rejects the action; the picker then offers only the conversation's current
model.

`{"action":"coding-defaults"}` returns the defaults for **new** coding
conversations: `{harness, piModel, claudeModel, revision}`. `piModel` is
`codingDefaultPiModel`, or the top-level Pi `model` when that key is absent;
`revision` identifies the configuration file contents (`missing` before the
file exists). It only reads the file and never creates it; an invalid file
returns an error. Activity's “Start a coding session” card requests it whenever
the card becomes visible, then the catalogue of the shown backend
(`agent-models` or `claude-models`, cached as above).

`{"action":"set-coding-defaults","harness":"pi","model":"provider/id","revision":"…"}`
sets `codingDefaultHarness` and, when `model` is present, that harness's default
model (`codingDefaultPiModel` or `claudeCode.model`); omitting `model` keeps it.
The model must be in Pi's discovered catalogue or the Claude allowlist plus the
configured Claude default. The listener refuses a stale `revision`, a change
while another is being saved, an invalid or non-regular file and write failures,
leaving the file unchanged; otherwise it replaces the file atomically, keeping
every other key and the file mode, and returns the new defaults. Only if
flushing the directory fails after the replacement does the error say that the
defaults were saved but not confirmed on disk. The panel shows
a refusal and reads the defaults again. Existing conversations keep their
harness and model; see [agent contracts](../agents/README.md#defaults-for-new-coding-sessions).
Preview returns `preview` without saving.

`{"action":"set-agent-model","id":"...","model":"provider/id"}` validates the
available identifier, saves `modelOverride`, and returns `model-selected`.
`{"action":"set-agent-thinking","id":"...","thinking":"high"}` validates an
available level for that conversation's selected model, saves `thinkingOverride`,
and returns `thinking-selected`. Empty `model` or `thinking` clears only that
override. Preview returns `preview` without saving. Model/effort changes share a
per-conversation write guard; queued turns wait for accepted writes or rollback.
During validation a turn still captures the old preferences. Rollback is also
queued to disk so a concurrent transcript save cannot retain a rejected choice.
Current turns retain captured settings. Future turns inherit any unset preference
from the profile, with Pi's model-specific effort adjustment; the requested effort
survives model changes. Errors are shown in the panel; clients do not write global
configuration or change another conversation. Older catalogues without supported
effort metadata leave the effort selector disabled.

New clients also include `visible` and `navigationToken` in `panel-state`.
`visible: true` covers Activity and Previous as well as conversations; their `id`
stays empty. Tokens are unique to the UI instance and change when selection,
Previous visibility, panel visibility or connection changes. Token-only reports
update routing without sending a state snapshot. Selection or navigation
availability/owner changes publish at most one snapshot per report. At speech end,
`InteractionContext.agentNavigation` captures that client/token and the immutable
ordered IDs/revision. The `GO_TO_SESSION` shortcut accepts exactly
“go to session 1” through “go to session 32”, also one through thirty-two (a tens word
and a unit joined by one space or hyphen, “twenty one” or “thirty-two”, is one
number), with ordinary
ASR casing/spacing/terminal punctuation. Ordinals, partial, missing, and
out-of-range suffixes are consumed, as are disabled shortcuts; none is passed
to inference or conversation text. At most 32 conversation tabs can be open; requests for higher positions
are rejected even if a stale client reports extra IDs.

Intent recognition may also choose `GO_TO_SESSION`, for example for “hey, let's
switch to session six”. It is offered only while navigation is captured. The
model selects the intent only; the processor then scans the whole raw utterance
(also with transcription cleanup on) for exactly one explicit number, digits or
one through thirty-two, including spaced or hyphenated compounds. A second number
(“twenty or one”, “32 or 2”), an ordinal, a decimal, signed,
out-of-range or other number word, or none at all is skipped and only logged:
“two ideas, switch to session six”, “go to the sixth one” and “session nein” do
nothing. Punctuation separates words but cannot hide a number, and “.6”, “- 6”,
“minus six”, “point six” or “6.5” is never read as 6. Because “one” is often a pronoun (“that one”, “one
of them”), it is a target only right after “session”, “tab”, “conversation”,
“chat” or “number”; elsewhere it counts as an ambiguous mention, so “switch to
one” is skipped. There is no homophone repair, title matching or
reading of numbers from the screenshot or conversation context. The shortcut and
inference routes have separate toggles; the shortcut keeps its strict parser.

Immediately before dispatch the runtime rechecks the client, token, membership
and order revision. It sends only that connection
`{"type":"agent-select","id":"...","token":"...","orderRevision":"..."}`.
The UI rechecks visibility, token, revision and membership before selecting the
conversation, preventing even a socket-delayed command from changing a newer
selection. Successful dispatch records `selected`; this indicates admission to the
owning connection's ordered stream, not a separate UI acknowledgement. If that
connection is closed before the line is written, the command is lost with it and
the reconnected UI has a new token, so nothing stale is replayed. No panel is opened by a hidden
target, and a disconnected client cannot retain navigation ownership. Speech
a listening browser heard navigates that browser tab instead, with the same
checks against its own view (see [speech follows the device that recorded
it](#speech-follows-the-device-that-recorded-it)).

`POP_OUT_SESSION` (“pop out session 1” through “pop out session 32”, also one
through thirty-two; inference may choose it for “pop session three out into its own
window”) uses exactly the same number rules, captured navigation and dispatch
checks. It is offered only while the navigation owner reported `popoutHost`
(`agentNavigation.popoutHost`); for other UIs the shortcut is consumed and
skipped. It sends `{"type":"agent-select",...,"presentation":"window"}`, and
the pop-out host performs its ordinary Pop out of that existing conversation
(moving its unsent text), or focuses the window it already has. A refusal (a
send or recording still being confirmed, eight windows open) is shown in the
panel's error line. Portable panels ignore an `agent-select` with a
`presentation`.

**Navigation selects the voice target.** A dispatched `GO_TO_SESSION` or
`POP_OUT_SESSION` also chooses that conversation for the following speech,
because navigation shows it without taking keyboard focus from a pop-out window
the person was in. The choice takes effect once the owning connection's
`panel-state` shows the conversation as requested (the main view or a window
for go-to, a window for pop-out), or at dispatch when it already does. Until
then the target is unchanged: the previous choice, if any, stays in effect, so
routing never runs ahead of the view. It ends on the next genuine change on that
connection after it took effect (its main view selection, the active window or a
composer's focus), when that connection no longer shows the conversation (for
example its window returned without selecting it), when the conversation
closes, when the connection disconnects or stops owning navigation, or when a
later navigation has been shown. A not-yet-shown navigation survives only
reports with an unchanged view and navigation token; the pop-out host renews
its token when it refuses a pop-out (a send still being confirmed, eight
windows), so a refused request is dropped and never redirects voice. Stale
navigation changes nothing. Clicking into a window that already had focus produces no report and
does not end the choice; the voice indication shows where speech goes.

The optional `previousSessions` snapshot array and
`{"type":"agent-history","sessions":[...]}` contain summaries only: the session
metadata above without `messages`. They are sorted by latest turn first and must
not automatically open tabs or invoke a model. `reopen-agent` emits
`{"type":"agent-restored","session":{...}}` with the complete transcript, then an
updated history list. Replace that session, select it explicitly even if its ID
was seen before, and reveal the panel. It returns `reopened`. When an agent tool
reopens a conversation without focus, the event has `reveal: false`: add or
replace the tab without selecting it or revealing the panel. Closing first stops
the agent and saves its final state; a failed save keeps the tab open and returns
an error. Failed reopen keeps the history entry available for retry. Adapters
must show control errors in the panel as well as retaining drafts.

Snapshots and PNGs live in `~/companion/agents/.companion-sessions`, separate from
Pi's resumable transcript. Writes atomically replace private files. Startup is
read-only and discovers only these snapshots; unfinished turns become stopped.
The question is saved before launching Pi and the transcript at turn completion,
Stop, Close, and orderly shutdown. A hard crash can lose unsaved current output.
No retention limit or legacy Pi-session import is applied.

Agent controls return `stopped`, `closed`, `reopened`, or `submitted`. Follow-ups from a
desktop or remote panel are bounded to 8000 characters (4000 from agents) and
queue while that session is answering, with at most eight
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
Optional `incrementalSessions: true` is a sticky per-connection capability (see
[state stream](#state-stream-conversation-sync-and-backpressure)); a non-boolean
value is rejected. A shell observer while the native window owns the panel sends
it in a neutral report (`id: ""`, no `visible`/`navigationToken`/`draftHost`),
which never changes another connection's selection, focus or navigation.

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

### Pop-out windows

A native UI can show a real open conversation in its own ordinary desktop
window ("pop out") and return it to the sidebar. This is a view operation: the
conversation's ID, agent, history and follow-up queue never change, and no
conversation is created or cloned. The UI owns its windows; the listener only
tracks what the UI reports, uses it for voice routing, and forwards agent
requests. Only desktop connections can take part; remote panels are refused.

A UI that offers windows adds three fields to **every** `panel-state` report,
on the same single connection:

```json
{
  "action": "panel-state",
  "id": "",
  "composerFocused": false,
  "keyboardFocused": false,
  "visible": true,
  "draftHost": true,
  "popoutHost": true,
  "rail": "compact",
  "popouts": [{ "id": "question-uuid", "active": true, "composerFocused": false }]
}
```

- `popoutHost: true` declares the capability. A report without it (or with
  `false`) and without `rail`/`popouts` keeps exactly the older single-view
  semantics; `rail` or `popouts` without the capability is refused. A report
  that drops the capability forgets that connection's windows.
- `rail` is the main sidebar layout: `full`, or `compact` (only the session
  rail is visible).
- `popouts` lists the connection's **visible** windows, at most 8, each an open
  conversation, each conversation at most once, with exactly the fields `id`,
  `active` (it is the focused toplevel) and `composerFocused` (its composer has
  keyboard focus; requires `active`). At most one window is active.
- For such a UI, `id`, `composerFocused` and `keyboardFocused` describe only the
  main sidebar view: `id` is empty while the main body shows no conversation
  (hidden, Activity/Previous, browser, or the compact rail with a popped
  selection). `visible` means any native Companion surface is visible.

The whole report is validated before any state changes; a malformed report is
refused and the previous state stays. Send it on every deliberate selection,
main visibility, window open/close/activation or composer focus change, and
after reconnecting; not because transcripts or titles stream.

**Voice target.** At speech end the target conversation is, in order: the
conversation just chosen by voice navigation, while that choice lasts (see
“Navigation selects the voice target” above); else the active window; else the
conversation visible in the main sidebar body; else,
when exactly one window is visible across all connections and its
connection shows the compact rail, that window as a weak candidate; else none. Several unfocused windows are never guessed
between. Only the chosen view's own focused composer selects the strong
"input field selected" instruction; an active window whose composer is not
focused, and the weak candidate, use the ordinary unfocused instruction. The
prompt text is unchanged. `InteractionContext.agentTargetSource`
(`navigation`/`popout`/`panel`/`popout-only`) records the path for logs and tests; it is not
sent to the model. Any semantic change of the report (rail, window membership,
activation or composer focus) advances the interaction generation, so an
utterance captured before it is refused even when the same conversation stays
the target (for example while moving from the sidebar into its window).
Repeated identical reports, a different window order and streamed updates do
not. Closing a conversation, disconnecting, or withdrawing the capability
removes its windows at once, together with any window composer focus.
Another connection cannot clear this connection's windows. An active window counts as Companion keyboard focus for the delivery
guards (typed Activity text is refused, as with a focused panel), and
activation moving between windows stops pending keyboard delivery.

Controls that require the conversation to be shown (choices, stop, history and
tool pages, manual recording) accept the main view's conversation or one of
the same connection's visible windows. Each of those views keeps its own
choices and stop control through `agent-view-actions` (see **View controls**
above), whichever view is the voice target. A recording continues while its
conversation moves between the sidebar and its window. `agent-select` (spoken
"go to session N") is unchanged; the UI focuses an existing window for a
popped conversation.

**Agent requests.** `companion_session_present` (see the
[agent contract](../agents/README.md#session-lifecycle-tools)) reaches the UI
as a one-time event, sent to one pop-out host (the visible navigation owner if
it is one, else the most recent reporter):

```json
{
  "type": "agent-present",
  "requestId": "present-request-uuid",
  "id": "question-uuid",
  "presentation": "window",
  "focus": false
}
```

The UI answers once with
`{"action":"agent-present-result","requestId":…,"outcome":…,"reason"?:…,"focused"?:…}`:

| `outcome`     | Meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `shown`       | The conversation has its own window (an existing one is reused). Answers `window` only.          |
| `returned`    | Its view is back in the sidebar. Answers `sidebar` only.                                         |
| `unsupported` | This UI cannot open windows now.                                                                 |
| `unavailable` | The conversation is not open in this UI.                                                         |
| `conflict`    | A pending send, choice or recording cannot move between views; the view and its draft were kept. |

`shown` and `returned` must include `focused`: whether the UI observed the view
gaining focus (asking the compositor is not proof). Other outcomes must omit
it. `reason` is optional (≤300 characters); unknown fields are refused. The
listener accepts only the asked connection's first valid answer and returns
`present-recorded`. Without a pop-out host nothing is sent: `unsupported` when
another panel is connected, else `offline`. After sending, 15 seconds without
an answer, disconnection, capability withdrawal or the end of the agent turn
give `unconfirmed`: the UI may have acted, so it is never retried or sent to
another UI. Reconnects never replay a request.

### Text-box drafts (listener-owned, last write wins)

The unsent text of every conversation's text box lives in the listener
(`src/desktop/draft-store.ts`), in memory, keyed by the conversation's stable
ID. The native view and the HTML chat, in the sidebar or a pop-out window, all
read and write that one record; no UI keeps its own authoritative copy. The
rule is simple: **the last write the listener receives wins**. There is no
base revision, merge or refusal because an edit started from older text, and
a delayed edit can therefore overwrite one made elsewhere.

Only draft hosts take part: trusted desktop editors that add `draftHost: true`
to their `panel-state` report, and [remote panels](#remote-panels) whose
reports carry it (the gateway adds it for a client that asked for drafts). A
report without it ends draft hosting for that connection. When a client first
reports it, the listener sends every nonempty draft once (`draft-snapshot`).
Reading never writes.

```json
{
  "type": "draft-snapshot",
  "sequence": 12,
  "drafts": [{ "id": "question-uuid", "text": "Half a question", "source": "", "sequence": 11 }]
}
```

An edit names the conversation it was typed for and an editor-chosen edit ID:

```json
{
  "action": "draft-set",
  "id": "question-uuid",
  "text": "Half a question, now longer",
  "editId": "edit-7"
}
```

The answer is `{"accepted":true,"sequence":13}` or `{"accepted":false,"reason":"..."}`
for an unknown conversation or text longer than may be edited (16,000 UTF-16
units, twice the 8,000-unit Send limit). A connection that is not a draft host
is refused (desktop: "Only a desktop editor can change drafts"; remote: "This
action is only available on the desktop", as before remote draft hosts).
`draft-set` never waits and takes no request slot (see [remote
panels](#remote-panels)), so keystrokes arriving together are all applied in
order. A refused write changes nothing; the
UI keeps the text on screen and says it is not saved. Recorded words may grow a
draft up to 64,000 units (`"recording":true`, accepted only from the panel
recording into that conversation), so a long final dictation chunk is kept
whole. Every accepted change goes to every draft host:

```json
{
  "type": "draft",
  "id": "question-uuid",
  "text": "Half a question, now longer",
  "source": "",
  "sequence": 13,
  "editId": "edit-7"
}
```

`editId` is included only for the client that wrote the change, so it can
ignore its own echo (a newer local edit may already follow it). Other clients
show the change without writing it back. `sequence` orders what is displayed;
it is never used to refuse a write. Showing, switching or reopening a
conversation reads its draft and writes nothing.

A UI treats its text as saved only when the change carrying its own edit ID
arrives, and only for the conversation's latest edit. Text it could not send,
that was refused, or that was unconfirmed when the connection dropped stays on
screen marked as not saved, with Save and Discard; the UI never writes it again
by itself after reconnecting (the draft may have changed elsewhere), and the
conversation does not move to another view or close until one is chosen.
Recorded words are appended by the listener itself, in one step against its
current draft (read, a space if needed, append), so a change made meanwhile by
an agent or another editor is kept. A chunk is kept whole up to 64,000 units or
refused whole. The owning panel still receives `recording-append`, now with
`"applied": true` and the resulting `length`, and only acknowledges it; the
dictation controller uses the listener's real draft length (recording stops
once it reaches 8,000).

A desktop `send-agent`, or one from a remote draft host, clears the draft after
the listener accepted the send, but only if the draft still equals exactly the
sent text: anything typed or recorded meanwhile stays. A send from a remote
panel that is not a draft host leaves the draft alone; such panels can neither
read nor write drafts. Drafts never start a turn and are not saved to transcripts, the
utterance database or logs. They survive views being destroyed and
conversations being closed and reopened while the listener runs; they are not
written to disk, so a listener restart loses them. Empty drafts are removed;
unknown conversation IDs are refused.

### Agent drafts

`companion_session_draft` proposals are applied by the listener to the same
draft map, in one step (`DraftStore.propose`): `inserted` into an empty draft,
`appended` below existing text only with `ifDraftExists: "append"` (after a
blank line), and otherwise `conflict` with the text left unchanged (also when
the result would exceed 16,000 units). Every desktop editor then shows it as an
ordinary `draft` change whose `source` is shown as **Drafted by agent · source
— review before sending** until the person edits it; remote draft hosts get the
same change and `source`. With `focus: true` the desktop client owning
navigation (otherwise the desktop draft host that reported most recently)
receives `{"type":"agent-draft-focus","id":"..."}` and shows that conversation;
otherwise selection and focus do not change. A remote draft host is never
asked to focus. No connected draft host, desktop or remote, means `offline` and
nothing is stored. While a draft host, desktop or remote, reports a send from
that conversation awaiting its reply (`"pendingSend": "<id>"` in
`panel-state`, sent before `send-agent`), proposals for it are a `conflict`,
as when the editor owned drafts; recording does not block them. Drafts never
submit text, start a turn or reorder a queue. `agent-draft-result` answers are
no longer used and are refused as expired.

### Manual recording into the text box

A conversation's composer row has **Record**, beside Send. Recorded speech is
transcribed in chunks and appended to that conversation's unsent draft in the
panel that started it. It never reaches the router, intent inference, voice
shortcuts, transcription cleanup, screenshots, Activity history, capture
storage or an agent turn; Send stays a separate action. Source:
`src/core/dictation/controller.ts` (ownership, queue, delivery),
`src/sensors/audio/dictation-listener.ts` (capture) and the CLI's microphone
loop. Chunking and the microphone handover are described in
[speech timing](../../docs/speech-timing.md#manual-recording).

The state snapshot carries `recordingAvailable` (true only in microphone mode
with this protocol) and `recording`: `{recordingId, sessionId, state,
capturing}` or null, where state is `starting` (waiting for the microphone),
`recording` or `finishing`. `capturing` is true from Record until the
recorder has exited (including `starting` and the moment after Stop), and false
while only transcription is finishing. Global microphone indicators (the
Omarchy bar and the panel's status microphone) show **Recording into a text
box** while it is true, even when listening is paused; the pause state and its
toggle are unchanged. It contains no text. Older listeners omit both; clients then hide
Record. The phone relay removes both fields.

```json
{"action":"start-recording","id":"question-uuid","draftLength":120}
{"action":"stop-recording","id":"question-uuid"}
{"action":"recording-append-result","requestId":"append-uuid","outcome":"appended","length":168}
{"action":"recording-append-result","requestId":"append-uuid","outcome":"unavailable","reason":"…"}
```

`start-recording` requires that this connection reports the conversation as
its visible selection (`panel-state`), that the conversation is not already
closing, that no recording is running or finishing, and `draftLength` (the composer's current length in UTF-16 code
units) below 8000. It returns `{outcome: "recording", recordingId, id}`.
`stop-recording` is accepted only from the owning connection and returns
`finishing`. All three actions are refused for remote panels and run as
controls, never behind a slow paste.

For each non-empty chunk, in speech order, only the owning connection receives
`{"type":"recording-append","requestId","recordingId","id","sequence","text"}`.
The panel appends the text synchronously to the end of that conversation's
draft (a space separates it from text that does not already end in
whitespace), even if another tab is now displayed, and answers once with the
resulting `length`, or `unavailable` if that tab is not open or the
recording is not the one it started. The next chunk is sent only after the
answer. After 5 seconds, disconnection or shutdown the append is
`unconfirmed`; it is never resent, and a later answer is refused as expired.

When the recording ends, the owner receives `{"type":"recording-finished",
"recordingId","id","reason","complete","message"}`. `complete: false` means
recorded speech may be missing; `message` is shown below the text box
(empty after an ordinary, complete Stop) and always says so when speech may be
missing. A failure while finishing (for example ASR after Stop) is reported as
that failure, not as the earlier boundary. Controls run concurrently, so this
event can arrive before the `start-recording` result when the recording ends
at once (for example a quick tab change); panels keep it and apply it when the
result names the same `recordingId`. A `stop-recording` refusal for a
recording the latest state no longer shows also clears it. Reasons:

| Reason                     | Capture stops when                                                                              | Words already captured                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `stopped`                  | Stop recording                                                                                  | transcribed and appended, including the final words      |
| `limit`                    | an append's resulting length is ≥ 8000                                                          | kept whole, even past 8000; Send then asks to shorten    |
| `navigation`               | the owner's `panel-state` shows another conversation, a non-conversation page or a hidden panel | appended to the original conversation                    |
| `paused`                   | listening becomes paused (manual or media)                                                      | appended                                                 |
| `overload`                 | 3 chunks wait for ASR                                                                           | appended; the 4th slot is reserved for the final chunk   |
| `microphone`               | capture or VAD fails, including lost capture (the recorder ended or exited on its own)          | audio before the failure is appended; `complete: false`  |
| `transcription`            | a chunk's ASR fails                                                                             | earlier text kept; later chunks discarded, never retried |
| `delivery`                 | an append is `unavailable`/`unconfirmed`/`offline`                                              | later chunks discarded, never resent                     |
| `disconnected`, `shutdown` | the owner disconnects or the listener stops                                                     | nothing more is delivered                                |

Record may start while ordinary listening is paused; the pause/media state is
not changed, and ordinary listening resumes afterwards only if it is not
paused. One recording exists at a time. While a conversation is recording or
finishing, every close path refuses it: the panel, `close session`, agent
tools, the external API and an agent's deferred self-close. An abandoned
recording no longer blocks closing. Panels disable Send, Close session and a
second Record meanwhile. Drafts remain UI process memory; there is no
recording archive or crash recovery.

### Destination feedback

`Activity.outcome` optionally carries `agent-session` or `new-agent-session` as
its third argument when a processor accepts speech. This does not alter the stored
`started` outcome or signal completion of the agent turn. New coding/quick-question
sessions play `agent-started`; accepted continuations and choices play `agent-sent`.
Application typing/recovery retains `sent`. Completion retains `agent-completed`.
Preview, rejected delivery, cancellation and close have no success sound. All cues
share the existing mute/cancellation queue and are checked against real Silero VAD
using synthetic audio. No speaker-to-microphone acoustic guarantee is implied.

### Paged conversation history

Authoritative history stays in the session's atomic JSON archive, with full tool
bodies in the existing separate SQLite store. Ordinary history is not capped at
4,000 rows or 1M text units. Agent continuity, canonical widget state, origin
anchors and save/reopen operate on that full retained history, not a UI page.
No migration or deletion is performed. JSON saves, reopening and listener memory
still scale with total history; this is not a new storage engine or retention policy.

Snapshots and restored events contain only the recent window, bounded to 200 rows
and 65,536 UTF-16 units of `input + text`. Live `history` metadata contains:

- `start` and `end`: `{index, offset}` positions in the authoritative append-only
  row list. `offset` addresses UTF-16 units in `input + text`; zero at row boundaries.
- `total`: current authoritative row count; `revision`: live content-change counter.
- `ids`: ordered IDs in the recent window, authoritative for incremental eviction.

Deltas include changed and newly entering rows only. Update those rows, then prune
and order by `ids`; reconnect replaces the recent window completely. Optional
`pinnedMessage` is the canonical pin's attachment independently of window membership
(with body omitted); null means no canonical pin. None of these projection fields
are saved to the archive. Archives and in-memory source rows are never fragments.
Every row, including a fragment, keeps its message's `createdAt`.

An explicit page request uses the existing selected-conversation ownership check:

```json
{
  "action": "agent-history-page",
  "requestId": "history-click-1",
  "id": "session-uuid",
  "epoch": "live-toolEpoch",
  "direction": "before",
  "index": 200,
  "offset": 0
}
```

`direction` is `before` (page ending at that position) or `after` (page starting
there). An optional `anchor` is an existing message ID: it selects an `after` page
starting at that row, used for origin tool-group navigation without intermediate
fetches. The result is `{id, epoch, messages, history}` inside the usual correlated
result envelope. Read errors go only to the requester. Invalid positions, unknown
anchors, foreign selection and an old close/reopen epoch are refused. Integer
positions never select files, URLs or model history. Appends preserve positions;
if an updated message shrinks past a requested offset, return to Latest to reset it.

A row larger than the remaining page budget is projected with
`historyFragment: {start, end, total}` (UTF-16 units of `input + text`). The next or
previous page continues that row; concatenating its fragments recovers all original
units. Clients label fragments and copy only the displayed fragment. Tool groups
still have empty bodies and use their own detail paging protocol below.

The phone retains one historical page, replacing it on Older/Newer. Refresh reads
current canonical content from the same start; Latest restores live following.
Historical pages are labelled snapshots when their revision differs from the live
window. Responses are correlated with the request and tab lifetime;
navigation/Latest supersedes pending pages. Loading older history never changes
drafts, submits text or starts a model.

The shared QML panel (desktop/native and portable Omarchy) scrolls continuously
with the same requests (`integrations/panel/HistoryRows.mjs`):

- Scrolling within one viewport of the top requests the page `before` the first
  resident row; scrolling down a detached view requests the page `after` the last.
  Only the reader's own wheel, drag, flick or scroll-bar movement starts a request,
  never layout, resizing, zoom or live updates. One request is outstanding at a
  time. A page is joined only if it ends (or starts) exactly at the current
  boundary, so rows are never skipped or repeated; anything else is a superseded
  answer and is dropped. Failures show the error with Retry and never retry by
  themselves; an empty page marks that boundary and it is not requested again
  automatically. Content too short to scroll offers an explicit Load instead.
- Older rows that end where the live window starts stay **joined** to it: the
  live rows below keep updating. When the window slides forward while the reader
  is away from the end, the rows it drops stay resident and joined. Otherwise
  (or when the bound below requires it) the view becomes a **detached** snapshot
  of resident rows; scrolling down loads newer pages and rejoins the live window
  once they reach it, cutting a fragment that spans the live start so its text is
  neither lost nor repeated. A loaded message that has since grown past the live
  start is not joined as if complete: it becomes an explicit fragment ending at
  its loaded text, and the rest loads as an ordinary page from there. Reaching
  the live end resumes following.
- Resident rows, including joined live rows, never exceed three pages: 600 rows and
  196,608 text units. This is rechecked on every live update, including growth
  without the window moving. Rows are trimmed from the side away from the reader.
  A page whose join would remove rows on screen is dropped instead, as is an
  older page that arrives after the reader scrolled back to the live end. If live
  growth alone leaves no other choice, the view becomes a detached snapshot; rows
  on screen give way only when the bound cannot otherwise hold. The listener's
  page and window limits are unchanged.
- After every join, trim, refresh, resize or zoom, the row at the top of the
  viewport is put back at the same offset. Open tool groups stay open while their
  row is resident.
- A small floating Jump to latest arrow appears whenever the reader is away from
  the live end and discards resident older rows. There is no paging toolbar. A
  status chip floats over the transcript edge only while loading, after a failure
  (Retry) or for a detached view whose revision has changed (Refresh). The
  conversation menu's Refresh loaded messages reloads from the row being read.

Origin jumps load and align the group without expanding tool output. Pins remain
independent of the page. The phone sanitizes screenshot/widget URLs in page replies as in
ordinary session events; widgets remain desktop-only placeholders there.

Upgrade listener and clients together for paging/eviction. Older clients can
still display recent snapshots and deltas, but cannot request older pages or evict
by window membership; their local rows can grow until reconnect. Updated clients
retain legacy upsert behavior with older listeners. Old listener builds with
archive caps may refuse newly grown conversations; preserve current source or a
backup rather than truncating history to downgrade. Activation is a separate
human decision; building these clients does not reload the running app.

### Lazy tool transcript pages

Consecutive tool calls are one `kind: "tool"` message, with empty `text`/`input`
and `toolGroup: {count, revision}`. Its server-generated UUID remains stable as
calls start, update and finish. An intervening user, assistant or notice starts a
new group. Updates to an older call retain that group's original position.
Snapshots, history pages and incremental events contain these summaries only.
A group consumes one row of the bounded display page and no text budget,
regardless of its call count or output length. It remains available for detail
paging even when outside the recent window.

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
escaping), far below each connection's 16 MiB ordered-backlog bound (see
[state stream](#state-stream-conversation-sync-and-backpressure)). Requests
remain under its 32 KiB input bound and 16 outstanding-control limit.
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
UTF-16LE blobs. Session JSON remains an atomic complete chat history with compact tool summaries;
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

### External session message and draft sources

The optional [external local API](../agents/external/README.md) shares session
lifecycle and the existing draft protocol. Messages may additionally carry
`origin: {kind: "external", title, requestId, depth: 1}`. Draft `source` may be
`{kind: "external", title}` without `sessionId`. The shared panel labels these
sources **external (unverified)**, retains existing composer text by default,
and preserves the existing no-focus/explicit-focus behavior. Internal sources
and turn leases keep their current shape and semantics. Update the listener and
shared UI together to display the explicit external attribution.

### Unread mark

Each conversation has one unread mark, `unread`, kept by the listener and the
same for every connected client, desktop or remote. It is part of the
conversation everywhere a conversation is sent: `sessions` in state snapshots,
`agent-session` and `agent-restored` events, and `previousSessions` /
`agent-history`. It is saved with the conversation, so it survives a reload, a
reconnect and a listener restart. A saved conversation without the field (or
with anything but `true`) loads as `unread: false`. Clients that do not know the
field ignore it; the current panel, window and phone keep their own read marks
until they adopt this one.

**Shown on a visible page.** At any moment a conversation counts as shown when
at least one connection shows it on a visible page:

- **Desktop main view.** The desktop selection (the conversation in the latest
  desktop `panel-state` with a non-empty `id`) while the connection that
  reported it says `visible: true` in its latest report. With one panel this is
  the visible navigation owner's selected conversation. Panels report an empty
  `id` while hidden, on Activity, Previous sessions or the built-in browser, and
  a pop-out host while its selection is popped out (the compact rail is shown
  only then): the main view then shows no conversation.
- **Desktop pop-out window.** Every conversation in the `popouts` list of a
  desktop connection whose latest report says `visible: true`. `popouts` lists
  visible windows only; the window need not be active or focused. The compact
  rail itself shows no conversation: a popped-out selection is shown by its
  window.
- **Remote connection.** The connection's own selection (`id` of its latest
  `panel-state`) while that report says `visible: true`. A report without
  `visible` counts as not visible, so a client that never reports it never
  reads a conversation. See [remote panels](#remote-panels).

Composer or keyboard focus is never required. A desktop report without
`visible` (older adapters) counts as hidden. A connection that reported as a
desktop panel can no longer declare the remote role. When a remote client leaves
while its requests still drain, the gateway sends `withdraw-visibility` for its
connection at once (see [remote panels](#remote-panels)).
Only open conversations count: closing a conversation drops every report of it
(a remote connection's selection is cleared too, also for its controls), so
after it is reopened a connection has to report it again to show or control it.

**Setting.** When a turn completes successfully, exactly when the listener emits
`agent-turn-completed` (after the turn's successful save), and no connection
shows the conversation at that moment, the listener sets `unread: true`. A
connection that hides or shows the conversation while that save runs therefore
counts as it is when the save has finished. The mark arrives in the same
`agent-session` update as the completed status and is saved right after.

Saving a changed mark rewrites only the `unread` field of the saved
conversation, never the rest of the live conversation, so it cannot store a
turn's status before that turn's own save has settled it.

**Clearing.** The listener sets `unread: false` and saves it when a connection
shows the conversation on a visible page: at the moment it selects it while
visible, and at the moment it reports becoming visible with it selected (or
opens or reports a visible pop-out window of it). Reports are the only way a
conversation becomes shown, so the listener checks after every `panel-state`,
desktop or remote.

Decisions:

| Situation                                                        | Mark                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn completes successfully, shown on a visible page             | unchanged (read)                                                                                                                                                        |
| Turn completes successfully, not shown (also: no client)         | set                                                                                                                                                                     |
| Turn ends in an error (harness error, failed save, tool storage) | unchanged: an earlier unread answer stays unread, an error never sets it                                                                                                |
| Turn is stopped, or the listener shuts down during it            | unchanged                                                                                                                                                               |
| Turn started by another agent, a session application or a timer  | same rule as a person's turn: only the outcome and who shows it count                                                                                                   |
| Several turns in a row (a queued successor, a follow-up)         | each successful turn applies the rule on its own; a set mark stays until the conversation is shown                                                                      |
| Client disconnects, reconnects or reloads                        | unchanged; the client's first snapshot carries it and its first visible report may clear it                                                                             |
| Conversation closed                                              | unchanged and saved; `previousSessions` carries it. A mark cleared while the close saves is saved again before the tab goes (a failed save keeps the tab)               |
| Conversation reopened from Previous sessions                     | restored as saved, after any save still queued from the close; cleared once a connection shows it (a desktop reopen reveals it, which clears it when the panel reports) |
| Listener restart                                                 | every conversation comes back under Previous sessions with its saved mark                                                                                               |

A mark that cannot be saved stays live and is saved with the conversation's next
save; the failure is logged. `test/unit/listener-unread.test.ts` holds the rule
table: turn outcome × who shows the conversation × what happens next.

### Remote panels

A socket client that relays another device's panel, such as the phone gateway in
[`src/remote/`](../remote/README.md), first sends
`{"action":"client-role","role":"remote"}` and receives `role-recorded`. The role
must be declared before that connection reports any desktop panel, focus,
navigation, draft-host or media state; the listener refuses it afterwards.
Existing clients never send it and keep their current behavior.

For a remote connection:

- `panel-state` records which conversation **that connection** shows (`id`,
  empty for other pages) and whether its page is visible (`visible`, a boolean;
  absent means not visible; anything else is refused). The visible selection
  clears and prevents the [unread mark](#unread-mark). Focus and
  `navigationToken` are ignored. It never changes the desktop's selected
  conversation, speech routing, `go to session` navigation or keyboard delivery
  guards.
- `draftHost` (a boolean) in a remote report makes that connection a
  [draft host](#text-box-drafts-listener-owned-last-write-wins) while its
  reports carry `true`, exactly like a desktop editor: it receives
  `draft-snapshot` and `draft`, may send `draft-set`, and its accepted
  `send-agent` clears an equal draft. `pendingSend` (a string) counts only in
  a draft host's report and has the desktop meaning. A remote draft host never
  receives `agent-draft-focus`, never owns navigation and never records, so
  `"recording": true` never lifts its editing bound. The gateway adds
  `draftHost: true` only for a client that asked for drafts
  ([its rules](../remote/README.md#drafts)).
- `choose-agent`, `stop-agent-run`, `agent-tool-page` and `agent-history-page` check that connection's
  own selection instead of the desktop selection. The desktop cannot act on a
  conversation merely because a phone shows it, and vice versa.
- Choice and stop controls for its selection arrive only on that connection as
  `{"type":"remote-agent-actions","actions":{...}}`, in the `agentActions` shape,
  and only when they change. Global `agent-actions` still describe the desktop
  selection; remote clients should ignore them.
- `paste`, `submit-utterance`, `media-playback`, `composer-focus` and
  `agent-draft-result` are refused: they act on the desktop's focused window,
  keyboard, media or composer focus. So are `coding-defaults` and
  `set-coding-defaults`, which only the desktop Activity page shows, and
  `draft-set` from a remote connection that is not a draft host.
- `{"action":"withdraw-visibility"}` (remote connections only; desktop
  connections are refused) makes the connection show no conversation for the
  [unread mark](#unread-mark) and keeps its selection. It also ends the
  connection's draft hosting and pending send. The gateway sends it when
  its client has left while that client's requests still drain. It names no
  conversation and is idempotent, so it cannot be refused for a remote
  connection; the result is `visibility-withdrawn`.
- `{"action":"report-refused","id":"<conversation or empty>"}` (remote
  connections only; desktop connections are refused) is sent by the gateway
  when it refused one of its client's `panel-state` reports, which named
  `id`. The connection stops counting as visible, and its selection ends
  unless it is `id`. It never selects a conversation and leaves draft hosting
  and a pending send alone. It never waits and takes no slot; the result is
  `report-refused`.
- `set-application-chat-read` and `set-application-chat-send` follow the
  remote rule in [application chat access from a paired
  device](#application-chat-access-from-a-paired-device): allowing needs that
  connection's own selection on a visible page, stopping only its selection.
- `audio-start`, `audio-chunk` and `audio-stop` (remote connections only)
  stream a listening browser's microphone; `set-computer-microphone` is
  allowed for both. See [microphones and listening
  browsers](#microphones-and-listening-browsers). A connection that closes
  ends its stream.
- `send-agent` text allows 1–8000 characters, the desktop composer's bound,
  matching the phone protocol.
- `{"action":"start-agent","text":"…","profile":"coding"}` (or `quickQuestion`)
  starts a typed conversation with 1–4000 characters and **no screenshot**. It uses
  the ordinary tab/concurrency limits, opens in the background on desktop panels,
  and returns `{outcome: "started", id}`. Desktop clients cannot use this action.
- `start-history-agent` reuses the selected utterance's saved screenshot and opens
  the conversation in the desktop background. `reopen-agent` also suppresses
  desktop reveal. Neither path changes desktop dictation selection or captures
  a new screenshot.

Every result/error envelope now echoes a string `requestId` of at most 128
characters when the request carried one, for correlation of concurrent replies.

The listener serves at most 16 socket clients at once, remote and desktop
together; a 17th connection is closed before it receives anything. A request
line may hold at most 128 Ki characters (`maximumRequestLineCharacters`: a
16,000-unit draft written as escaped JSON fits); a longer line, or an
unfinished one that grows past it, disconnects that client. The bound applies
per line, so one read carrying several requests is fine. Each
connection may have 16 control requests in flight; more are refused with
"Previous request is still running". `panel-state`, `withdraw-visibility`,
`report-refused`, `draft-set`, `audio-chunk` and `audio-stop` are always admitted and take no slot: their handlers never wait,
so each finishes right after the read that delivered it, in arrival order. A
batch of reports or keystrokes therefore never makes a following request look
busy, and a gateway withdrawing a departed client's visibility never waits for
that client's slow requests. The gateway
uses at most 8 of them (see [its limits](../remote/README.md#security-model)),
which leaves 8 for desktop panels, observers and tools.
The Unix socket remains the only listener transport; network access, pairing and
authentication belong to the separate gateway process.

#### Application chat access from a paired device

A conversation's session application may read recent chat text or send chat
messages only while allowed (`set-application-chat-read`,
`set-application-chat-send` with `{id, applicationId, version, revision,
allowed}`). The listener checks **who** asks in `handle()`
(`src/desktop/runtime.ts`) when the request arrives, and again with the same
check when the change leaves the application's queue
(`setChatPermission` in `src/session-apps/applications.ts`), so a selection
or visibility that changed while it waited counts.

Rules:

1. **Desktop connection** (unchanged): it must show the conversation, as its
   panel selection or one of its reported pop-out windows. A connection that
   declared the remote role never passes this check. Refusal: "This
   conversation is no longer selected on the desktop".
2. **Remote connection allowing** (`allowed` is anything but `false`): its
   own selection (its latest `panel-state` `id`) is the conversation **and**
   that report said `visible: true`.
3. **Remote connection stopping** (`allowed: false`): its own selection is the
   conversation, visible or not. Turning access off is never harder than
   turning it on.
4. Hence a remote connection that never reported, reports another
   conversation or none, or has gone, can change nothing; one whose
   visibility was withdrawn (its client left, `withdraw-visibility`) keeps its
   selection and can stop but allow nothing. A closed conversation clears
   every remote selection of it. A remote `panel-state` the listener refuses
   (for example naming a conversation that has just closed) ends that
   connection's selection and visibility, since its page has moved on. For
   a report the gateway refuses itself it sends `report-refused` ([remote
   panels](#remote-panels)).
5. Refusals for remote connections: "Open this conversation on this device
   first" when its selection is not the conversation, "Show this conversation
   on this device first" when allowing from a page that is not visible. They
   say nothing about any other connection or device.
6. Then, for every connection, as before: the application ID, code version
   and permission revision must be the current ones ("Application or
   permissions changed; review the current permission controls."); allowing
   needs the application to request that capability; allowing sending needs
   sending to be available.
7. **Preview mode**: rules 1–5 are checked, then the result is `"preview"`
   and nothing changes.
8. There is one grant per open conversation's application, in listener
   memory only. Whoever set it, every connection, desktop or remote, sees the
   same `chatAccess`, and any connection that rule 1 or 3 admits can stop it.
   Closing the conversation, replacing the application's code, a listener
   restart and Stop (for sending) end it, as before.

Cases (tested in `test/unit/remote-app-chat-consent.test.ts`, through the real
gateway and a real control socket):

| Connection | When the request arrives              | While it waits in the queue      | Allow                  | Stop                  |
| ---------- | ------------------------------------- | -------------------------------- | ---------------------- | --------------------- |
| desktop    | shows the conversation                | nothing changes                  | yes                    | yes                   |
| desktop    | shows another conversation            | —                                | no longer selected     | no longer selected    |
| desktop    | shows the conversation                | selects another                  | no longer selected     | no longer selected    |
| remote     | selected, visible                     | nothing changes                  | yes                    | yes                   |
| remote     | selected, hidden                      | nothing changes                  | Show … first           | yes                   |
| remote     | another conversation selected         | —                                | Open … first           | Open … first          |
| remote     | nothing selected (`id: ""`)           | —                                | Open … first           | Open … first          |
| remote     | never reported                        | —                                | Open … first           | Open … first          |
| remote     | selected, visibility withdrawn        | —                                | Show … first           | yes                   |
| remote     | selected, visible                     | becomes hidden                   | Show … first           | yes                   |
| remote     | selected, visible                     | selects another                  | Open … first           | Open … first          |
| remote     | selected, visible                     | client leaves (withdrawn)        | Show … first           | yes                   |
| remote     | selected, hidden                      | becomes visible                  | Show … first (arrival) | yes                   |
| remote     | selected, visible                     | listener refuses its next report | Open … first           | Open … first          |
| remote     | selected, visible                     | gateway refuses a hide           | Show … first           | yes                   |
| remote     | selected, visible                     | gateway refuses a switch         | Open … first           | Open … first          |
| remote     | selected, visible                     | gateway refuses a deselect       | Open … first           | Open … first          |
| either     | admitted, wrong application ID        | —                                | permissions changed    | permissions changed   |
| either     | admitted, old code version            | —                                | permissions changed    | permissions changed   |
| either     | admitted, old permission revision     | —                                | permissions changed    | permissions changed   |
| either     | preview mode, admitted / not admitted | —                                | `"preview"` / refusal  | `"preview"` / refusal |

### Native self-wake visibility

Conversation snapshots/updates optionally carry `wakes`: bounded timer summaries
with ID, label, due/expiry, state, last transition, cancellation intent and linked
turn ID. An occurrence of a repeating timer also carries `recurrence`
(`seriesId`, `everySeconds`, `anchorAt`, `slot`, `occurrence`). The panel and
transcript notice show its interval and occurrence. Pending repeating timers
label their due time as the next run; running ones show the earliest next run
if they finish before that slot (updated while the overlay is open), or that
cancellation ends the series after this run. Finished entries retain the interval
and occurrence without promising another run. These are projections from the dedicated timer store, never restored
as executable transcript messages. The shared panel shows a clock/count on tabs.
The conversation header shows a compact clock with the pending (scheduled/waiting)
count, "Running" when only dispatching/started timers remain, or Attention with
the number of failed, blocked or delivery-uncertain timers in the projection. It
is hidden otherwise; finished timers are listed under the conversation menu's
Timer history. The control opens a bounded overlay (Escape, × or a press outside
closes it; focus and draft stay; only its title and × are fixed, the rest scrolls;
it stays inside the panel, moving up over the header when the panel is short)
with label, state, local due time and zone, relative
due/overdue time, reason, cancellation intent and Cancel; finished timers are
collapsed. When the header is too narrow for both, the clock folds into the
conversation menu: its button shows "!" (attention) or "◷" and lists Timers first.
If the menu button and Browser still do not fit, Browser joins the menu with the
same action. When the conversation area is too short for a usable list, the
overlay may cover the header, composer and footer, but never leaves the panel.
Viewing never acknowledges or clears an attention state. `scheduled-wake` message origins render as **Scheduled wake**,
not **You**. Background restore uses the existing `reveal: false` contract.

The native command `{"action":"cancel-agent-wake","id":"conversation-uuid",
"timerId":"timer-uuid"}` returns the truthful cancellation outcome. It is not
a phone/external scheduling API. Stop/close results include the cancelled count
when nonzero; the tab close tooltip also states the number affected. Cancellation
never edits drafts, selects tabs or requests desktop capture. Old listeners do
not announce the tools, and old session snapshots have no timer UI.
