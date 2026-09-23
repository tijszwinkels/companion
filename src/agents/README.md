# Conversation tools

## Panel history limit

The panel retains up to 800 message bubbles per conversation. Consecutive tool
calls share one collapsed bubble without crossing intervening chat messages.
The separate text/input limit is 1,000,000 JavaScript UTF-16 code units; tool
details consume none of that budget. These are display-history limits, not the
model's context size. Long conversations within these limits can be closed and
reopened; exceeding either still fails the turn. Loading older ordinary chat
history on demand remains future work.

Tool inputs/results stay in private disk storage and are read on explicit
expansion in pages of at most 8,192 UTF-16 units. Separate storage admission caps
are 256 MiB of current tool text and 100,000 calls per conversation, with explicit
failure rather than truncation. See [lazy tool transcript pages](../desktop/README.md#lazy-tool-transcript-pages)
for transport ownership, streaming, legacy recovery and storage limitations.

## Model profiles

“new session …” and inferred `START_CODING_AGENT_SESSION` use the top-level
`model`/`thinking` settings in `~/companion/agents/companion-agent.json` (Astra by
default). “quick question …” selects the prefix-only `QUICK_QUESTION` processor
and the same file's `quickQuestion` model/thinking overrides. It still runs a
normal Pi session with screenshots and the same conversation tools. Default:
`pillar-vllm/qwen3.8-128k`, thinking `off`; the Pi executable is shared.

The optional persisted `AgentSession.profile` is `coding` or `quickQuestion`.
It belongs to the conversation, so queued/spoken/typed follow-ups and restored
conversations select the same profile. Older archives without a profile keep
coding behavior. Settings are read before each turn, so edits take effect without
restarting Companion; they do not alter an already-running turn. New config files
include both profiles, while existing files are never rewritten by the loader.
Provider registration and endpoint/auth settings remain in Pi's normal config.
There is no implicit model fallback; model profiles do not change the detector's
prompt. The whole configuration is validated on each load, so an invalid
quick-question override also prevents a coding turn until it is corrected.
`QUICK_QUESTION` and `START_CODING_AGENT_SESSION` have independent enable/disable
controls; an existing disabled coding intent does not disable the new shortcut.

The bottom model and effort pickers change **this conversation's next turn**,
through optional persisted `AgentSession.modelOverride` and `thinkingOverride`.
They do not change the profile, other conversations, the intent classifier or
configuration files. A running/starting turn retains its captured settings;
queued turns use the choices present when each turn begins. A turn starting
while a choice is still being validated uses the previous preference; accepted
saves and their rollback complete before queued successors start. Both overrides survive
closing, listener restart and reopening. Each “Use profile default” choice clears
only its own override and resumes per-turn configuration loading. The `model`
field still describes the current/last turn; it is separate from `modelOverride`.

The model menu initially shows Pi's pinned/scoped models (`enabledModels`), the
profile-default entry and any existing override. **Show all models** reveals the
rest of Pi's available catalogue; **Pinned models only** collapses it. With no
pins, use Show all models to browse. Refresh reloads Pi settings and availability.
An unpinned selected model stays visible; only a model missing from the full
catalogue is labelled unavailable. These controls do not modify Pi's pins.

Effort offers only levels supported by the selected model, plus the profile
default. Pi's supported-level adjustment applies to both inherited and explicit
preferences: for example, inherited `off` becomes `minimal` on Astra, and any
reasoning level becomes `off` on a non-reasoning model. The picker displays the
adjusted level; its tooltip retains the requested override. Switching models
retains that preference so switching back restores it. An unexpected model or
thinking result still fails the backend's startup check before sending a prompt.

`AgentSessions.models()` asks the configured Pi executable for
`get_available_models` using a bounded offline RPC process, without a prompt,
saved session, tools or automatic resource/extension loading. One explicitly
loaded metadata-only extension reads Pi's resolved `ctx.scopedModels` on startup,
so Pi itself handles global scope patterns and effort suffixes. Discovery retains
`--no-approve`: project-local settings/resources are ignored, as before. It reports
only IDs over a separate inherited pipe and registers no tool or prompt. If that
optional helper fails or its pipe is lost, the full catalogue and effort levels
remain usable with a visible pins-unavailable notice; an actual empty scope still
shows the short pinned menu. A missing helper response falls back at the existing
10-second discovery deadline. The helper checks its marker and pipe type before
writing, so a wrapper cannot redirect its metadata into an ordinary file. The UI
receives identifiers, pins, supported effort levels and profile defaults, never
Pi's full provider objects or credentials. Extension-only model registrations
remain excluded. Selecting an explicit override validates against fresh metadata.
Model discovery alone never creates `companion-agent.json`. Cached catalogues stay
usable while refreshing. Older listeners without effort metadata leave that
selector disabled and keep their previous full-model menu.

Active-session order is owned by `AgentSessions` for the listener lifetime. Moves
reorder the existing run objects, preserving turns, queues, widgets and IDs. New
and reopened tabs append; closing removes only that tab. Order survives client
reconnects through snapshots. Restarting the listener retains the existing policy
of placing saved conversations in Previous sessions; it does not reopen or replay
them automatically, and their former open-tab order is not restored.

## Session names

`companion_name_session` is a small native Pi extension tool that calls
`pi.setSessionName(title)`. Pi 0.85.1 has a naming API and an RPC command, but no
built-in LLM naming tool. The tool's description and prompt guideline ask the
agent to name a new conversation early, preferably with one emoji and 2–4 short
words, such as **🐛 Login fix**. Names are limited to 40 Unicode code points on
one line. A substantial topic change can justify renaming; ordinary follow-ups
should keep the existing name.

Companion reads Pi's native `get_state.sessionName` at startup, after tools, and
once more when the turn settles. There is no custom naming-result protocol and
no additional model request. The final metadata read has a two-second fallback;
an invalid or missing name keeps the existing title without losing the answer.
The sidebar updates immediately after a valid read; the normal end-of-turn save
retains the name for Previous sessions and reopening. A crash before that save
can leave Companion's title behind Pi's until the conversation next resumes.

Verified against installed Pi 0.85.1 in an isolated offline startup: the built-in
tools contain no naming tool; the extension registers its tool and guideline,
and its call to `pi.setSessionName` is observable through native `get_state`.
No model call or desktop interaction was used for this check.

## Session indicators

Open tabs show an accent ring while starting/running, and a mint dot and subtle
tint for an unread successful turn. The leading emoji stays above the short name;
titles without an emoji keep their Q number. Hovering the tab shows its full
plain-text title; hovering the close button shows its separate explanation. Ring animations stop while the panel
is hidden or offline. The existing close control and tab shortcuts are unchanged.

A turn finishing in the visible selected conversation counts as read, without
requiring composer focus. Hidden conversations, Activity and Previous sessions
do not read an answer. Selecting its conversation clears the mark. A queued
successor can have both a running ring and an earlier unread answer.

Live snapshots carry `completedTurnId`, updated only after a successful save.
The UI deduplicates it across updates and socket reconnects, including a success
missed between two running turns. Read marks live in the sidebar instance; a full
sidebar reload can mark the latest live completed turns unread again. This field
is deliberately absent from saved transcripts, so reopening a historical session
does not manufacture a new completion. Old backends without the field can show
running rings but need a listener restart for unread completion tracking.

## Conversation choices

`PiBackend` starts each turn with the native Pi extension `choice-tool.ts` using
`--extension`. Pi 0.85.1 supports this in RPC mode; no MCP service, global plugin
installation, or separate socket is needed. The choice integration does not edit
the base agent system instruction or permanent intent wording. The tool description, Pi `promptSnippet` and one
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

## Session lifecycle tools

`PiBackend` loads `session-tools.ts` for every turn that received a session tool
lease. The native Pi tools start conversations, reopen and close them, and send
or draft messages for other conversations. They reuse `AgentSessions` creation,
reopening and follow-up FIFO logic; they do not add another session store or
load Pi session files. `SessionToolService` (`session-tools-service.ts`) is a
loopback HTTP endpoint with a random bearer token per agent turn. The token
names the calling conversation, so a tool cannot claim another sender. It
expires when the turn ends or is stopped. Authority is checked again after a
request body arrives and at each action's commit point; a reopen also rechecks
it after reading the archive. A request that has not reached its commit point
when its turn ends therefore changes nothing and fails with `expired`. Actions
already committed stay committed: an accepted send remains queued or running,
and a draft already forwarded to the panel reports `unconfirmed` because the
panel may have inserted it. Targets are Companion session UUIDs
from the tool's own listing; malformed IDs, paths and unknown IDs are refused.

| Tool                       | Parameters                                                                                      | Effect                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `companion_sessions`       | `query?` (≤100), `limit?` (1–50, default 20)                                                    | Lists open tabs and matching saved conversations. No transcripts or drafts.                     |
| `companion_session_start`  | `text` (1–4000), `profile?` `coding`\|`quickQuestion`, `model?` provider/id, `focus?` (false)   | Opens a tab whose agent immediately answers `text`.                                             |
| `companion_session_reopen` | `id`, `focus?` (false)                                                                          | Reopens a saved conversation with its ID, transcript, profile and model. Starts no turn.        |
| `companion_session_close`  | `id`                                                                                            | Closes an open tab, saving it to Previous sessions; the caller's own tab closes after its turn. |
| `companion_session_send`   | `id`, `text` (1–4000)                                                                           | Follow-up to another open tab; starts its turn or queues behind earlier messages.               |
| `companion_session_draft`  | `id`, `text` (1–4000), `ifDraftExists?` `reject`\|`append` (default `reject`), `focus?` (false) | Places unsent text in that tab's input for the user to review. Never submits or runs a turn.    |

`companion_sessions` matches titles only. Its prompt guidelines also tell the
agent how to search contents: grep `.companion-sessions/*.json` in the agent
working directory (`~/companion/agents` by default). Each archive's file name is
the conversation ID. Pi's own session directory can also contain sessions that
Companion did not create; those IDs are refused as `unknown-session`.

Examples of tool arguments:

```json
{}
{"query":"login","limit":5}
{"text":"Review src/auth for token expiry bugs and summarise them.","profile":"coding"}
{"text":"What is the weather in Utrecht?","profile":"quickQuestion","model":"pillar-vllm/qwen3.8-128k"}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","focus":true}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","text":"The migration is merged; please rerun your checks."}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","text":"Could you also cover the logout path?","ifDraftExists":"reject"}
```

A successful call returns JSON, for example `{"outcome":"queued","queuePosition":2,
"session":{...}}` or `{"outcome":"reopened","messages":14,"session":{...}}`.
Summaries contain `id`, `title`, `status`, `profile`, `model`, optional
`modelOverride` and `updatedAt`; open entries add `busy`, `queuedMessages` and
`self`. A refusal is a failed tool result whose message ends with a stable code:

| Code                      | Meaning                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `invalid`                 | Malformed ID, empty/oversized text, or unsupported option.                                                |
| `unknown-session`         | No open or saved conversation has that ID.                                                                |
| `not-open`                | Saved but closed; reopen it first. Sends/drafts never reopen implicitly.                                  |
| `self-target`             | `companion_session_send` to the calling conversation.                                                     |
| `loop-limit`              | The turn is already three agent-to-agent hops from a human message.                                       |
| `duplicate`               | Identical content to the same destination already delivered (or possibly delivered) in this turn.         |
| `limit`                   | More than six start/reopen/close/send/draft actions, or 32 calls, in one turn.                            |
| `busy`                    | Close refused: another conversation is running, closing or has queued messages; nothing was stopped.      |
| `unavailable-model`       | The requested model is not in Pi's current catalog; there is no fallback.                                 |
| `expired`                 | The calling turn ended; its lease is gone.                                                                |
| `rejected`                | An existing lifecycle limit: 12 tabs, 4 running agents, 8 queued messages, or a stopping/closing tab.     |
| `conflict`                | Draft refused: the user has unsent text there (kept unchanged), a send from it is pending, or 4000 chars. |
| `unavailable` / `offline` | Draft refused: the panel lacks that tab, or no draft-capable panel is connected.                          |
| `unconfirmed`             | The panel did not confirm within 5 s or disconnected; the draft may exist. Do not resend.                 |

**Attribution.** A sent or starting message is stored as a `user`-kind bubble
with `origin: {kind: "agent", sessionId, title, depth}`. The panel labels it
**Agent · title** instead of **You**, and the label survives closing and
reopening. Pi receives the text after a header beginning
`[Companion agent message] Written by the agent of another Companion
conversation, "<title>" (session <id>), not typed by the user.` Human messages
are sent unchanged. Agent-started conversations have no screenshot.

**Ordering and busy targets.** Sends use the same FIFO as typed and spoken
follow-ups: they never interrupt a running turn, never overtake earlier queued
messages, and are cancelled with the rest of the queue by Stop or a failed turn.
The existing limits of eight queued messages and four running agents apply.
Each queued turn gets a fresh lease and inherits its own message's depth.

**Loops and duplicates.** Depth is 0 for a human-originated turn and origin
depth + 1 for an agent message. Start and send are refused beyond depth 3,
which allows "A asks B, B answers A, A follows up" and stops further ping-pong.
Drafts wait for the user and do not extend the chain. Pi's tool-call ID is a
receipt: repeating a call returns the first reply without acting again. Identical
text to the same destination is refused for the rest of that turn, including
after an `unconfirmed` draft. A definite refusal releases that content for retry.

**Drafts.** Only a UI owns unsent composer text, so the listener forwards a draft
to exactly one draft-capable panel and waits for its answer (see the
[desktop protocol](../desktop/README.md#agent-drafts)). The panel inserts text
only into an empty composer, or appends below existing text when asked. It
reports a conflict while that composer's own send is awaiting confirmation. The
composer shows **Drafted by agent · title — review before sending** until the
text is cleared or sent. Drafts in hidden tabs wait in that tab. The user's own
text is never replaced, and nothing is submitted.

**Closing.** `companion_session_close` saves the tab to Previous sessions exactly
like the close button, with outcome `closed`; a saved ID returns `already-closed`.
It refuses a running or queued conversation as `busy` instead of stopping it: an
agent must not discard another conversation's work. An agent closing its own tab
gets `closing-after-turn`. Closing inside its own tool call would stop that turn,
so the tab closes after the turn completes and its answer is saved. A failed or
stopped turn, any message queued before it finishes, or Stop pressed after the
turn settled but before the deferred close ran, cancels the close. The
answer then remains readable after reopening from Previous sessions.

**Focus.** Starting or reopening opens the tab in the background by default. It
appears in the rail and runs, but the selection and panel visibility do not
change (`openInBackground`, `agent-restored` with `reveal: false`). A quiet
reopen also sets `openInBackground`, so a client that missed the event does not
select it from its next snapshot. `focus: true`
selects it and reveals the panel. A focused draft selects its tab only after a
confirmed insertion. Sends never change focus; completion shows the unread dot.

Limitations: the tools cannot read another conversation's transcript; a
receiving agent answers in its own tab or, if asked, sends a reply back. There
is no empty-conversation-with-draft mode: a new conversation always starts with
its first message. The draft host is the panel owning visible navigation, or
the most recent draft-capable panel report, so two simultaneously open panels
do not share drafts. `openInBackground` is a live flag; a restarted UI instance
that sees a background tab for the first time applies it too.

**Update the listener and UI together.** Only drafts are negotiated
(`draftHost`). A UI older than these tools still works with a new listener, but
it ignores `openInBackground`, `reveal: false` and `origin`. It selects and
reveals agent-opened or quietly reopened tabs, and shows agent-written messages
as **You**. Never deploy only the listener while agents use these tools.

Automated coverage: `test/unit/session-tools.test.ts` drives the real extension
tools through leases issued to a scripted backend: create/reopen identity and
history, profile/model preservation, bad/saved/self/stale targets, busy FIFO
ordering, loop limits, receipts and duplicates, draft outcomes, provenance
validation, and closing other/own conversations. `session-drafts-desktop.test.ts` covers the socket protocol, and
`test/panel/tst_session_drafts.qml` and `test/window/tst_client.qml` cover the UI.
An isolated offline startup of installed Pi 0.86.1 registered and activated all
six tools and included their guidelines in the system prompt; it made no model
request, and no live agent has yet called these tools in a real Companion.

## Verification and limits

### Widgets

The Pi backend also loads `widget-tools.ts` when the turn has a widget lease.
`companion_widgets`, `companion_widget`, `companion_widget_update`,
`companion_widget_call` and `companion_widget_present` discover, publish, mutate
and place reusable widgets. See [the widget guide](../../widget-library/README.md)
for schemas, retained bundles, durable state and renderer limits. Widgets and
their fallback text participate in the shared transcript bounds; tool output is
not an unlimited extra transcript store.

### Try it in the desktop sidebar

The listener, UI and installed Omarchy bridge must contain the intended feature.
`npm start` does not update installed QML or reload a running native UI. See
[the development guide](../../docs/development.md#updating-what-actually-runs)
for component-specific activation, and [the native host guide](../../native/window/README.md)
for standalone build dependencies. Save unsent drafts before stopping a UI.
An older sidebar can ignore choice updates even when Pi successfully calls the tool.

Open an agent conversation and send this concrete test request:

> Use companion_choices to offer [Brief] - Explain what a Git worktree is in one
> sentence, and [Detailed] - Explain what a Git worktree is in one paragraph.
> Then finish your turn and wait for my reply.

The two options should appear above the input and become selectable when the
turn ends. Click **Brief**, then ask for the options again and say **Detailed**
while listening is enabled. Each selection should submit its explanation to
the same conversation. A typed or spoken freeform follow-up remains possible.
During a running answer, **stop** should cancel only that selected conversation.

Voice choices and `stop` stay active while the side panel is open on the owning
conversation, including when its composer lacks focus. This is the user-approved
scope: moving keyboard focus to another application does not disable them.
Hiding the panel or selecting another tab removes the old conversation's routes.

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
tool calls; the installed older sidebar could not render them. These were initial
branch observations, not a current installation check. Later user feedback
reported working choices; current deployment/review evidence lives in the feature
ledger. Automated tests do not prove every live voice or compositor interaction.
No choices are inferred from arbitrary bracketed answer text; the model must use
the tool. The existing headless-backend restriction on unrelated interactive Pi
dialogs remains in effect.
