# Developing Companion

Reconciled with main at `46f301d` on 2026-09-22. This is an entry point for
developers, including agents started inside Companion. Check the current tree
and feature ledger before treating a dated status as current.

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

| Responsibility                                                                         | Source                                                          | Guide                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLI assembly and config                                                                | `src/cli.ts`, `src/config.ts`                                   | [User guide](../README.md), [module contracts](module-interfaces.md)                       |
| Speech/typed observation queue, context and intent selection                           | `src/core/`, `src/processors/`                                  | [Module contracts](module-interfaces.md), [desktop protocol](../src/desktop/README.md)     |
| Capture, VAD and persistent ASR                                                        | `src/sensors/`, `native/asr-worker/`                            | [Short phrases](short-phrase-recognition.md), [ASR worker](../native/asr-worker/README.md) |
| Provisional endpoint, speech continuation and commitment                               | `src/core/utterance-continuation.ts`, `src/core/pipeline.ts`    | [Speech timing](speech-timing.md)                                                          |
| Pi/Claude Code sessions, harness selection, follow-up queue, choices, naming and tools | `src/agents/`                                                   | [Agent contracts](../src/agents/README.md)                                                 |
| History, exact intent requests, feedback and deletion                                  | `src/desktop/`, `src/core/intent-request.ts`                    | [Storage and protocol](../src/desktop/README.md)                                           |
| Shared Activity/conversation components                                                | `integrations/panel/`                                           | [Desktop protocol](../src/desktop/README.md), `test/panel/`                                |
| Standalone Window/Sidebar/Dock client                                                  | `integrations/window/`, `native/window/`                        | [Native setup and validation](../native/window/README.md)                                  |
| Omarchy shortcuts, theme, media and focus bridge                                       | `integrations/omarchy/`                                         | [Adapter guide](../integrations/omarchy/README.md)                                         |
| Widget tools, durable state and browser views                                          | `src/widgets/`, `src/agents/widget-tools.ts`, `widget-library/` | [Widget authoring](../widget-library/README.md)                                            |
| Native WebEngine profile/module                                                        | `native/widget-renderer/`                                       | [Native renderer](../native/widget-renderer/README.md)                                     |
| Application text delivery                                                              | `src/system/type-text.ts`, `integrations/wtype/`                | [Patched writer and activation](../integrations/wtype/README.md)                           |
| Automatic transcription cleanup (optional, default off)                                | `src/core/transcription-cleanup/`                               | [Transcription cleanup](transcription-cleanup.md)                                          |

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

| Configuration                                                                       | Applies to                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Optional `companion.config.json` in the launch directory, or CLI `--config`         | Intent LLM, ASR and VAD; defaults in `src/config.ts`.                                                                                                                                                                                            |
| `~/companion/agents/companion-agent.json`                                           | Pi executable and coding model/thinking; nested `quickQuestion` model/thinking; `codingDefaultHarness` and `claudeCode` executable/model/effort. Reloaded for each turn; a Claude Code conversation's model changes only with its footer picker. |
| Pi's provider configuration and credentials                                         | Providers used by Pi; quick questions require its local-Qwen provider to exist.                                                                                                                                                                  |
| `~/companion/agents/claude-tools.json` (proposed, opt-in; not created by Companion) | Pi-parity tool groups for Claude Code conversations (desktop, OpenRig, web); see [parity tools](../src/agents/claude/parity/README.md).                                                                                                          |
| `~/companion/disabled-intents.json`                                                 | Independent persisted inference/shortcut switches.                                                                                                                                                                                               |
| `~/companion/transcription-cleanup.json`                                            | Transcription cleanup switch; missing means off.                                                                                                                                                                                                 |

A Claude Code conversation's model changes only through its footer picker, for
the next turn and in the same Claude history; its effort never changes.

Do not edit literal user-approved prompts as part of an unrelated refactor.
The live panel transcript currently has limits of **800 bubbles** and
**1,000,000 UTF-16 code units**, defined in `src/agents/transcript-limits.ts`.
Consecutive tool calls share one collapsed bubble. Their inputs/results are
stored separately and loaded only on expansion in bounded pages; they consume
no panel text budget. See [lazy tool transcript pages](../src/desktop/README.md#lazy-tool-transcript-pages)
for the protocol and separate storage limits.

## Validate without activating

Use dependencies matching the checkout's lockfile (`npm ci` for a fresh checkout).
Run checks appropriate to the change:

```sh
npm run check
npm test
npm run format:check
git diff --check
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
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

| Changed component                        | Activation                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Listener TypeScript, pipeline, agents    | Stop the existing listener in its terminal, then `npm start` from the intended checkout.                                                         |
| Rust ASR helper                          | `npm run asr:build` in that checkout, then restart the listener.                                                                                 |
| Standalone native C++ or Qt dependencies | `npm run ui:build`, then stop/relaunch the UI with `npm run ui`. Rebuild after Qt upgrades because Sidebar/Dock use matching private Qt headers. |
| Source-launched UI QML                   | Stop/relaunch the UI; restarting the listener does not reload it. Packaged UI assets require their own update.                                   |
| Installed Omarchy QML or Lua             | `npm run omarchy:install` from a Hyprland desktop terminal. QML changes rescan the plugin; changed bindings can reload Hyprland.                 |
| Pi/Claude Code model settings            | Edit the profile config; the next turn reloads it without a listener restart. Claude conversations keep effort; only their picker changes model. |

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
