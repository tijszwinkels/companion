# Claude Code harness

This directory contains everything Claude-specific in Companion's agent
conversations. The backend adapter runs one native `claude` CLI turn at a time.
The stream-json mapper produces the same `AgentMessage` shapes as Pi, and a
stdio MCP bridge gives Claude the same Companion tools that Pi has.

Companion runs agent conversations on one of two harnesses:

| Harness       | Program                    | Models                                                         |
| ------------- | -------------------------- | -------------------------------------------------------------- |
| `pi`          | headless Pi RPC process    | every Pi-configured provider, including OpenAI Codex (“Codex”) |
| `claude-code` | native `claude` CLI (this) | allowlisted Claude models, switchable for the next turn        |

There is no third harness. “Codex” stays Pi with the OpenAI Codex model.
Session selection, persistence and UI wiring for this backend belong to the
session-integration work. This directory owns only the adapter, the bridge and
the contract below.

| File                   | Responsibility                                                         |
| ---------------------- | ---------------------------------------------------------------------- |
| `claude-backend.ts`    | `ClaudeCodeBackend`: one `claude --print` process per turn, lifecycle  |
| `claude-transcript.ts` | stream-json events → `AgentMessage` (assistant/tool bubbles)           |
| `turn-results.ts`      | per-turn loopback route through which the bridge reports choices/names |
| `mcp-config.ts`        | private per-turn `--mcp-config` file that starts the bridge            |
| `mcp-server.ts`        | bridge entry point (started by Claude Code, not by Companion)          |
| `mcp-stdio.ts`         | minimal MCP JSON-RPC server over stdio (tools only)                    |
| `bridge-tools.ts`      | Companion tools for the bridge, built from the native Pi tool modules  |
| `models.ts`            | the footer picker's Claude model allowlist (exact IDs)                 |
| `tool-output.ts`       | text-plus-image tool results and their 5 MiB image bound               |
| `parity/`              | opt-in Pi-parity tools (desktop, OpenRig, web); see its README         |

## Configuration contract

`~/companion/agents/companion-agent.json` keeps its existing top-level Pi fields
(`executable`, `model`, `thinking`) and the Pi-only `quickQuestion` section. Two
optional fields are added:

```json
{
  "executable": "pi",
  "model": "openai-codex/gpt-6-astra",
  "thinking": "medium",
  "quickQuestion": { "model": "pillar-vllm/qwen3.8-128k", "thinking": "off" },
  "codingDefaultHarness": "pi",
  "claudeCode": { "executable": "claude", "model": "claude-opus-5-5", "effort": "high" }
}
```

- `codingDefaultHarness` (`"pi"` or `"claude-code"`, default `"pi"`) selects the
  harness for **newly created coding conversations** only. Quick questions are
  always Pi. Existing conversations keep their harness.
- `claudeCode` may omit any field. The defaults are `claude`, `claude-opus-5-5`
  and `high`. `effort` is one of `low`, `medium`, `high`, `xhigh`, `max` (the
  values `claude --effort` accepts). `model` must be the exact Claude model ID:
  no whitespace, no leading `-`, and no Pi-style `provider/` prefix. Aliases such
  as `opus` fail the startup check, because Claude Code reports the resolved ID
  (see below). That failure message names the ID to configure instead.
- The whole file is validated on every load, as before. Unknown keys anywhere
  are rejected, and an invalid Claude section also blocks Pi turns until it is
  fixed. The loader creates a missing file with every section's defaults and
  never rewrites an existing file, so old three-field files stay valid.

Loaders in `../settings.ts`:

| Function                                  | Returns                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| `loadAgentConfiguration(dir, initialize)` | the whole validated `AgentConfiguration`                |
| `loadAgentSettings(dir, profile, init)`   | Pi settings for `coding` or `quickQuestion` (unchanged) |
| `loadClaudeCodeSettings(dir, initialize)` | `ClaudeCodeSettings` (`executable`, `model`, `effort`)  |

## Session contract (`../types.ts`)

- `AgentHarness = 'pi' | 'claude-code'`. `AgentSession.harness` is absent in
  every older archive and every Pi conversation; absence means `pi`.
