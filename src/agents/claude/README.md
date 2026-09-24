# Claude Code harness

Status: design note for the contract milestone. The adapter, bridge, and
verified CLI findings are added in later commits on `feat/claude-code-backend`.

Companion runs agent conversations on one of two harnesses:

| Harness       | Program                    | Models                                                         |
| ------------- | -------------------------- | -------------------------------------------------------------- |
| `pi`          | headless Pi RPC process    | every Pi-configured provider, including OpenAI Codex (“Codex”) |
| `claude-code` | native `claude` CLI (this) | Claude models, fixed per conversation at creation (no picker)  |

There is no third harness. “Codex” stays Pi with the OpenAI Codex model.

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
- `claudeCode` may omit any field; defaults are `claude`, `claude-opus-5-5` and
  `high`. `effort` is one of `low`, `medium`, `high`, `xhigh`, `max` (the values
  `claude --effort` accepts). `model` must be a Claude model ID: no whitespace,
  no leading `-`, no Pi-style `provider/` prefix.
- The whole file is validated on every load, as before: unknown keys anywhere
  are rejected, and an invalid Claude section also blocks Pi turns until fixed.
  The loader creates a missing file with every section's defaults and never
  rewrites an existing file, so old three-field files stay valid unchanged.

Loaders in `../settings.ts`:

| Function                                  | Returns                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| `loadAgentConfiguration(dir, initialize)` | the whole validated `AgentConfiguration`                |
| `loadAgentSettings(dir, profile, init)`   | Pi settings for `coding` or `quickQuestion` (unchanged) |
| `loadClaudeCodeSettings(dir, initialize)` | `ClaudeCodeSettings` (`executable`, `model`, `effort`)  |

## Session contract (`../types.ts`)

- `AgentHarness = 'pi' | 'claude-code'`. `AgentSession.harness` is absent in
  every older archive and every Pi conversation; absence means `pi`.
- `AgentSession.claudeCode` (`{model, effort}`) records the Claude model and
  effort captured when the conversation was created. Later turns use these
  values rather than the current file, so a conversation never switches model.
  The executable is still read from the file for each turn.
- `AgentBackend<Settings>` and `AgentRunRequest<Settings>` are now generic over
  the harness's settings. `AgentBackend` (default `AgentSettings`) is the Pi
  contract, unchanged. `ClaudeCodeAgentBackend = AgentBackend<ClaudeCodeSettings>`.
  `AgentHarnessBackends` is the selection surface: `{ pi, 'claude-code'? }`.
- The Claude backend has no `models()` and there is no Claude model picker.
- `emit`, `replaceChoices` and `renameSession` keep their Pi semantics, so the
  session layer, tool grouping and panel need no Claude-specific handling.

## Turn design

One `claude` process per turn, never a shell:

```text
claude --print --verbose --input-format stream-json --output-format stream-json
       --include-partial-messages
       (--session-id <companion-uuid> | --resume <companion-uuid>)
       --model <model> --effort <effort> --permission-mode bypassPermissions
       --append-system-prompt <Companion instruction>
       --mcp-config <per-turn JSON> --strict-mcp-config
```

- The prompt, and the optional screenshot as an image content block with the
  captured-window metadata as text, are written as one stream-json user message.
- The first turn uses `--session-id`; follow-ups use `--resume`. A resume whose
  transcript is missing fails the turn visibly. There is no `--fallback-model`.
- The `system/init` event's model (and effort, where reported) is checked
  against the settings before any answer is accepted; drift fails the turn.
- Companion-launched Claude sessions deliberately use `bypassPermissions`
  (Tijs's decision, for these sessions only). There is no approval UI.
- Cancellation, stderr capping, oversized-record guards and process-group
  cleanup follow `../pi-backend.ts`.
- The child environment sets `COMPANION_INTERNAL_AGENT=1` and removes
  `COMPANION_EXTERNAL_SOCKET`, like Pi.

## Tool bridge design

A stdio MCP server started by Claude Code from the per-turn `--mcp-config`
exposes the Companion tools with the same names, schemas and descriptions as
the native Pi extensions (`companion_choices`, `companion_name_session`, the
widget tools and the session lifecycle tools). Claude Code shows them to the
model as `mcp__companion__<name>`; the transcript mapper removes this prefix so
stored tool bubbles keep Pi's names.

Widget and session tools call the same turn-scoped loopback leases Pi uses.
Choices and session names cannot travel on Claude's output stream as structured
results, so the backend opens its own per-turn loopback route with a random
bearer token. The MCP server posts validated choices and names there, and the
backend publishes them through `replaceChoices` and `renameSession` only after
the matching tool call completes successfully. The backend validates again.
The route and token expire when the turn ends.
