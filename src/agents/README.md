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
Freeform speech and typed submissions during a turn queue in that conversation.
They immediately invalidate its old choices; the current turn cannot publish
replacement choices after a follow-up has already been accepted. Choices from
the last queued turn can appear normally. Each queued turn gets a fresh run ID,
so an earlier captured `stop` cannot cancel its successor. Stop clears all
waiting follow-ups as well as cancelling the captured current run.

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

### Try it in the desktop sidebar

Both the listener and the installed sidebar must contain this feature. Running
`npm start` from a feature checkout does not update the installed QML. Older
sidebars ignore choice updates even when Pi successfully calls the tool.

Save any unsent composer drafts before refreshing the sidebar, and stop the
existing Companion listener in its terminal. From this checkout, inside the
desktop session, run:

```sh
npm run asr:build
npm run omarchy:install
npm start
```

The first command builds master's speech-recognition helper for this checkout;
it is needed once per checkout or after changing the helper. The installer
refreshes the sidebar; it does not start the listener. An unchanged bindings
file needs only the plugin rescan, with no Hyprland reload.

Open an agent conversation and send this concrete test request:

> Use companion_choices to offer [Brief] - Explain what a Git worktree is in one
> sentence, and [Detailed] - Explain what a Git worktree is in one paragraph.
> Then finish your turn and wait for my reply.

The two options should appear above the input and become selectable when the
turn ends. Click **Brief**, then ask for the options again and say **Detailed**
while listening is enabled. Each selection should submit its explanation to
the same conversation. A typed or spoken freeform follow-up remains possible.
During a running answer, **stop** should cancel only that selected conversation.

The current voice scope is the visible, selected conversation, including when
its composer lacks focus. Whether to require composer focus remains an open
product decision. Native click/voice testing should account for that scope.

### Automated coverage

`test/unit/agent-choices.test.ts` covers tool validation, payloads, exact and inferred
selection, permanent-prefix priority, freeform input, preview/cancellation,
replacement, stale speech/clicks, stop isolation, disconnect and archive/reopen.
The subprocess fixture in `agent-sessions.test.ts` covers the real RPC boundary,
including failed, partial and unrelated results, plus answer completion after
malformed, missing or unsupported choice metadata. Capacity tests cover a slot
being taken during inference and availability returning after another run stops.
The ordered panel-state/choice-click regression covers the Activity integration:
unchanged focus reports preserve pending keyboard delivery, while acquiring
panel focus invalidates old application dictation without rejecting the click.
`test/panel/tst_choices.qml` exercises actual offscreen clicks, highlighting,
drafts, stale acknowledgements, selected tabs and bounded small-panel layout.

Installed Pi 0.85.1 registered the native extension in an isolated offline startup
probe without sending a model request. A second probe confirmed that Pi's assembled
system prompt contains the tool name, snippet and guideline. A later read-only
inspection of the user's running feature backend found three successful choice
tool calls; the installed older sidebar could not render them. The complete
model-to-panel click/voice loop and native compositor interaction have not yet
been verified for this feature.
No choices are inferred from arbitrary bracketed answer text; the model must use
the tool. The existing headless-backend restriction on unrelated interactive Pi
dialogs remains in effect.
