# Conversation choices

`PiBackend` starts each turn with the native Pi extension `choice-tool.ts` using
`--extension`. Pi 0.85.1 supports this in RPC mode; no MCP service, global plugin
installation, or separate socket is needed. Existing system and intent prompt
text remains unchanged. The tool description, Pi `promptSnippet` and one
tool-specific `promptGuidelines` entry teach the model how to offer choices.

The `companion_choices` tool accepts these equivalent presentation forms:

```json
{"options":["[Tests] - Run the tests", "[Explain] - Explain the change first"]}
{"options":[{"label":"Tests","description":"Run the tests"}, {"label":"Explain","description":"Explain the change first"}]}
{"options":["Yes", "No"]}
{"options":[]}
```

Each call atomically replaces the owning conversation's choices; an empty array
clears them. The limit is eight options, 60 characters per label and 1000 per
description. Labels must remain distinct after voice normalization. Selecting
submits the description, or the label when there is no description, as an ordinary
follow-up in the same Pi session. There is no hidden command or action payload.

The tool returns immediately. Choices appear above the composer during the turn
and become selectable when it has finished and the session can accept a follow-up.
The four-concurrent-agent limit also controls availability. If another session
takes the last slot during inference, the selection is skipped rather than
starting an extra run or reporting a submission error.
The model should finish its answer after offering choices, not wait for the user
inside the tool. The composer always permits writing freeform text, including
while the agent runs; choosing an option preserves that draft.

## Routing and lifetime

Only successful, correlated `companion_choices` tool completions publish structured
choices. Assistant Markdown, streamed tool fragments and other tools' results
never become actions. Validation happens in the tool and again at the backend
boundary. Missing, malformed or unsupported choice metadata clears the previous
options and adds a notice, while the answer continues normally. This also covers
another Pi extension rewriting the tool result's `details`. Session callbacks are
ignored after completion, stop, close or shutdown.

`AgentChoiceIntents` supplies ephemeral routes to `UserSensorRouter`, leaving the
permanent processor registry and its switches intact. Permanent prefixes resolve
first, even when disabled. Exact full-label matches then bypass inference; other
utterances can select a described choice through normal intent inference. Freeform
continuation remains available. Voice matching ignores casing, repeated whitespace
and trailing `.`, `!`, or `?`; it does not strip arbitrary punctuation, match prefixes,
or invent aliases. A permanent-prefix collision disables that choice's exact voice
shortcut but leaves it clickable. `stop` is reserved among choice labels.
Options that were unavailable at speech capture do not reserve their ordinary
labels; that speech follows normal intent routing. Genuine stale selections that
were available at capture still fail the identity/revision check before acting.
Inference receives each label and a description preview of at most 160 characters;
the full description remains visible and is submitted on selection.

Speech captures the visible conversation, interaction revision, immutable choice
set and running turn ID before transcription. Dispatch checks that they still
match. Switching tabs, hiding/reopening the panel, disconnecting its owner,
replacement or an intervening follow-up cannot redirect old speech to new choices.
Exact stale selections are consumed as skipped actions. Clicks similarly carry
the conversation, choice revision and option index; the desktop server checks
panel ownership and the session resolves the payload itself.

While the selected conversation has a running turn, the exact utterance `stop`
targets that run. It does not use inference and cannot cancel other conversations
or a subsequent turn. The composer shows `[stop]` for the same lifetime. Clicking
it uses the same run identity. The existing session Stop control remains compatible
with older clients.

Choices are consumed on any accepted follow-up and cleared on stop, failure, close
and shutdown. They are transient: archived/restarted/reopened conversations retain
their transcripts but do not restore actionable choices. A transport reconnect to
the same live server receives the current choices in its snapshot.

## Verification and limits

`test/unit/agent-choices.test.ts` covers tool validation, payloads, exact and inferred
selection, permanent-prefix priority, freeform input, preview/cancellation,
replacement, stale speech/clicks, stop isolation, disconnect and archive/reopen.
The subprocess fixture in `agent-sessions.test.ts` covers the real RPC boundary,
including failed, partial and unrelated results, plus answer completion after
malformed, missing or unsupported choice metadata. Capacity tests cover a slot
being taken during inference and availability returning after another run stops.
`test/panel/tst_choices.qml` exercises actual offscreen clicks, highlighting,
drafts, stale acknowledgements, selected tabs and bounded small-panel layout.

Installed Pi 0.85.1 registered the native extension in an isolated offline startup
probe without sending a model request. A second probe confirmed that Pi's assembled
system prompt contains the tool name, snippet and guideline. Live model tool use, microphone/ASR behavior
and native compositor interaction have not been exercised for this feature.
No choices are inferred from arbitrary bracketed answer text; the model must use
the tool. The existing headless-backend restriction on unrelated interactive Pi
dialogs remains in effect.
