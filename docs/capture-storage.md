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
recovered utterances. Existing files are never deleted or rewritten.

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
  earlier off period is saved later. A failed save leaves storage off.
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

## Not saved entries

Activity entries record `capture_storage` (`on`/`off`, null for older rows)
and `input_kind` (`speech`/`typed`). An `off` entry shows **Not saved**. It has
no recording to play back or inspect, and "New coding session" (which starts
from the saved screenshot) is not offered; Companion never substitutes a newer
or older screenshot. Copy and insert still work. A conversation message whose
screenshot was not saved stores `screenshotSaved: false` and never shows the
conversation's PNG from an earlier capture.

An observation whose files were only partly written when storage was turned
off (for example its WAV, but not its PNG) keeps `on`: something was saved.
It cannot be labeled, because a required file is missing.

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
  still readable: a valid PNG, plus the WAV for spoken input. Typed input
  needs no WAV. Older rows (from before this setting) are held to the PNG,
  because typed and spoken rows cannot be told apart there. Entries created
  while off never become labelable.
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
