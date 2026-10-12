# Conversation tools

## Paged panel history

Companion retains the complete conversation separately from the displayed page.
The recent window and each requested older/newer page contain at most 200 rows
and 65,536 JavaScript UTF-16 text/input units. These are display budgets, not
admission limits or model context limits: crossing them does not fail a turn.
Individual oversized messages span explicitly labelled fragments. Load older,
Newer, Refresh and Latest navigate one bounded page at a time on desktop and phone.
Historical pages are snapshots; updates offer explicit refresh without moving the
reader. Consecutive tool calls share one collapsed row without crossing chat.
Canonical pinned widgets remain available outside the current transcript page.

Stored JSON history remains whole-file and is fully loaded when opening a tab;
this change bounds display/transport, not total storage or listener memory. It
neither rewrites old archives proactively nor alters the harness's model history.
Close/reopen and further turns retain the same conversation. See the
[paging contract](../desktop/README.md#paged-conversation-history) for client and
downgrade compatibility.

Tool inputs/results stay in private disk storage and are read on explicit
expansion in pages of at most 8,192 UTF-16 units. Separate storage admission caps
are 256 MiB of current tool text and 100,000 calls per conversation, with explicit
failure rather than truncation. See [lazy tool transcript pages](../desktop/README.md#lazy-tool-transcript-pages)
for transport ownership, streaming, legacy recovery and storage limitations.

## Model profiles

“new session …” and inferred `START_CODING_AGENT_SESSION` use the top-level
`model`/`thinking` settings in `~/companion/agents/companion-agent.json` (Astra by
default) when they run on Pi, the default harness (see [Harnesses](#harnesses)). “quick question …” selects the prefix-only `QUICK_QUESTION` processor
and the same file's `quickQuestion` model/thinking overrides. It still runs a
normal Pi session with screenshots and the same conversation tools. Default:
`pillar-vllm/qwen3.8-128k`, thinking `off`; the Pi executable is shared.

A conversation started from speech (or from an Activity entry) sends its
screenshot to the agent, Pi or Claude Code, in every case. Companion keeps a
copy (`.companion-sessions/<id>.png`) only while
[capture storage](../../docs/capture-storage.md) is on, and only for a
screenshot admitted while it was on; otherwise the question stores
`screenshotSaved: false` and never shows an earlier PNG of that conversation.

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

## Harnesses

Each conversation runs on one harness for its whole lifetime: `pi` (the Pi RPC
process described above, which also serves the OpenAI Codex models) or
`claude-code` (the native Claude Code CLI; see [claude/README.md](claude/README.md)
for its configuration contract and adapter). `AgentSessions` receives one backend
per harness (`AgentHarnessBackends`) and selects the backend for every turn from
the conversation's persisted `AgentSession.harness`; absence means `pi`, which
covers every older archive. First turns, spoken/typed/queued follow-ups, agent
messages with their provenance header, stop, close/reopen and listener restarts
all use the conversation's own harness. There is no fallback to the other harness
and no mid-conversation harness switching: each harness resumes only its own
transcript. (The footer's model picker changes only the model within a harness.)
If a Claude Code conversation's turn starts while no Claude Code backend is
wired, the turn fails visibly in its tab.

How a new conversation chooses its harness:

| Start                                                     | Harness                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| “new session …” and inferred `START_CODING_AGENT_SESSION` | the configured `codingDefaultHarness` (default `pi`)     |
| “new claude session …” (`START_CLAUDE_CODE_SESSION`)      | `claude-code`                                            |
| “new pi session …” (`START_PI_SESSION`)                   | `pi` with the coding profile and its default model       |
| “quick question …”                                        | always `pi`                                              |
| `companion_session_start`                                 | its `harness`, else as “new session”; quick questions Pi |

The two new shortcuts are prefix-only, so the detector's prompt is unchanged, and
each has its own switch. The router still tries longer prefixes first; “new
session” is literal and never captures “new claude session” or “new pi session”.
“new pi session” replaced the earlier “new codex session” wording
(`START_CODEX_SESSION`) at Tijs's request; it never meant a Codex harness, and
the old phrase has no alias. It now reaches inference like any other utterance.
A disabled-intent entry saved under the old name is ignored.

A Claude Code conversation records `AgentSession.claudeCode = {model, effort}`
when it is created, from the configured `claudeCode` section or an explicit
`companion_session_start` model, and shows that model as `AgentSession.model`.
Later turns pass the recorded pair with the executable read afresh from
`companion-agent.json`, so configuration edits change the program but never the
model of an existing conversation. Only the footer's Claude model picker
changes `claudeCode.model`, for the next turn. That read validates the whole file, as for
Pi: a mistake in any section, including `claudeCode`, also blocks turns of
existing Claude Code conversations until it is corrected.

### Defaults for new coding sessions

Activity's “Start a coding session” card shows the backend (`pi` or
`claude-code`) and that backend's model for **new** coding conversations. The
panel reads them with `coding-defaults` and changes them with
`set-coding-defaults` (see the [desktop protocol](../desktop/README.md)). A
change writes only `codingDefaultHarness`, `codingDefaultPiModel` or
`claudeCode.model` in `companion-agent.json`; every other key is kept. Models
must come from the same catalogues as the conversation footer: Pi's discovered
models, or the Claude allowlist plus the configured Claude default. The write is
atomic (temporary file and rename, keeping the file mode) and refused when the
file changed since the panel read it, or when the file is invalid, a symbolic
link or unwritable. Quick questions, executables and effort are not panel
settings.

Existing conversations never change backend or model:

- The harness is recorded when a conversation's first turn starts (below).
- A Claude Code conversation records its own model when it starts.
- A Pi coding conversation created while `codingDefaultPiModel` is set
  receives that model as its saved `modelOverride` at its first turn, exactly
  like a footer choice, so later default changes do not move it. An explicit
  model (from an agent tool or the footer) is kept instead.
- A Pi conversation without an override, including every conversation created
  before `codingDefaultPiModel` existed, still follows the top-level `model`
  on each turn. The panel never edits that key, so these conversations stay on
  their model; a hand edit of `model` still moves them, as before.

A speech-started conversation resolves `codingDefaultHarness` and the Claude
settings when its first turn begins, before its first save or backend call;
until then the conversation refuses model/effort changes, and a configuration
error fails that first turn in its own tab. A new Pi coding conversation
resolves `codingDefaultPiModel` at the same moment. The next turn in the still-open tab
retries the resolution. A tab closed (or a listener stopped) before any
resolution succeeded is saved without a harness and reopens as a Pi
conversation; its follow-up then fails visibly on Pi's missing transcript. The
session store accepts `harness` only as `claude-code` together with valid
`claudeCode` settings (an explicit `"pi"` is normalized to absence) and never
with Pi's model/effort overrides; archives without the fields stay valid.

Claude Code conversations get a Claude-only next-turn model picker and no
effort picker. `setModel` accepts an exact allowlisted Claude ID (or the
configured/current model) and replaces `claudeCode.model`, keeping its effort.
Pi IDs, aliases and unknown names are refused visibly. `setThinking` refuses
Claude conversations. `AgentSessions.models()` remains Pi's catalogue;
`claudeModels()` returns the Claude list `{models, model}` without starting Pi
or Claude Code. The turn resumes the same Claude session
with the new `--model`. See [the Claude picker contract](claude/README.md#next-turn-model-picker).

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
The ten-concurrent-agent limit also controls availability. If another session
takes the last slot during inference, the selection is skipped rather than
starting an extra run or reporting a submission error.
The model should offer the choices first and then write its complete answer as
visible text, not wait for the user inside the tool. The tool result repeats this
because the user never sees thinking: asked to answer before the call, Claude
models often wrote the answer only in thinking and ended with a one-line pointer
to the choices. The composer always permits writing freeform text, including
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

| Tool                       | Parameters                                                                                                        | Effect                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `companion_sessions`       | `query?` (≤100), `limit?` (1–50, default 20)                                                                      | Lists open tabs and matching saved conversations. No transcripts or drafts.                                        |
| `companion_session_start`  | `text` (1–4000), `profile?` `coding`\|`quickQuestion`, `harness?` `pi`\|`claude-code`, `model?`, `focus?` (false) | Opens a tab whose agent immediately answers `text`. `model` is a Pi provider/id or a Claude model ID, per harness. |
| `companion_session_reopen` | `id`, `focus?` (false)                                                                                            | Reopens a saved conversation with its ID, transcript, profile, harness and model. Starts no turn.                  |
| `companion_session_close`  | `id`                                                                                                              | Closes an open tab, saving it to Previous sessions; the caller's own tab closes after its turn.                    |
| `companion_session_send`   | `id`, `text` (1–4000)                                                                                             | Follow-up to another open tab; starts its turn or queues behind earlier messages.                                  |
| `companion_session_draft`  | `id`, `text` (1–4000), `ifDraftExists?` `reject`\|`append` (default `reject`), `focus?` (false)                   | Places unsent text in that tab's input for the user to review. Never submits or runs a turn.                       |
| `companion_browser_open`   | `url` (absolute `https://`, or `http://` on loopback; ≤2048)                                                      | Shows the page in the native panel's built-in browser, only for the caller's own, currently selected conversation. |

`companion_browser_open` is offered to Pi and, through the MCP bridge, to
Claude Code with the same schema; it uses the same lease, receipts and action
budget. It is not available to external (CLI) callers, which have no
conversation of their own. The service checks the address before asking the
UI; the desktop runtime forwards a one-time `agent-browser-open` event to the
native window that advertised `browserHost`, and the panel answers after the
page loaded or failed, or after about 8 seconds with `loading`. Results report
what the user now sees (`loaded`, `loading`, `load-failed` with the
reason, `superseded`); refusals are `panel-hidden` (a hidden panel is never
shown and nothing opens), `not-selected`, `busy`,
`unsupported`, `refused`, `offline` and `unconfirmed`. The page's content never
returns to the agent. See [panel browser](../../docs/panel-browser.md#opening-a-page-from-an-agent).

Optional session tools need the listener's positive announcement. A lease
carries `capabilities` (currently `browser-open`), passed to Pi as
`COMPANION_SESSION_TOOLS_CAPABILITIES` and to the Claude bridge through its
per-turn MCP configuration. Because both load the tool definitions from disk
for every turn, a still-running older listener, which announces nothing, keeps
exactly its original tools after a source update
(`test/unit/session-tools-compatibility.test.ts`).

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
{"text":"Review the diff on this branch.","harness":"claude-code","model":"claude-opus-5-5"}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","focus":true}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","text":"The migration is merged; please rerun your checks."}
{"id":"6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","text":"Could you also cover the logout path?","ifDraftExists":"reject"}
```

A successful call returns JSON, for example `{"outcome":"queued","queuePosition":2,
"session":{...}}` or `{"outcome":"reopened","messages":14,"session":{...}}`.
Summaries contain `id`, `title`, `status`, `profile`, `harness` (`pi` or
`claude-code`), `model`, optional `modelOverride` and `updatedAt`; open entries add `busy`, `queuedMessages` and
`self`. A refusal is a failed tool result whose message ends with a stable code:

| Code                      | Meaning                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`                 | Malformed ID, empty/oversized text, unsupported option, or a model of the wrong form for its harness.                                                   |
| `unknown-session`         | No open or saved conversation has that ID.                                                                                                              |
| `not-open`                | Saved but closed; reopen it first. Sends/drafts never reopen implicitly.                                                                                |
| `self-target`             | `companion_session_send` to the calling conversation.                                                                                                   |
| `loop-limit`              | The turn is already three agent-to-agent hops from a human message.                                                                                     |
| `duplicate`               | Identical content to the same destination already delivered (or possibly delivered) in this turn.                                                       |
| `limit`                   | More than six start/reopen/close/send/draft actions, or 32 calls, in one turn.                                                                          |
| `busy`                    | Close refused: another conversation is running, closing or has queued messages; nothing was stopped.                                                    |
| `unavailable-model`       | The requested model is not in Pi's current catalog; there is no fallback.                                                                               |
| `expired`                 | The calling turn ended; its lease is gone.                                                                                                              |
| `rejected`                | An existing lifecycle limit: 16 tabs, 10 running agents, 8 queued messages, or a stopping/closing tab.                                                  |
| `conflict`                | Draft refused: the user has unsent text there (kept unchanged), a send from it is pending, or the combined text would exceed the composer's 8000 chars. |
| `unavailable` / `offline` | Draft refused: the panel lacks that tab, or no draft-capable panel is connected.                                                                        |
| `unconfirmed`             | The panel did not confirm within 5 s or disconnected; the draft may exist. Do not resend.                                                               |

**Attribution.** A sent or starting message is stored as a `user`-kind bubble
with `origin: {kind: "agent", sessionId, title, depth}`. The panel labels it
**Agent · title** instead of **You**, and the label survives closing and
reopening. Pi receives the text after a header beginning
`[Companion agent message] Written by the agent of another Companion
conversation, "<title>" (session <id>), not typed by the user.` Human messages
are sent unchanged. Agent-started conversations have no screenshot.

**Source links.** While the panel is connected, an internal agent bubble's
heading is a link when its sender is an open tab or listed in Previous
sessions; otherwise (deleted sender, offline panel) it is plain text. Clicking
selects the open sender, or requests reopening an archived one; the ordinary
user-reopen `agent-restored` event then selects it. The click never sends a
message, changes a draft or moves composer focus. A pending request is
forgotten when the user navigates elsewhere or the sender is restored without
selection (for example, the reopen was refused and an agent later reopened it
quietly), so it can never take over the view. New messages also carry
`origin.sourceGroupId`: the sender's stored tool group for that exact turn and
Pi tool-call ID (`<turn>:tool-<call>`), only when the call was stored before
delivery. The link aligns that group to the top without expanding it; the group's
individual calls are not highlighted. Older or unanchored messages open the
conversation only. External-origin messages have unverified labels and no
source conversation, so they are never links. Transcript headings, including
these links, are reachable by pointer and screen-reader press action, not Tab.

**Ordering and busy targets.** Sends use the same FIFO as typed and spoken
follow-ups: they never interrupt a running turn, never overtake earlier queued
messages, and are cancelled with the rest of the queue by Stop or a failed turn.
The existing limits of eight queued messages and ten running agents apply.
Agent, external and wake messages keep 1–4000 characters
(`MAX_RELAYED_MESSAGE_LENGTH`). Only the person at the desktop composer or
Activity text input may send up to 8000 (`MAX_DIRECT_USER_MESSAGE_LENGTH`, in
`message-limits.ts`); `followUp` tells them apart by the message's origin.
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
for schemas, retained bundles, durable state and renderer limits. Widget fallback
text is paged like ordinary messages; display budgets never reject canonical
widget transactions. Tool output retains its separate storage admission limits.

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

## External local agents

The optional `--external-sessions` listener flag exposes these same lifecycle
operations to processes running as the same Linux user, through a separate private
Unix socket and `bin/companion-session`. It is off by default and does not issue
internal turn tokens. External messages/drafts are explicitly attributed to an
unverified local label, with no internal sender/self identity. See the
[external API contract](external/README.md) for activation, CLI commands, security,
receipt lifetime, cancellation, limits and validation scope.

## Self-wake timers

A conversation can use `companion_wake_schedule`, `companion_wake_cancel` and
`companion_wake_list` when its turn lease announces `self-wakes`. Pi and Claude
share the definitions and backend authority checks. No external CLI scheduling
operation exists. Ordinary self-send remains forbidden.

Schedule takes a label (1–120 characters), message (1–4000), exactly one of
`afterSeconds` or an RFC3339 `at` with an explicit offset, optional `key`, and
optional `expiresAfterSeconds`. Delays are 60 seconds–30 days; overdue grace is
one hour by default, configurable from one second to 24 hours. There may be
three unstarted timers per conversation and 64 per listener. These are pending
work limits, not a lifetime wake count. A wake can schedule another one-shot,
including with the same purpose key. No immutable watch-chain deadline applies.

Each successful schedule durably returns a new occurrence ID, due/expiry and
state. Tool-call receipts survive restart. A purpose key atomically supersedes
only its unstarted predecessor; an active predecessor retains its history.
Cancelling an old ID never cancels its successor. Lists are self-only, omit
instruction text, and optionally include up to 50 recent terminal entries.
Cancel distinguishes `cancelled`, `already-cancelled`, `already-finished`,
`dispatch-started`, and `unknown-or-not-owned`. A failed disk write never
confirms cancellation. After dispatch, cancellation records intent without
killing an unrelated turn or undoing tools.

The backend owns a separate private `.companion-wakes/timers.sqlite` store,
with FULL synchronous SQLite transactions and an exclusive kernel `flock`.
A second owner refuses to open it. The directory is 0700 and files 0600;
unsafe existing permissions, symlinks at these paths and hardlinked files are
refused. Same-user filesystem access remains trusted. Malformed rows are
quarantined with a warning; an unreadable database fails startup closed. The
store keeps 100 recent terminal occurrences and 1000 receipts per owner;
pruning diagnostic history never prevents a successor. Deleting owner data
must call `wakes.deleteOwner` to erase timer instructions/receipts too; startup
also removes timers whose owner no longer exists in open or saved history.

Due timers remain removable scheduler entries outside the ordinary FIFO. Busy
conversations, eight queued ordinary messages, ten active agents and all 16
tabs occupied defer delivery until capacity returns or grace expires. Already
accepted ordinary messages always run first, preserving their own FIFO order.
The final claim rechecks revision, expiry, conversation availability, settings
and capacity synchronously with reserving the session. Preparation also captures
the live session/controller identity: an intervening ordinary turn, Stop, close
or current error prevents stale admission. Each sweep refreshes later candidates
before any state change or restore; terminal records cannot return to waiting.
Stop aborts the lease
and cancels all unstarted timers; explicit close does likewise and reports the
count. A self-close cancels them immediately and refuses further scheduling
while the close is pending. Hide and tab selection do not cancel anything.
Shutdown preserves undispatched timers. An unexpired timer may restore its
saved owner quietly; it never creates a replacement conversation.

Each wake retains task ancestry and cross-agent depth and carries a
`scheduled-wake` origin. Its prompt identifies earlier agent intent, asks for
reassessment, and grants no fresh human permission or review/restart budget.
It attaches no screen capture and changes no draft, focus or selected tab.
Backend resume verification still refuses a missing native transcript before
sending a prompt; that occurrence becomes blocked. Provider errors and stopped
or failed wake turns are terminal, never automatically retried. A failed
ordinary predecessor blocks still-unstarted wakes. A failed cancellation or block
write halts all wake admission and new scheduling in this listener, including
already prepared work. It does not stop explicit ordinary follow-ups. The visible
warning is honest about durability: repair storage and successfully retry pending
cancellation before restarting, or the last committed timers may become eligible
again. A successful retry saves cancellation without clearing the listener fault.

### Crash and clock boundaries

A dispatch claim, attempt ID and turn-admission ID commit in one transaction
before invoking the backend. The display transcript save follows. A crash
before the claim leaves an eligible timer; a crash after the claim, during the
transcript save, after the started marker, or after backend execution but before
the terminal save becomes `delivery-uncertain` on restart. None of these claimed
occurrences is automatically replayed. This deliberately permits a missed wake
between claim and backend invocation to avoid duplicate external effects; it
does not promise exactly-once tools. Native status shows the durable transition,
including failed, expired, blocked and uncertain outcomes, and archive reopen
repairs notice text from the timer store.

Node's monotonic timeout reconciles UTC deadlines once per second, including
after suspend and wall-clock changes. Long delays use these bounded checks,
not an overflowing long timeout or model polling. Backward changes never admit
before the stored due instant; forward changes may expire a timer. Scheduling
stops with a visible warning on scheduler storage failure, rather than looping
notifications or retrying a provider. Restart is an operational decision.

Synthetic coverage and the acceptance matrix are in
[the self-wake validation guide](../../docs/self-wake-validation.md). Live model
wakes and deployment require a separate bounded test/activation decision.
