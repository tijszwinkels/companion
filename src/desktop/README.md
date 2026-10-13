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
`speaking` is the current VAD speech state, independent of the processing count.
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
Each message has `id`, `kind` (`user`, `assistant`, `tool`, or `notice`), `text`,
`toolName`, `input`, `state` (`running`, `done`, or `error`), and a boolean
`screenshot` attachment indicator. An optional `screenshotUrl` is a local file URL
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
“go to session 1” through “go to session 16”, also one through sixteen, with ordinary
ASR casing/spacing/terminal punctuation. Ordinals, partial, missing, and
out-of-range suffixes are consumed, as are disabled shortcuts; none is passed
to inference or conversation text. At most 16 conversation tabs can be open; requests for higher positions
are rejected even if a stale client reports extra IDs.

Intent recognition may also choose `GO_TO_SESSION`, for example for “hey, let's
switch to session six”. It is offered only while navigation is captured. The
model selects the intent only; the processor then scans the whole raw utterance
(also with transcription cleanup on) for exactly one explicit number, digits or
one through sixteen. A second number, an ordinal, a decimal, signed,
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
target, and a disconnected client cannot retain navigation ownership.

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
desktop panel are bounded to 8000 characters (4000 from a remote panel, as from
agents) and queue while that session is answering, with at most eight
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

### Agent drafts

Unsent composer text belongs to a UI instance, not the listener. A client that
can hold agent drafts adds `draftHost: true` to every `panel-state` report;
older clients omit it and never receive drafts. For `companion_session_draft`,
the listener picks one draft host: the client owning visible navigation, else
the one with the most recent report. It sends only that client:

```json
{
  "type": "agent-draft",
  "requestId": "draft-request-uuid",
  "id": "question-uuid",
  "text": "Could you also cover the logout path?",
  "ifDraftExists": "reject",
  "focus": false,
  "source": { "sessionId": "sender-uuid", "title": "🔐 Auth review" }
}
```

The client applies it synchronously and answers with `agent-draft-result`:
`inserted` (the composer was empty or whitespace), `appended` (only with
`ifDraftExists: "append"`, below existing text after a blank line), `conflict`
(existing text kept unchanged, a send from that composer is awaiting its reply,
or the result would exceed the composer's 8000 characters), or `unavailable` (no such open tab).
An optional `reason` (≤300 characters) is passed to the agent. The listener
accepts an answer only from the asked client, only once, and returns
`draft-recorded`. After 5 seconds, disconnection or the end of the agent turn,
the outcome is `unconfirmed`; a later answer is refused as expired. No draft
host means `offline`. Drafts never submit text, start a turn or reorder a queue.

Draft text replaces the composer only when that tab is displayed; otherwise it
waits in that tab's saved draft. The composer shows **Drafted by agent · title —
review before sending** until it is cleared or sent. `focus: true` selects the
tab and reveals the panel after a confirmed insertion; otherwise selection and
keyboard focus do not change.

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
| `microphone`               | capture or VAD fails                                                                            | audio before the failure is appended; `complete: false`  |
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
  neither lost nor repeated. Reaching the live end resumes following.
- Resident rows, including joined live rows, never exceed three pages: 600 rows and
  196,608 text units. Rows are trimmed from the side away from the reader; rows on
  screen are spared unless the bound cannot otherwise hold. The listener's page
  and window limits are unchanged.
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

### Remote panels

A socket client that relays another device's panel, such as the phone gateway in
[`src/remote/`](../remote/README.md), first sends
`{"action":"client-role","role":"remote"}` and receives `role-recorded`. The role
must be declared before that connection reports any desktop panel, focus,
navigation, draft-host or media state; the listener refuses it afterwards.
Existing clients never send it and keep their current behavior.

For a remote connection:

- `panel-state` records only which conversation **that connection** shows (`id`,
  empty for other pages). Focus, `visible`, `navigationToken` and `draftHost` are
  ignored. It never changes the desktop's selected conversation, speech routing,
  `go to session` navigation, keyboard delivery guards or draft hosting.
- `choose-agent`, `stop-agent-run`, `agent-tool-page` and `agent-history-page` check that connection's
  own selection instead of the desktop selection. The desktop cannot act on a
  conversation merely because a phone shows it, and vice versa.
- Choice and stop controls for its selection arrive only on that connection as
  `{"type":"remote-agent-actions","actions":{...}}`, in the `agentActions` shape,
  and only when they change. Global `agent-actions` still describe the desktop
  selection; remote clients should ignore them.
- `paste`, `submit-utterance`, `media-playback`, `composer-focus` and
  `agent-draft-result` are refused: they act on the desktop's focused window,
  keyboard, media or composer drafts. So are `coding-defaults` and
  `set-coding-defaults`, which only the desktop Activity page shows.
- `send-agent` text keeps 1–4000 characters, matching the phone protocol.
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
The Unix socket remains the only listener transport; network access, pairing and
authentication belong to the separate gateway process.

### Native self-wake visibility

Conversation snapshots/updates optionally carry `wakes`: bounded timer summaries
with ID, label, due/expiry, state, last transition, cancellation intent and linked
turn ID. These are projections from the dedicated timer store, never restored
as executable transcript messages. The shared panel shows a clock/count on tabs.
The conversation header shows a compact clock with the pending (scheduled/waiting)
count, "Running" when only dispatching/started timers remain, or Attention with
the number of failed, blocked or delivery-uncertain timers in the projection. It
is hidden otherwise; finished timers are listed under the conversation menu's
Timer history. The control opens a bounded overlay (Escape or × closes it, focus
and draft stay) with label, state, local due time and zone, relative
due/overdue time, reason, cancellation intent and Cancel; finished timers are
collapsed. Viewing never acknowledges or clears an attention state. `scheduled-wake` message origins render as **Scheduled wake**,
not **You**. Background restore uses the existing `reveal: false` contract.

The native command `{"action":"cancel-agent-wake","id":"conversation-uuid",
"timerId":"timer-uuid"}` returns the truthful cancellation outcome. It is not
a phone/external scheduling API. Stop/close results include the cancelled count
when nonzero; the tab close tooltip also states the number affected. Cancellation
never edits drafts, selects tabs or requests desktop capture. Old listeners do
not announce the tools, and old session snapshots have no timer UI.
