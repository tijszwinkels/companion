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
  "speaking": false,
  "soundsEnabled": true,
  "processing": 0,
  "preview": false,
  "history": [
    {
      "id": "stable-uuid",
      "observedAt": 1789600000000,
      "utterance": "Please send this text.",
      "application": "org.gnome.TextEditor",
      "intent": "IGNORE",
      "outcome": "ignored"
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
{"action":"toggle-sounds"}
{"action":"paste","id":"stable-uuid","target":"0x123abc"}
```

Replies are `{"type":"result","action":"paste","result":"sent"}` (or `skipped`, `preview`,
`paused`, `listening`, `sounds-enabled`, `sounds-muted`) and
`{"type":"error","action":"paste","message":"..."}`. The action identifies the
request when control replies overtake a slow paste. Sound feedback can be muted independently
of listening. Muting stops current and queued cues. `--no-sounds` sets the initial
state; controls can enable sounds later. This setting lasts for the process's
session. Preview mode is always silent and rejects `toggle-sounds`.
One paste per connection runs at a time; pause/mute controls run independently
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
Recovery's initial focus lookup and keyboard output have a five-second deadline.

SQLite lives at `$XDG_STATE_HOME/companion/utterances.sqlite`, defaulting to
`~/.local/state/companion/utterances.sqlite`. It uses WAL and has no automatic
deletion. `utterances` stores the exact transcript, speech-end timestamp, active
application/window identity, recognized intent, and final processing outcome.
Schema version 2 adds `delivery_started_at` to both tables, committed immediately
before starting keyboard input. The automatic row is `delivering` until completion.
An unavailable application or unsuccessful classification is represented by
NULL, not an inferred label. No raw audio or screenshot is saved.

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
