# Capture storage

Companion can keep the audio and screenshots it captures, so they can be
inspected, replayed against a model or used for labeling later. That archive
grows without bound, so it is **off by default**. One desktop setting,
**Save captured audio and screenshots** (Activity → Storage), turns it on.

Turning it off does not stop live processing. Speech is still recognized,
the screenshot still goes to the intent model and to agent conversations, and
text history (Activity, conversations, cleanup records) is kept as before.
Retention by Pi, Claude Code or a model provider is separate and is not
controlled by this setting.

## What the setting covers

While off, Companion writes none of these automatic files:

| Capture                      | Location (beside the utterance database)                    |
| ---------------------------- | ----------------------------------------------------------- |
| Utterance audio              | `data/YYYY-MM-DD/audio/<utterance-id>.wav`                  |
| Utterance screenshot         | `data/YYYY-MM-DD/screenshots/<utterance-id>.png`            |
| Empty-ASR diagnostic clip    | `asr-empty/YYYY-MM-DD/<clip-id>/{audio.wav,metadata.json}`  |
| Conversation screenshot copy | `~/companion/agents/.companion-sessions/<conversation>.png` |

This holds in every listener mode, including `--no-desktop`, `--text` and
`--wav`, for Pi and Claude Code conversations, and for queued, continued and
recovered utterances.

The setting never deletes or rewrites completed captures, whether saved
before or while it was on. The only removals are Companion's ordinary ones:
an explicit Activity deletion, and the cleanup of a superseded attempt's own
files when a continued utterance settles into its final record (this happens
whether storage is on or off, and only to that in-flight attempt). Turning
storage off does not delete anything that was already saved.

Not covered: the screenshot and text sent to the intent model and to agents
(they need it), native agent transcripts and provider-side retention, files an
agent or the user writes deliberately, the explicit eval export command, and
text/metadata such as `intent_request` (which stores a checksum reference to
the PNG, never the image itself).

## Preference file

`capture-storage.json` beside the database (`~/companion/capture-storage.json`
for the live app): `{"version":1,"enabled":true|false}`, nothing else.

- Missing file: off, on a fresh install and after an upgrade. Existing
  recordings are not taken as consent.
- Malformed, unsupported or unreadable file: off, with a warning in the
  panel. The file is left as it is; the next explicit click saves a new one.
- Writes are serialized, private (0600 file, 0700 directory), flushed and
  atomically renamed.

The CLI loads the choice before it accepts any capture or agent request.

## Turning it on and off

- **On** saves the choice first. Only captures that _start_ afterwards are
  saved: speech that began before the click is not, and nothing from an
  earlier off period is saved later. A failed save leaves storage off; if
  the failure came after the new file was already in place (for example
  while syncing its directory), the panel warns that a restart may load
  "on", and turning it off again saves "off".
- **Off** applies immediately to new and in-flight captures. The click is
  acknowledged only after files that were already being renamed into place
  have settled; after that no late write can create or replace a capture. A
  file whose write had not reached its rename is discarded. If the choice
  cannot be saved, storage stays off for this run and the panel warns that a
  restart may load the older "on" choice.
- Changes from several clients run one at a time; the panel shows the
  listener's state ("Turning on…", "Turning off…"), never a guess.

Each utterance keeps the decision made when it was admitted, through
continuations, retries and queued agent turns. A continued utterance that
straddles a change is not saved.

When speech starts is decided from the recorder, not from when Companion
gets round to processing it. The listener counts the samples the recorder
delivered since it started; since capture cannot run faster than real time
(allowing 0.2% clock drift), a segment's first sample was acquired no
earlier than the recorder start plus its position. That bound is compared
with the moment storage was turned on, so audio that was already buffered
while storage was off stays unsaved, however long voice detection or the
queue delayed it. In a very long listening period the drift allowance makes
the first few seconds to a minute after an opt-in count as straddling;
those utterances are not saved. A conversation started from an Activity
entry ("New coding session") takes its decision when the request arrives,
before the saved screenshot is read.

## Not saved entries

Activity entries record `capture_storage` (`on`/`off`, null for older rows),
`input_kind` (`speech`/`typed`) and whether their screenshot and WAV were
actually published (`screenshot_saved`, `audio_saved`). An `off` entry shows
**Not saved**. It has no recording to play back or inspect, and "New coding
session" (which starts from the saved screenshot) is not offered; Companion
never substitutes a newer or older screenshot. Copy and insert still work.

An observation whose files were only partly written (its WAV published just
before an Off, but not its PNG; or a write that failed) keeps `on`, because
something was saved, and shows **Partly saved** with what is missing. It
cannot be labeled, and without its screenshot no coding session can start
from it.

A conversation message whose screenshot was not saved stores
`screenshotSaved: false`. The desktop and phone show "screenshot not saved"
for it (not "unavailable", which means an unknown or missing file) and never
show the conversation's PNG from an earlier capture.

Continued speech while off still ends in exactly one Activity record and one
action. Deliberately not saving the audio is not a recording failure; a real
write failure while on keeps the existing recovery behavior.

## Labeling

Labels describe an example whose original capture is available, so labeling
requires capture storage:

- While off (or while an Off is being acknowledged), labeling is unavailable
  everywhere: the desktop and phone buttons are disabled with "Labeling
  requires capture storage.", and the listener refuses `label-history`
  requests and spoken "label previous correct/incorrect" without writing
  anything or playing the success cue. Existing labels stay.
- While on, an entry can be labeled only if its own capture was saved and is
  still complete: a PNG whose chunks and checksums are intact through its
  end, plus, for spoken input, a 16 kHz mono PCM WAV with a nonempty data
  chunk inside the file. Typed input needs no WAV. Older rows (from before
  this setting) are held to the PNG, because typed and spoken rows cannot be
  told apart there. Entries created while off, and partly saved entries,
  never become labelable. Activity cards disable labeling for entries the
  listener knows are incomplete; the listener checks the files again before
  writing any label.
- A spoken label command must itself have been admitted while storage was
  on; one spoken during an off period is not revived by turning storage on.

The intent and shortcut switches for the label commands are not changed.

## Clients and compatibility

The setting is desktop-only. The phone receives the read-only state (to
disable its label buttons) but has no action to change it. A listener without
this feature sends no `captureStorage` state; clients then show the switch as
unavailable, not as off, and do not send the action.

Rolling back to an older listener restores the old always-on recording,
whatever the saved choice says. The listener, UI and installed Omarchy
adapter need to be updated together for the switch to appear.

Protocol details: [desktop interface](../src/desktop/README.md#capture-storage).
