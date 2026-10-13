# Developing Companion

Reconciled with main at `46f301d` on 2026-09-22. This is an entry point for
developers, including agents started inside Companion. Check the current tree
and feature ledger before treating a dated status as current.

For a new machine, follow the [installation guide](installation.md) first. It
includes model acquisition, agent setup and explicit capture/activation checkpoints;
this developer guide assumes those prerequisites.

Material that used to live in the README is in two places:
[using Companion](using-companion.md) is the short user guide, and
[architecture and internals](architecture.md) holds the module graph, data flow
and review order, text delivery, tests, code style and the detailed behavior and
configuration reference (start modes, prefix rules, panel, history,
prerequisites and `companion.config.json`).

## Find the right directory

On Tijs's machine:

| Location                                                         | Purpose                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `/home/user/Work/companion`                                      | Source checkout; main branch is named `master`.                      |
| `/home/user/companion/agents`                                    | Pi agents' working directory and shared memory; not the source repo. |
| `/home/user/companion/agents/memory/software/projects/companion` | Project index, tech-lead instructions, feature/review ledger.        |
| `/home/user/companion/utterances.sqlite`                         | Live utterance database; use temporary databases for tests.          |
| `/home/user/companion/widget-library`                            | Live widget source (user library, unversioned scratch space).        |
| `widget-library/` in a source checkout                           | Tracked example widgets, their tests and the widget guide.           |

Read the source checkout's `AGENTS.md` and the relevant shared project notes
before editing. On this machine `AGENTS.md` is intentionally Git-ignored, so a
worktree must read `/home/user/Work/companion/AGENTS.md` explicitly. Preserve
uncommitted widget designs, tests and other agents' work. Author live widgets in
the user library (`--widget-library`/`COMPANION_WIDGET_LIBRARY`, default
`~/companion/widget-library`); it is not a Git repository. Create worktrees under
`.worktrees/`; implementation, review readiness, merge and deployment are separate
milestones. User instructions can waive review for a particular change.

## Source and documentation map

