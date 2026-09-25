# Pi-tool parity for Claude Code conversations

A Companion-launched Pi session has more tools than Companion's own 13: Pi's
built-ins and the user's global Pi extensions and packages. This directory
gives Claude Code conversations Companion-owned equivalents where Claude Code
has none. They are served by the same stdio MCP bridge as the Companion
tools (`../mcp-server.ts`), so Claude sees them as
`mcp__companion__<Pi name>` and Companion's transcript stores Pi's names.

Inventory verified on 2026-09-25 against Pi 0.86.1 settings
(`~/.pi/agent/settings.json`), `~/.pi/agent/extensions/`, the npm packages
`pi-web-access` 0.29.0, `pi-bash-live-view` and `@fitchmultz/pi-mcp-adapter`
6.0.0, and `~/.pi/agent/fitch-mcp-adapter/mcp.json` (server list only; no
credential files were read).

## Activation: opt-in `claude-tools.json` (proposal)

Nothing here is active until the user creates `claude-tools.json` in the
agent directory (`~/companion/agents`, next to `companion-agent.json`). The
file name and shape are a **proposal for Tijs to confirm at activation**;
Companion never creates or edits it.

```json
{
  "desktop": {
    "pointerHelper": "/home/user/.pi/agent/extensions/active-window/pointer-click"
  },
  "openRig": { "directory": "/home/user/openrig-companion-demo" },
  "web": {}
}
```

- Each section enables one tool group; omit a section to leave its tools out.
- **Trust:** `openRig.directory` names code, not data. The bridge imports that
  checkout's `lib/tasks.mjs` and `lib/previews.mjs` and runs them inside the
  bridge process with the user's permissions, on every OpenRig tool call.
  Point it only at a checkout you trust, as you would a Pi extension. Likewise,
  `desktop.pointerHelper` is an executable the bridge runs to click.
- A missing file enables nothing. Unknown keys, relative paths or invalid
  JSON stop the bridge, so Claude Code reports the `companion` MCP server as
  `failed` in `init` and the backend fails the turn visibly (it requires
  `connected` or `pending`). Probed with Claude Code 2.1.280 and the real
  bridge, using the local `/cost` command so no model call was made: an
  invalid file gave `failed`, a valid one `connected`. This matches the strict
  validation of `companion-agent.json`, whose user-approved schema stays
  unchanged.
- The bridge reads the file from its working directory. Claude Code starts
  stdio MCP servers in its own working directory, which Companion sets to the
  agent directory (probed with Claude Code 2.1.280, no model call).
- Changes apply to the next turn; existing conversations need no restart.
  Claude Code's system-prompt snapshot keeps a conversation's first tool
  guidance (`instructions`), so tool hints of newly enabled groups reach new
  conversations; the tools themselves are listed on every turn.

## Per-tool matrix