- `AgentSession.claudeCode` (`{model, effort}`) records the conversation's own
  Claude model and effort, captured when it was created. Later turns use these
  values rather than the current file, so configuration edits never switch its
  model. The footer picker can replace `model` for the next turn (see
  [Next-turn model picker](#next-turn-model-picker)); `effort` stays fixed. The
  executable is still read from the file for each turn.
- `AgentBackend<Settings>` and `AgentRunRequest<Settings>` are generic over the
  harness's settings. `AgentBackend` (default `AgentSettings`) is the unchanged
  Pi contract; `ClaudeCodeAgentBackend = AgentBackend<ClaudeCodeSettings>`.
  `AgentHarnessBackends` (`{ pi, 'claude-code'? }`) is the selection surface. A
  `claude-code` conversation without a configured backend must fail visibly.
- The Claude backend has no `models()`. The picker's catalogue is the fixed
  allowlist in `models.ts`, not a discovery process.
- `request.previousModel` (Claude only) names the previous turn's model when
  the user has since chosen another. The backend then announces the switch.
- `request.id` must be a UUID (Companion's session IDs are). Claude Code uses it
  as its own session ID.
- `emit`, `replaceChoices` and `renameSession` keep their Pi semantics, so tool
  grouping, choices and naming need no Claude-specific session handling.
- `request.nativeTitle` and the `exportTitle` callback (Claude only) carry the
  export of that name to Claude Code's own session; see
  [Native session name](#native-session-name). Pi ignores both.

## Turn lifecycle

One `claude` process per turn. No shell is involved:

```text
claude --print --verbose --input-format stream-json --output-format stream-json
       --include-partial-messages
       (--session-id <companion-uuid> | --resume <companion-uuid>)
       --model <model> --effort <effort> --permission-mode bypassPermissions
       --mcp-config <private per-turn file> --append-system-prompt <instruction>
```

1. Open the per-turn result route and write the 0600 MCP config file.
2. Start Claude Code in its own process group, in the agent directory.
3. Send the stream-json control request `get_settings`. Claude Code answers it
   before any model call, with `applied: {model, effort}`. This is the
   equivalent of Pi's startup `get_state` check. There is no `--fallback-model`.
   - The model must equal the settings exactly. An alias is rejected; the
     error names the resolved full ID to configure.
   - The effort must equal the settings, with one deliberate exception: a
     model without effort support reports `null`. That is accepted without
     clamping, and the conversation's first turn shows a notice that the model
     ignores effort levels. Any other effort is drift.
   - On drift the turn fails and no prompt is sent.
   - After a picker switch (`previousModel`), and only once both checks
     pass, a notice says “Now using B (previous turn: A). Claude Code
     continues the same conversation history.” The effort notice above is
     then repeated for the first turn with a model that reports `null`.
     `previousModel` is the model Companion requested for the previous turn
     (`AgentSession.model`), even if that turn failed. A retry of a failed
     switch with the same model therefore shows no second notice.
   - These notices precede the `system/init` check (step 5) and its
     deadline, so a turn can still fail after announcing a switch. A switch
     whose turn failed before these checks passed is not announced on a
     retry with the same model either.
4. Send one stream-json user message: the prompt text, plus (with a
   screenshot) `Captured window: {…}` and a base64 PNG image block.
5. Verify the `system/init` event: the session ID, the model, permission
   mode `bypassPermissions`, and that the `companion` MCP server is
   `connected` or `pending`; any other bridge state fails closed. Nothing
   counts before a verified init: earlier transcript fragments are dropped,
   and a `result` without one fails the turn instead of completing an
   unverified session.
6. Map events to `AgentMessage`s until the **first** `result`, which ends the
   turn. `is_error` fails it with Claude Code's reason.
7. Clean up whether the turn succeeded, failed or was cancelled:
   - A finished turn closes stdin and gets 2 s to exit by itself, so it can
     finish writing its transcript.
   - A cancelled turn is sent the control request `interrupt` (the
     equivalent of Pi's `abort`), stdin is closed, and it gets 250 ms.
   - Then the process group gets SIGTERM, 750 ms, and SIGKILL; the pipes are
     destroyed and the process is reaped, as in `pi-backend.ts`.
   - Finally the route is closed (its token dies with it) and the config
     directory is removed.

Guards shared with Pi:

- Bounded startup: 20 s from starting Claude Code until the `get_settings`
  answer, then 60 s from sending the prompt until a verified `system/init`.
  Answering settings alone does not end startup, so a living process that
  never sends init cannot hold its tab and agent slot. After a verified init
  there is no deadline (model turns can be long); cancellation still applies.
- 8 MiB limit per stream-json record and per unterminated remainder.
- The last 2000 characters of stderr in error messages.
- A request for an interactive decision (`control_request`) fails the turn
  instead of hanging.

The child environment sets `COMPANION_INTERNAL_AGENT=1` and removes
`COMPANION_EXTERNAL_SOCKET`, like Pi. It also removes every bridge token
variable and the markers of a parent Claude Code session (`CLAUDECODE`,
`CLAUDE_CODE_*` session and messaging variables, `CLAUDE_EFFORT`).

### Appended system prompt

Claude Code keeps its own system prompt. Companion appends the same instruction
as Pi's, word for word. It frames the screenshot as context, not as instructions.
Tool guidance comes from the MCP bridge's `instructions` (see below).

Claude Code records the rendered system prompt at a conversation's first
request and reuses it on every resume (`--system-prompt-snapshot`, default
`on`). That record includes the appended instruction and the MCP instructions.
Editing either therefore affects new Claude conversations only.

## Tool bridge

Claude Code starts `mcp-server.ts` from the per-turn config (`node --import tsx`,
using Companion's own Node and loader). The bridge exposes the native Pi tool
definitions with the same names, descriptions, JSON schemas and results:

- always: `companion_choices` and `companion_name_session`;
- with a widget lease: the five widget tools from `../widget-tools.ts`;
- with a session-tool lease: the six lifecycle tools from `../session-tools.ts`.

Details:

- **Names.** Claude Code shows the tools to the model as `mcp__companion__<name>`.
  The transcript removes exactly this prefix, so stored bubbles, choices and
  source links use Pi's names.
- **No deferral.** Claude Code defers MCP tools behind its ToolSearch tool
  unless the server config has `alwaysLoad: true`, which the bridge sets. The
  model therefore sees the tools from the start, as with Pi, and can name the
  conversation early.
- **Prompt hints.** Pi puts each tool's `promptSnippet`/`promptGuidelines` into
  its system prompt. The bridge returns the same text as MCP `instructions`,
  which Claude Code includes in the system prompt.
- **Validation.** Arguments are validated against each tool's schema (Ajv), as
  Pi does, before the tool's own validation runs.
- **Tool-use IDs.** Claude Code sends the model's tool-use ID as
  `_meta["claudecode/toolUseId"]`. The bridge passes it as the Pi tool-call ID,
  so session-tool receipts, duplicate refusal and `origin.sourceGroupId`
  (`<turn>:tool-<id>`) behave as with Pi. A call without this ID fails.
- **Text and image results.** Results contain a text block, optionally
  followed by PNG/JPEG image blocks (`tool-output.ts`), never
  `structuredContent`: Claude Code would show that to the model instead of
  the text. More than 5 MiB of base64 image data in one result is refused as
  a tool error, never truncated. Companion's transcript keeps the text only.
- **Pi-parity tools.** The opt-in `claude-tools.json` in the agent directory
  adds Companion-owned equivalents of the user's Pi extension tools
  (desktop windows, OpenRig, retained web content). See
  [`parity/README.md`](parity/README.md) for the per-tool matrix, guards,
  the web-search blocker and the Google Workspace proposal.
- **Cancellation.** Claude Code's `notifications/cancelled` aborts the running
  call. The end of stdin aborts all calls, and the bridge then exits.

**Choices and names** cannot travel on Claude's output stream as structured
data, so they use a per-turn loopback route instead of assistant text:

1. The bridge validates the call with Pi's own tool code (`parseChoices` and
   `parseSessionName`, via `choiceTool` and `sessionNameTool`).
2. It posts the value to the turn's route, keyed by the tool-use ID. The route
   only listens on 127.0.0.1 and checks the Host header, the POST method and
   path, and a random 256-bit bearer token compared in constant time. It limits
   body size and result count, and validates the value again.
3. Only then does the tool return success. If the report fails, the tool fails.
4. When Claude Code reports that exact tool-use ID as successful, the backend
   takes the value, validates it a third time and calls `replaceChoices` or
   `renameSession`. A failed tool call never publishes.
5. A successful `companion_choices` call without a matching report clears the
   old choices and adds the same notice as Pi. A naming call without one keeps
   the old title.

### Native session name

Pi stores a conversation's name in its own session (`pi.setSessionName`).
Claude Code gets the same: after `renameSession`, the backend names Claude
Code's own session with its native stream-json control request, on the
turn's running process:

```json
{
  "type": "control_request",
  "request_id": "companion-rename-1",
  "request": {
    "subtype": "rename_session",
    "title": "🐛 Login fix",
    "source": "host",
    "session_id": "<companion-uuid>"
  }
}
```

Claude Code (verified with 2.1.289, without a model call) validates it,
appends its own `custom-title` and `agent-name` metadata records to the
session's transcript, emits `system/session_title_changed` and answers with a
`control_response`. Its `/resume` picker and later `--resume` turns read the
name back. Companion never writes or edits Claude Code's transcript itself.
`source: "host"` marks an explicit name from the hosting program, not an
AI-generated title. `session_id` makes Claude Code refuse the request for any
other session.

`AgentSession.nativeTitle` (`{title, state}`, Claude Code conversations only)
records the export:

- `pending`: sent but not yet confirmed (for example, the turn was stopped or
  Claude Code exited first), or not sendable because Claude Code's stdin had
  closed. The next turn sends it again once its `system/init` is verified, so
  the native transcript already exists. A naming result processed after Stop
  is rejected as Companion's title and is never exported; an answer to a
  rename sent before Stop still counts.
- `published`: Claude Code answered `success` to the latest rename. An
  unchanged confirmed name is not sent again.
- `failed`: Claude Code refused it. The turn shows one notice; Companion's own
  title is unchanged. It is not retried until the agent names the
  conversation again.

Claude Code answers renames in order; only the answer to the latest one sets
the state. Answers that arrive after the turn's `result`, while Claude Code
finishes its transcript, still count. Conversations named before this export
existed have no `nativeTitle` and are not exported retroactively. A damaged
saved record is dropped. Claude Code also re-appends the latest `custom-title`
as its transcript grows, so the record can occur more than once.

Importers that ignore Claude Code's `custom-title` record do not show the
name. For example, AgentsView (v0.43.0) reads native Claude names only from
`/rename` command records and `ai-title`. Companion does not imitate either.

**Tokens.** The widget, session-tool and result tokens appear only in the
bridge's config file (`env` section, mode 0600 in a fresh 0700 directory,
removed after the turn). They are not in `claude`'s environment, so the agent's
Bash tool cannot print them into a transcript by running `env`. With Pi, these
tokens are in the agent environment. The backend also redacts them from
transcripts and error messages. The config path is visible in the process list
to the same user, so this is containment, not a security boundary. The tokens
only authorize this conversation's own current turn, and they expire with it.

## Next-turn model picker

In an existing Claude Code conversation the footer lists Claude models only.
Choosing one changes **that conversation's next turn**. The Companion UUID,
the native Claude session and its history stay the same: the turn runs
`claude --resume <uuid> --model <new>`. The harness never changes, a Pi
model ID is never reinterpreted, and nothing moves between harnesses.

- **Catalogue.** `models.ts` holds a small allowlist of exact IDs
  (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`,
  `claude-haiku-4-5-20251001`). The configured `claudeCode.model` is added
  when it is not listed. `AgentSessions.claudeModels()` returns them as
  `{models, model}` (`model` is the configured default) through the desktop
  action `claude-models`. It only reads the configuration file and starts
  neither Pi nor Claude Code, so a Claude tab never runs Pi discovery and a
  Pi failure cannot hide the Claude list. The conversation's current model
  is always shown and accepted, even when it is not listed.
- **Validation.** `setModel` accepts only an exact listed ID or the current
  model. Aliases (`opus`), whitespace, case changes, `provider/` IDs, unknown
  names and the empty string are refused with a visible error, and nothing
  changes. There is no fallback. Claude Code itself does not check the name
  (`get_settings` echoes anything), so the allowlist is Companion's check. A
  listed model that the account cannot use fails that turn at the API, with
  Claude Code's error; the user then picks another model.
- **Effort.** There is no Claude effort picker. A switch keeps the effort the
  conversation started with, and `get_settings` must still report it. Every
  listed model therefore accepts all five levels or none (`null`, accepted
  with a notice). Models that silently lower a level must not be listed; the
  startup check would report drift. Verified with no-cost `get_settings`
  probes (CLI 2.1.280, 2026-09-25), each listed ID with each of the five
  levels: Fable 5.1, Opus 5.5 and Sonnet 5 report every level unchanged, and
  Haiku 4.5 reports `null` for all. As a control, `claude-opus-4-6` reports
  `xhigh` as `high`, so it is not listed. An effort picker is not needed for
  switching models, so none was added.
- **Persistence.** The choice replaces `claudeCode.model` in the archive. The
  shape stays `{model, effort}`, so older archives need no migration and an
  older listener reading a newer archive resumes with the chosen model.
  `AgentSession.model` keeps naming the current/last turn's model; the next
  turn's model is `claudeCode.model`. Session tool summaries report the latter.
- **Races.** These are the same rules as Pi's overrides. A running turn keeps
  the model it started with. Queued turns use the choice present when each
  begins. A turn starting while a choice is still being saved waits for that
  save or its rollback. A second choice while one is pending is refused, as
  are choices for a closing tab or one whose harness is still being resolved.
  The open menu is pinned to its conversation, so a tab change cannot
  retarget it.
- **Compatibility.** An older UI keeps showing its fixed summary. A newer UI
  on an older listener gets an error for `claude-models`, lists only the
  current model, and the listener refuses changes.

## Pi-vs-Claude capability matrix

“Tested” names the hermetic test (fake `claude` unless stated). “Probed” means
the real CLI 2.1.280 in a throwaway directory. “Smoke” means one end-to-end run
of this backend and the real bridge with the real CLI (`claude-sonnet-5`, low
effort, temp directory, not through `AgentSessions`).

| Capability (Pi today)                                         | Claude Code counterpart                                                                                                                                                                                                                                                                                                                                                                     | Parity check                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One process per turn, own session ID, process group           | Same; `--session-id` then `--resume` with the Companion UUID                                                                                                                                                                                                                                                                                                                                | Tested (new/resume argv, cwd); probed (ID kept on resume, history kept)                 |
| Missing transcript on follow-up fails visibly                 | `--resume` of a missing ID exits with “No conversation found”; reported as unresumable                                                                                                                                                                                                                                                                                                      | Tested; probed (never silently creates a session)                                       |
| Model/thinking verified at startup; drift fails; no fallback  | `get_settings` → `applied.model/effort` must match exactly; no `--fallback-model`                                                                                                                                                                                                                                                                                                           | Tested (model drift, null effort); probed (alias resolution, effort reporting)          |
| Pi clamps thinking to the model's supported levels            | **Not mirrored**: no clamping. Only `null` (model without effort support) is accepted, with a notice                                                                                                                                                                                                                                                                                        | Tested (notice on first turn only; other effort drift fails)                            |
| Streaming partial answer, authoritative final text            | `stream_event` text deltas, replaced by the complete `assistant` text block                                                                                                                                                                                                                                                                                                                 | Tested (backend + transcript); probed; smoke                                            |
| Thinking hidden                                               | Thinking blocks and deltas ignored                                                                                                                                                                                                                                                                                                                                                          | Tested                                                                                  |
| Tool bubbles `tool-<id>` running → done/error, input, text    | `tool_use` → `tool_result` (`is_error`), string or text blocks                                                                                                                                                                                                                                                                                                                              | Tested; probed; smoke                                                                   |
| Consecutive tool grouping, lazy tool pages, limits            | Unchanged: handled upstream from the same `AgentMessage`s                                                                                                                                                                                                                                                                                                                                   | Shape parity tested; upstream unchanged                                                 |
| Screenshot + captured window, “context, not instructions”     | Base64 image block + same text; same appended instruction                                                                                                                                                                                                                                                                                                                                   | Tested (exact block); probed (model read the image)                                     |
| Cancellation persists partial answer, group kill              | `interrupt` control request, then the same escalation                                                                                                                                                                                                                                                                                                                                       | Tested (interrupt, reaped); probed (partial kept, tool child reaped)                    |
| Descendant retaining pipes cannot hang a turn                 | Same pipe release after escalation                                                                                                                                                                                                                                                                                                                                                          | Tested (success and cancel)                                                             |
| stderr cap, oversized/unterminated/malformed records          | Same limits                                                                                                                                                                                                                                                                                                                                                                                 | Tested                                                                                  |
| Interactive dialog request fails visibly                      | `control_request` from Claude Code fails visibly                                                                                                                                                                                                                                                                                                                                            | Tested                                                                                  |
| Retries/compaction settle before finishing (`agent_settled`)  | Claude retries internally; the first `result` ends the turn; later background-task turns are ignored                                                                                                                                                                                                                                                                                        | Tested (post-result events ignored); probed (background task behaviour)                 |
| Model/API errors become a failed turn                         | `result.is_error` (e.g. unknown model → 404 text), synthetic error message marked `error`                                                                                                                                                                                                                                                                                                   | Tested; probed                                                                          |
| `companion_choices` (only successful, correlated completions) | MCP tool + result route + tool-use ID correlation; same validation, notice and clearing                                                                                                                                                                                                                                                                                                     | Tested (ok/failed/unreported/mismatched/forged; real bridge); smoke                     |
| `companion_name_session`                                      | MCP tool + result route → `renameSession`                                                                                                                                                                                                                                                                                                                                                   | Tested (ok/failed/unreported; real bridge); smoke                                       |
| Name stored in Pi's own session (`get_state.sessionName`)     | **Exported**: `rename_session` control request writes Claude's own `custom-title`; confirmed, pending or failed (see [Native session name](#native-session-name))                                                                                                                                                                                                                           | Tested (published/refused/unanswered/retried/superseded; real CLI with a synthetic API) |
| Widget tools (5), same lease                                  | Same definitions via the bridge; tool-use ID as request ID                                                                                                                                                                                                                                                                                                                                  | Tested (list, discover call, auth, request ID)                                          |
| Session lifecycle tools (6), receipts, source links           | Same definitions; tool-use ID as request ID                                                                                                                                                                                                                                                                                                                                                 | Tested (list call, schema refusal, request ID). End-to-end: integration                 |
| Tool prompt snippets and guidelines                           | MCP `instructions`; fixed per conversation by Claude's system-prompt snapshot                                                                                                                                                                                                                                                                                                               | Tested (instructions content); probed (instructions reach the model)                    |
| Tools visible without discovery                               | `alwaysLoad: true`                                                                                                                                                                                                                                                                                                                                                                          | Probed (not deferred); smoke                                                            |
| `COMPANION_INTERNAL_AGENT=1`, external socket removed         | Same                                                                                                                                                                                                                                                                                                                                                                                        | Tested                                                                                  |
| Tool tokens in agent environment                              | **Different env, same capability**: tokens only in the bridge's config file, not in `claude`'s env (so Bash children cannot print them); `COMPANION_INTERNAL_AGENT=1` still covers Bash children                                                                                                                                                                                            | Tested (no `*_TOKEN` variables; marker set; redaction)                                  |
| Unattended tool use                                           | `--permission-mode bypassPermissions`, verified in `init`                                                                                                                                                                                                                                                                                                                                   | Tested; probed                                                                          |
| Model catalogue, pins, per-conversation model/effort pickers  | Next-turn **model** picker over a fixed allowlist of exact IDs (plus the configured default); `--resume` with the new `--model`, same session. No pins, no discovery, **no effort picker**: effort stays as the conversation started                                                                                                                                                        | Tested (sessions, backend, QML); probed (resume with another model, see below)          |
| Quick-question profile                                        | **Pi only** by decision                                                                                                                                                                                                                                                                                                                                                                     | Contract                                                                                |
| Pi `--offline` (no startup network fetches)                   | No equivalent; Claude Code contacts its API normally                                                                                                                                                                                                                                                                                                                                        | n/a                                                                                     |
| Pi's own configuration/extensions                             | Claude Code loads the user's settings, CLAUDE.md, hooks, skills, plugins and MCP servers (not strict)                                                                                                                                                                                                                                                                                       | **Open product question** (see below)                                                   |
| Context files (`AGENTS.md` in the agents directory)           | Supported since Claude Code 2.1.277: the default `claude-md-or-agents-md` mode loads the project `AGENTS.md` when no project `CLAUDE.md` exists, as in Companion's agents directory. Caveat: some sessions before 2.1.281 can miss `AGENTS.md` (Bedrock, telemetry disabled, first session after an upgrade) — verify the actual mode at activation. Source: code.claude.com/docs/en/memory | Verified against official docs and installed 2.1.280 metadata (2026-09-25)              |
| —                                                             | Claude-only: subagents (internals hidden; the Agent tool bubble shows input/result)                                                                                                                                                                                                                                                                                                         | Tested (subagent events skipped)                                                        |
| —                                                             | Claude-only: background Bash tasks end with the turn's process group                                                                                                                                                                                                                                                                                                                        | Probed; tested (post-result output ignored)                                             |

### Open product questions

- **User configuration (pending Tijs's confirmation).** Companion does not pass
  `--strict-mcp-config`. Claude sessions therefore get the user's own MCP
  servers, settings, CLAUDE.md, hooks, skills and plugins, as in a terminal
  Claude Code; this is what a native harness means. A user MCP server named
  `companion` would collide with the bridge. Isolation is a one-line switch
  (`isolateFromUserMcpServers` in `claude-backend.ts`), which would drop the
  user's other MCP servers.

## Verified CLI contract (claude 2.1.280, 2026-09-24)

All probes ran in a throwaway `/tmp` working directory, mostly with
`claude-haiku-4-5`. Their Claude session files were deleted afterwards.

- **Output.**
  - Order of events: `system/init`, then `stream_event`s (`message_start`,
    `content_block_start/delta/stop`, `message_delta`, `message_stop`), then
    `assistant` events, then a final `result`.
  - `system/init` carries `session_id`, `model` (the `--model` argument as
    given), `permissionMode`, `mcp_servers[{name,status}]` and `tools`.
  - Each `assistant` event carries **one** content block (`thinking`, `text`
    or `tool_use{id,name,input}`), not a cumulative message.
  - Tool results arrive as `user` events with
    `tool_result{tool_use_id, content: string | blocks, is_error}`.
  - The final `result` has `subtype`, `is_error`, `result`,
    `terminal_reason` and `errors[]`.
  - Subagent events have `parent_tool_use_id` set.
  - `system/init` arrives only after the first user message.
- **Control requests.**
  - `{"type":"control_request","request_id":…,"request":{"subtype":"get_settings"}}`
    answers `control_response.response.response.applied = {model, effort}`
    before any model call.
  - Aliases resolve: `opus` → `claude-opus-5-5`, `haiku` →
    `claude-haiku-4-5-20251001`.
  - A model without effort support reports `effort: null`.
  - `--effort` wins over an inherited `CLAUDE_EFFORT`.
  - `interrupt` ends a running turn with `result`
    `subtype:error_during_execution`, `terminal_reason:aborted_tools`. The
    partial answer stays in the transcript and a foreground tool child is
    reaped.
- **Sessions.**
  - `--session-id` keeps the given UUID. `--resume` keeps it too, with the
    history.
  - `--resume` of a missing ID exits 1 with “No conversation found with session
    ID: …” (and a `result` error). It never creates a session.
  - `--session-id` of an existing ID exits 1 with “Session ID … is already in
    use.”
  - Transcripts live under `~/.claude/projects/<cwd-slug>/<id>.jsonl`, so
    resuming depends on the same working directory. Companion always uses its
    agent directory.
- **Unknown model.** It passes `get_settings` (the name is echoed back), then
  fails at the API with `result.is_error` and a 404 explanation.
- **Images.**
  - A user content block
    `{type:"image", source:{type:"base64", media_type:"image/png", data}}`
    reaches the model.
  - Claude Code also stores the image base64 in its transcript, plus a 0600
    copy under `/tmp/claude-<uid>/<cwd-slug>/<session>/images/`.
- **MCP.**
  - An inline or file `--mcp-config` works, with a stdio server.
  - The server inherits Claude Code's environment plus the config's `env`.
  - `tools/call` carries `_meta["claudecode/toolUseId"]`.
  - Tools are deferred behind ToolSearch unless `alwaysLoad: true`.
  - The server's `instructions` reach the model.
  - A result's `structuredContent` replaces its text for the model.
- **Background tasks.** Bash may move long commands to the background. A
  `result` then arrives while the task runs, and a later task notification can
  start another model turn if stdin stays open.
- **Permissions.** `--permission-mode bypassPermissions` is reported in
  `init.permissionMode`; tools run without prompts.

### Resuming with another model (2026-09-25)

Checked before building the picker. The official model-configuration docs
state that `--model` on a resumed launch takes precedence over the restored
model. `--help` alone was not taken as proof.

- **No-cost probes.** A `get_settings`-only launch (no user message) creates
  no session and makes no model call. On `--resume` of an existing session
  with a different `--model`/`--effort`, `applied` reports the new values.
  An unknown name such as `claude-bogus-9` is echoed back unchanged.
- **One bounded paid probe.** Two turns in a fresh `/tmp` working directory
  with a fresh UUID. Isolation: `--safe-mode --strict-mcp-config --tools ""`
  and `--max-budget-usd 0.25` for each launch. No MCP servers, tools,
  screenshots or Companion state were involved.
  1. Turn 1 used `claude-haiku-4-5-20251001` and a codeword.
  2. Turn 2 used `--resume` with `claude-sonnet-5`/`low`.
  3. Results: `get_settings` gave `applied` =
     `{claude-sonnet-5, low}`. `system/init` kept the same `session_id`, with
     `model: claude-sonnet-5`. The model recalled the codeword. The
     transcript gained a second `model` identity attachment, and the new
     assistant records name `claude-sonnet-5`.
  4. Total spend was $0.0183. The probe's session files were then deleted.
- **Caveat.** The resumed model sees both identity attachments, so its
  context says the conversation changed model. It noticed this and
  commented on it. Companion's switch notice makes the change visible to the
  user too.
- **Not established.** This did not check Fable availability for this
  account, or switching after compaction. It also did not check a switch
  with thinking blocks from a long tool-using turn.

## Tests

- `test/unit/claude-settings.test.ts`: configuration schema, defaults, no
  rewriting, strict validation.
- `test/unit/claude-backend.test.ts`: the backend against the scripted
  `test/fixtures/claude-stream.mjs`. It covers:
  - argv and environment, and the token-free agent environment;
  - resume and the missing transcript;
  - screenshot delivery and startup drift;
  - init checks and failure modes, including malformed and oversized records;
  - tool bubbles and subagents;
  - choices and names, route expiry, and ignored post-result output;
  - redaction, cancellation and pipe-holding descendants.
- `test/unit/claude-transcript.test.ts`: the event mapper.
- `test/unit/claude-model-picker.test.ts`: the allowlist, next-turn switch,
  refusals, queued/in-flight turns, rollback, restart and older archives.
- `test/panel/tst_model_picker.qml`, `test/panel/tst_session_controls.qml`:
  the Claude footer (list, fixed effort, menu pinning, older listeners).
- `test/unit/claude-bridge.test.ts`: the real bridge process over stdio, with a
  real result route and fake widget/session services.