| Responsibility                                                                         | Source                                                           | Guide                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| CLI assembly and config                                                                | `src/cli.ts`, `src/config.ts`                                    | [Using Companion](using-companion.md), [architecture](architecture.md), [module contracts](module-interfaces.md) |
| Speech/typed observation queue, context and intent selection                           | `src/core/`, `src/processors/`                                   | [Module contracts](module-interfaces.md), [desktop protocol](../src/desktop/README.md)                           |
| Capture, VAD and persistent ASR                                                        | `src/sensors/`, `native/asr-worker/`                             | [Short phrases](short-phrase-recognition.md), [ASR worker](../native/asr-worker/README.md)                       |
| Provisional endpoint, speech continuation and commitment                               | `src/core/utterance-continuation.ts`, `src/core/pipeline.ts`     | [Speech timing](speech-timing.md)                                                                                |
| Manual recording into a conversation's text box (Record / Stop recording)              | `src/core/dictation/`, `src/sensors/audio/dictation-listener.ts` | [Desktop protocol](../src/desktop/README.md#manual-recording-into-the-text-box)                                  |
| Pi/Claude Code sessions, harness selection, follow-up queue, choices, naming and tools | `src/agents/`                                                    | [Agent contracts](../src/agents/README.md)                                                                       |
| History, exact intent requests, feedback and deletion                                  | `src/desktop/`, `src/core/intent-request.ts`                     | [Storage and protocol](../src/desktop/README.md)                                                                 |
| Shared Activity/conversation components                                                | `integrations/panel/`                                            | [Desktop protocol](../src/desktop/README.md), `test/panel/`                                                      |
| Standalone Window/Sidebar/Dock client                                                  | `integrations/window/`, `native/window/`                         | [Native setup and validation](../native/window/README.md)                                                        |
| In-panel web browser (native window only)                                              | `integrations/panel/PanelBrowser*.{qml,mjs}`                     | [Panel browser](panel-browser.md)                                                                                |
| Omarchy shortcuts, theme, media and focus bridge                                       | `integrations/omarchy/`                                          | [Adapter guide](../integrations/omarchy/README.md)                                                               |
| Widget tools, durable state and browser views                                          | `src/widgets/`, `src/agents/widget-tools.ts`, `widget-library/`  | [Widget authoring](../widget-library/README.md)                                                                  |
| Native WebEngine profile/module                                                        | `native/widget-renderer/`                                        | [Native renderer](../native/widget-renderer/README.md)                                                           |
| Application text delivery                                                              | `src/system/type-text.ts`, `integrations/wtype/`                 | [Patched writer and activation](../integrations/wtype/README.md)                                                 |
| Automatic transcription cleanup (optional, default off)                                | `src/core/transcription-cleanup/`                                | [Transcription cleanup](transcription-cleanup.md)                                                                |
| Capture storage: archiving audio/screenshots (default off) and labeling gate           | `src/capture-storage/`                                           | [Capture storage](capture-storage.md)                                                                            |
| Opt-in phone gateway, its supervised service and phone panel                           | `src/remote/`, `bin/companion-phone`, `integrations/mobile/`     | [Gateway](../src/remote/README.md), [service](mobile-startup.md), [phone app](../integrations/mobile/README.md)  |
| Opt-in listener/UI start after desktop login (systemd user units)                      | `src/login-startup/`, `bin/companion-login`                      | [Installation step 8](installation.md#8-start-companion-after-login-optional)                                    |
| Trusted local web apps: registry, lifecycle, app windows, phone app proxy              | `src/apps/`, `bin/companion-app`                                 | [Local apps](local-apps.md)                                                                                      |

The standalone Qt host is the current native UI path. The private Quickshell
build documented under `native/widget-renderer/` is an experimental alternative;
it is not required to build or run the standalone host. Stock Quickshell still
supports the portable panel and captured widget frames.

## Inputs, prompts and settings

Speech and Activity text share `SensorPipeline` ordering, screenshot/context
capture, routing, history and feedback. Activity text first restores application
focus and skips ASR; it creates no WAV. Conversation composer text instead goes
straight to that conversation's follow-up queue. Preserve this distinction.

Permanent intent wording lives in `src/processors/`; system assembly and user
JSON live in `src/core/intent-detector.ts`. Transcription cleanup wording lives
in `src/core/transcription-cleanup/prompt.ts`. Scoped choice instructions live in
`src/agents/choice-intents.ts`. For an actual past classifier request, use
`utterances.intent_request` and its screenshot reference as described in the
[protocol guide](../src/desktop/README.md). Reassembling today's instructions is
not an exact replay of yesterday's dynamic prompt. Prefix-only dispatches do not
call the classifier. Old design proposals contain historical prompt snapshots.

| Configuration                                                                       | Applies to                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional `companion.config.json` in the launch directory, or CLI `--config`         | Intent LLM, ASR and VAD; defaults in `src/config.ts`.                                                                                                                                                                                                                                                                                                           |
| `~/companion/agents/companion-agent.json`                                           | Pi executable and coding model/thinking; nested `quickQuestion` model/thinking; `codingDefaultHarness`, optional `codingDefaultPiModel` and `claudeCode` executable/model/effort. Reloaded for each turn; a Claude Code conversation's model changes only with its footer picker. Activity's “Start a coding session” card edits only the new-session defaults. |
| Pi's provider configuration and credentials                                         | Providers used by Pi; the configured `quickQuestion.model` provider must exist (the default is installation-specific).                                                                                                                                                                                                                                          |
| `~/companion/agents/claude-tools.json` (proposed, opt-in; not created by Companion) | Pi-parity tool groups for Claude Code conversations (desktop, OpenRig, web); see [parity tools](../src/agents/claude/parity/README.md).                                                                                                                                                                                                                         |
| `~/companion/disabled-intents.json`                                                 | Independent persisted inference/shortcut switches.                                                                                                                                                                                                                                                                                                              |
| `~/companion/transcription-cleanup.json`                                            | Transcription cleanup switch; missing means off.                                                                                                                                                                                                                                                                                                                |
| `~/companion/capture-storage.json`                                                  | Whether captured audio/screenshots are archived; missing or invalid means off ([capture storage](capture-storage.md)).                                                                                                                                                                                                                                          |

A Claude Code conversation's model changes only through its footer picker, for
the next turn and in the same Claude history; its effort never changes.

Do not edit literal user-approved prompts as part of an unrelated refactor.
Conversation history is retained independently of the display. Recent and
historical pages contain at most **200 bubbles / 65,536 UTF-16 text/input units**,
defined in `src/agents/transcript-limits.ts`; these limits never reject a turn.
The desktop panel loads older and newer pages as the reader scrolls, keeping at
most three pages resident; the phone offers Load older, Newer, Refresh and Latest. See
[paged conversation history](../src/desktop/README.md#paged-conversation-history)
for window/delta semantics and compatibility. Consecutive tool calls share one
collapsed bubble. Their inputs/results are stored separately and loaded only on
expansion in bounded pages; they consume no panel text budget. See [lazy tool transcript pages](../src/desktop/README.md#lazy-tool-transcript-pages)
for the protocol and separate storage limits.

## Validate without activating

Use dependencies matching the checkout's lockfile. For a fresh CPU-only checkout,
use `ONNXRUNTIME_NODE_INSTALL=skip npm ci`; see the [installation guide](installation.md)
for the optional CUDA download this skips.
Run checks appropriate to the change:

```sh
npm run check
npm test
npm run format:check
git diff --check
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
# Omarchy bar indicator state, with stub shell modules (not live Quickshell):
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -import test/omarchy/stubs -input test/omarchy
```

For native-window changes, build with `npm run ui:build`, then run
`npm run test:window`. See the native guide for Qt/WebEngine/LayerShellQt
dependencies and the window-only option. ASR changes use `npm run asr:build`,
`npm run asr:test` and the relevant prerecorded regressions. Endpoint or
continuation changes also use `npm run asr:speech-timing`, which replays public
audio in real time (several minutes).

The format scripts also traverse `widget-library/`. Avoid rewriting another
agent's local work; report unrelated failures separately. Test fixtures should
use synthetic state, not production conversations, recordings or clipboard data.
Offscreen rendering does not prove live Wayland focus or GPU behavior. Read each
test's prerequisites before running desktop/compositor tests. The feature ledger
records review scope: functional widget clearance did not clear the separately
incomplete registry/isolation review.

## Updating what actually runs

These are separate operations, not an automatic deployment script:

| Changed component                        | Activation                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener TypeScript, pipeline, agents    | Stop the existing listener in its terminal, then `npm start` from the intended checkout.                                                                            |
| Rust ASR helper                          | `npm run asr:build` in that checkout, then restart the listener.                                                                                                    |
| Standalone native C++ or Qt dependencies | `npm run ui:build`, then stop/relaunch the UI with `npm run ui`. Rebuild after Qt upgrades because Sidebar/Dock use matching private Qt headers.                    |
| Source-launched UI QML                   | Stop/relaunch the UI; restarting the listener does not reload it. Packaged UI assets require their own update.                                                      |
| Installed Omarchy QML or Lua             | `npm run omarchy:install` from a Hyprland desktop terminal. QML changes rescan the plugin; changed bindings can reload Hyprland.                                    |
| Pi/Claude Code model settings            | Edit the profile config; the next turn reloads it without a listener restart. Claude conversations keep effort; only their picker changes model.                    |
| Login services (`bin/companion-login`)   | `systemctl --user restart companion-listener.service companion-ui.service` after rebuilding; rerun `companion-login enable` when Node/Pi/wtype/config paths change. |

Save unsent drafts before stopping the UI. Its window close button hides the
resident process; it does not exit it. Stop that process before relaunching when
loading new UI code. The listener, standalone UI and installed adapter must agree
on new protocol capabilities; an old bridge can reject a new UI action even when
the listener is current. Build commands do not install, start or restart these
components. Do not restart the user's active development session as a test step.

For widget source changes, existing instances retain their published bundle.
See the widget guide before expecting a source edit to alter an existing view.
The standalone host defaults to filtered 2× rendering; diagnostic controls and
`--widget-rendering normal` provide alternatives.

## Keep the documentation current

Update the relevant contract guide with a behavior change, not just a handoff
message. Keep historical proposals labelled as such. On this machine update
`memory/software/projects/companion/features.md` under the agent working
directory with exact commits, review scope, merge/deployment status, PR/MR links
and known user feedback. Read it immediately before editing to preserve other
agents' updates. Use source and Git to verify current status; a dated ledger
entry is not permission to merge or deploy.

## External session API development

`src/agents/external/` implements the optional private Linux Unix socket;
`bin/companion-session` is the CLI entrypoint, including from an unrelated cwd.
See its [contract](../src/agents/external/README.md). The external integration tests
use temporary session stores, real subprocesses and sockets, and synthetic agent
backends. Never point these tests at the live listener or personal session store.
The feature is off unless the listener is explicitly started with
`--external-sessions`; activation remains a separate user decision.

## agent-harness live state

`src/agents/harness-live-state.ts` tells a local agent-harness which Pi
conversations are busy, so its session status (and tools that read it, such as
the Omarchy agent indicator) does not drop a conversation to idle while Pi is
silently thinking or running tools. It is off unless the listener is started
with `--agent-harness-url http://127.0.0.1:8877` or
`COMPANION_AGENT_HARNESS_URL` (loopback `http://` only).

- Signal: `AgentSessions` busy, i.e. from turn start until Pi has settled
  (`agent_settled`, after retries/compaction) and the turn is saved, across
  queued follow-ups. Reported from `flush`, the single place every busy change
  passes through.
- Identity: only Pi conversations, as `ses_<conversation id without dashes>`
  (Pi runs with `--session-id <conversation id>`). Claude Code conversations
  are not reported.
- Ownership: every Companion Pi process loads
  `src/agents/live-state-owner-extension.ts`, which writes one custom transcript
  entry (`agent-harness.live-state-owner`, `{"source": "companion"}`) per
  conversation. It is never sent to the model. The harness accepts Companion's
  reports only for sessions whose transcript carries it.
- Wire: `PUT /v1/sessions/<id>/live-state` with `busy` + 45 s lease, renewed
  every 15 s, and one `idle` at the end. Metadata only. Every busy period (turn)
  owes its own final idle, whether or not a busy was sent or acknowledged for
  it; turns are numbered so a late answer for an older turn cannot cancel a
  newer one. An undelivered idle is retried a few times. Requires an agent-harness that has this route; an older harness
  answers 404/405 and nothing changes.
- Never blocks a conversation: fire-and-forget, one request in flight per
  conversation (latest state coalesced), 3 s overall deadline, failures logged
  once per outage; `close()` still delivers a coalesced final idle within 2 s.
  Plain `node:http` through a private agent: environment proxies are ignored,
  redirects are not followed, and the connection is closed as soon as the status
  arrives (the body is never read). If Companion stops, the harness lets the lease
  expire and falls back to its transcript rule.

Tests (`test/unit/harness-live-state.test.ts`) use a fake transport, local
loopback servers for the proxy/redirect check, and the scripted-backend
fixture; nothing contacts a real harness.

## Local app development

`bin/companion-app` registers, runs and opens trusted local web apps; nothing
starts it automatically and it never restarts Companion. `npm run apps:demo` runs
the synthetic CSV notebook in a temporary directory. Unit tests
(`test/unit/apps-*.test.ts`, `test/unit/remote-apps.test.ts`) run with `npm test`;
`npm run test:apps` drives real headless Chromium with temporary profiles. Tests
and demos must use temporary registries (`--apps-directory`), profiles and
non-live ports; never the live `~/companion/apps`, the live gateway port or its
state. Registering real apps, enabling phone access and configuring app host
names/TLS are separate user decisions. See [the guide](local-apps.md).

## Phone panel development

`bin/companion-remote` is an opt-in gateway for the phone app in
`integrations/mobile/`; nothing starts it automatically. `bin/companion-phone`
optionally supervises it as a pinned, hardened transient systemd user service
([guide](mobile-startup.md)); `npm run test:phone-service` exercises that against
the real user manager with uniquely named test units and synthetic state only. `npm run mobile:build`
builds the app, `npm run mobile:demo` runs a fully synthetic listener and gateway
on loopback, and `npm run test:mobile` drives the built app in headless Chromium.
Gateway and remote-role unit tests use temporary state and synthetic backends.
Pairing a real phone, serving on a Tailscale address and running the production
listener with this protocol are separate user decisions.

## Self-wake scheduling

The backend-owned one-shot scheduler is under `src/agents/wakes/`, independent
of ordinary saved transcript queues. See the [agent contract](../src/agents/README.md#self-wake-timers)
and [synthetic acceptance matrix](self-wake-validation.md). The timer suite uses
injected time, disposable stores and scripted backends; do not substitute a live
conversation or listener. Build/check/test commands do not authorize live timers,
service restarts or activation. The exact combined backend/tool/UI revision needs
independent cross-model review before a merge decision.