“Same” means same name, description, prompt hints and JSON Schema (compared
programmatically with Pi's TypeBox output for the desktop and OpenRig tools)
and the same behaviour, guards and messages, verified by the named tests with
synthetic fixtures. Claude built-ins are Claude Code 2.1.280's own tools.

| Pi tool (source)                                   | Claude Code conversation                                              | Parity                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`, `edit`, `write` (Pi built-ins)             | Claude built-ins `Read`, `Edit`, `Write`                              | Native equivalents (different names and schemas)                                                                                                                                                                                                                                                                                                         |
| `bash` (Pi built-in; `pi-bash-live-view` renderer) | Claude built-in `Bash`                                                | Native equivalent. The live view is Pi's terminal renderer, not a tool                                                                                                                                                                                                                                                                                   |
| 13 Companion tools                                 | Bridge (`../bridge-tools.ts`)                                         | Same, per lease (see `../README.md`)                                                                                                                                                                                                                                                                                                                     |
| `list_windows` (active-window)                     | `desktop` group                                                       | Same                                                                                                                                                                                                                                                                                                                                                     |
| `focus_window` (active-window)                     | `desktop` group                                                       | Same                                                                                                                                                                                                                                                                                                                                                     |
| `screenshot_active_window` (active-window)         | `desktop` group; MCP image block                                      | Same, except a PNG over 3.75 MiB is recaptured as JPEG q80 in the same identity bracket (Claude's 5 MB image limit); Pi allows 20 MiB PNG                                                                                                                                                                                                                |
| `click_active_window` (active-window)              | `desktop` group; helper path from config                              | Same guards; a real click requires `desktop.pointerHelper` (dry runs work without it)                                                                                                                                                                                                                                                                    |
| `openrig_submit` (OpenRig demo)                    | `openRig` group, adapter over `<directory>/lib/tasks.mjs`             | Same; idempotency, scope and bounds come from the demo library itself                                                                                                                                                                                                                                                                                    |
| `openrig_progress` (OpenRig demo)                  | `openRig` group                                                       | Same, except intermediate watch updates (Pi renders them in its UI; the model sees only the final state in both)                                                                                                                                                                                                                                         |
| `openrig_preview` (OpenRig demo)                   | `openRig` group, adapter over `<directory>/lib/previews.mjs`          | prepare/build/status same. **start/stop always refused**: they need direct human confirmation; a Companion-launched Pi cancels that dialog and fails the turn, Claude has no dialog                                                                                                                                                                      |
| `fetch_content` (pi-web-access)                    | `web` group (Companion's own fetcher) plus Claude built-in `WebFetch` | **Partial**: `url`/`urls` (at most 10), modes `readable` and `raw`, Pi's slices and texts; an untruncated single result also ends with its `responseId` (Pi shows it only when truncated) so passages can be found later. Not: `answer` mode, video/frames, GitHub clone, PDF, images, cookie `auth`, `proxy`. Readable is plain text, not Pi's Markdown |
| `get_search_content` (pi-web-access)               | `web` group                                                           | **Partial**: fetch results only (`url`/`urlIndex`, `offset`/`limit`, `findText`/`findMode`, same texts). No `query`/`queryIndex` (no stored searches). Retention 24 h in the runtime directory, instead of Pi's session                                                                                                                                  |
| `web_search` (pi-web-access)                       | Claude built-in `WebSearch`                                           | **Class only, blocked for exact parity** (see below)                                                                                                                                                                                                                                                                                                     |
| `source_check` (pi-web-access)                     | `WebSearch` + `fetch_content` + `get_search_content` `findText`       | **Blocked** as one tool (see below)                                                                                                                                                                                                                                                                                                                      |
| `mcp` gateway and its tool search (pi-mcp-adapter) | Claude Code's native MCP                                              | Gateway not needed; its only configured server is Google Workspace (below)                                                                                                                                                                                                                                                                               |
| Google Workspace MCP (11 included tools)           | **Not available**                                                     | **No parity** until Tijs decides (proposal below). Claude.ai account connectors are separate and unauthorized                                                                                                                                                                                                                                            |
| `AGENTS.md` context                                | Claude Code 2.1.277+ reads `AGENTS.md` as a fallback context file     | Native (per official docs); an activation-time check on 2.1.280 is still pending                                                                                                                                                                                                                                                                         |

## Guards that carry over

- **Desktop.** Screenshots are bracketed by two active-window reads and
  discarded if the window or its geometry changed; no full-screen fallback;
  private temporary directory removed on every path. Clicks require the
  address and region of a fresh screenshot, re-check the window after moving
  the cursor, verify the cursor position and never send a click after a
  mismatch. Focus requires address, app and PID from a fresh list. In
  addition, one bridge serializes all desktop actions, because Claude Code can
  call tools in parallel. Tests use a synthetic compositor only.
- **OpenRig.** The demo library enforces its stable-ID idempotency, the
  Companion steward scope, its loopback endpoint and its preview locks. The
  adapter never loads the demo for start/stop. Tests use a fake library.
- **Web.** Only `http:`/`https:` without credentials. Names resolve once;
  every answer must be a public unicast address (loopback, private,
  link-local, CGNAT, multicast, reserved, documentation and IPv4-embedding
  IPv6 forms are refused), and the connection goes to that vetted address.
  Every redirect (at most 5) repeats the checks. Bodies are capped at 5 MiB
  after decompression, text types only, no proxy. One 30 s deadline covers
  the whole fetch, DNS lookups included: cancellation or the deadline stops
  waiting for a lookup that never answers, and a late answer is never
  connected to. Retained results are 0600 files in a private 0700
  `$XDG_RUNTIME_DIR/companion-claude-web`
  (owner and mode checked, never repaired, no symlinks), 24 h expiry, 64 MiB
  total, oldest removed first. Tests use a loopback fixture server behind a
  fixed name table and never contact the network.

## Blocker: web search and `source_check`

Companion's Pi runs the coding model `openai-codex/gpt-6-astra`. pi-web-access's
automatic provider choice then searches through **OpenAI via Pi's own model
registry and OAuth login** (`openai-search.ts`, `isOpenAICodexSelected`). That
login belongs to Pi; Claude Code cannot use it, and copying it would move
the user's OpenAI credentials into another tool. `source_check` needs the same
search step. Exact parity is therefore blocked. Options:

1. **Current:** Claude's built-in `WebSearch` (Anthropic's search) for
   discovery, then `fetch_content` and `get_search_content` `findText` for
   exact, citable passages. Covers the workflow, not the one-call artifact.
2. **Keyed provider:** Tijs supplies an API key for a provider pi-web-access
   also supports (for example Brave, Exa or Tavily). Companion could then
   offer `web_search`/`source_check` with that provider in both harnesses.
   Needs a provider, cost and credential decision.
3. **Self-hosted SearXNG:** pi-web-access prefers a configured SearXNG
   instance. A local instance would give both harnesses keyless search. Needs
   installation approval.
4. **Pi as a tool host:** run pi-web-access itself through Pi's SDK with Pi's
   login. Claude conversations would then search with Tijs's OpenAI Codex
   subscription and depend on Pi internals. Not recommended without explicit
   approval.

## Proposal: Google Workspace (not implemented)

Pi reaches a local Google Workspace MCP server (`http://127.0.0.1:8767/mcp`)
through pi-mcp-adapter, lazily, with 11 included tools: Gmail search/read,
threads, attachments, labels, calendars, events, free/busy and
`manage_event` (a write). The server holds its own Google authorization.

A safe opt-in route, for Tijs to decide:

- A `googleWorkspace` section in `claude-tools.json` naming the URL and the
  exact tool allowlist. The bridge would act as an MCP client of that local
  server and re-expose **only** the allowlisted tools, so the allowlist is
  enforced by Companion rather than by Claude settings. No token is copied,
  no `~/.claude` setting changes and no account connector is authorized.
- Decisions needed first: whether Gmail and calendar content may go to
  Anthropic (today it goes to the Pi model's provider); whether `manage_event`
  (writes) is included; and the still-open question of inheriting the user's
  own Claude MCP servers versus `--strict-mcp-config`.
- Until then there is **no Google parity** in Claude conversations.

## Tests

- `test/unit/claude-mcp-images.test.ts`: image blocks and their 5 MiB bound
  on the real stdio server.
- `test/unit/claude-parity-desktop.test.ts`: the desktop tools against a
  synthetic compositor, including stale identities between screenshot and
  click, mid-capture changes and parallel calls.
- `test/unit/claude-parity-openrig.test.ts`: the adapter against a fake demo
  library, including start/stop refusal and Pi's truncation.
- `test/unit/claude-parity-web.test.ts`: address policy, redirects to private
  ranges, DNS answers, hanging lookups (cancellation and deadline), schemes,
  size and decompression bombs, content types, find/slice texts and the
  store's permissions, expiry and size cap.
- `test/unit/claude-parity-bridge.test.ts`: `claude-tools.json` validation and
  the real bridge process with each group (fake `hyprctl`/`grim` on `PATH`).

No test touches the real desktop, an OpenRig queue or preview, the network,
personal data or live Companion state. No live Claude turn has exercised
these tools yet; that needs activation approval.
