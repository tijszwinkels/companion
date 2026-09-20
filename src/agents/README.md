# Conversation tools

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
There is no implicit model fallback, and the detector's prompt is unchanged.

## HTML conversation bubbles

The native Pi extension `html-tool.ts` registers `companion_html` on each backend
invocation. Its own `promptSnippet` and `promptGuidelines` encourage small useful
diagrams, comparisons and cards when they improve an explanation. Ordinary
Markdown remains available. Existing system and user-edited intent prompts are
unchanged; there is no second model request, browser window or UI action channel.

```json
{
  "html": "<table width=\"100%\" cellpadding=\"8\"><tr><td style=\"background-color: var(--selection)\">Input</td><td>→</td><td style=\"color: var(--accent)\">Result</td></tr></table>",
  "text": "Input leads to Result."
}
```

Each successful call publishes one bubble. The text must stand on its own: it is
used by older panels, CLI logging, whole-message Copy and the **Show text** toggle.
Selection copies the rendered text; neither selection nor the toggle takes
composer focus or clears its draft. Completed graphics stay in saved and reopened
conversations. Ordinary choices, naming and queued follow-ups use their existing
paths. A new call adds another bubble rather than editing a previous answer.

### Renderer and bounds

This uses Qt's native rich text, **not full browser HTML**. On this host, Qt 6.11.2
and Quickshell render the example above and a two-column comparison. Although the
QtWebEngine module is installed, an isolated offscreen Quickshell WebEngine probe
crashed on initialization (`Argument list is empty ... QCoreApplication`). No new
system dependency is needed for the chosen renderer. SVG, flex/grid, arbitrary
CSS and interactive HTML are deliberately unsupported.

`integrations/panel/Html.mjs` is shared by Node and QML, with `.d.mts` declarations
for TypeScript. It parses a restricted, balanced fragment and reconstructs every
tag and attribute. The tool validates before returning; the RPC transcript,
saved-session reader and panel validate again at their respective boundaries.
No accepted tag, attribute or CSS value can load a file/remote resource or invoke
a command. This is a capability allowlist, not an attempt to sandbox unrestricted
HTML. There are no images, links, document headers, scripts, event handlers,
forms, URL-valued CSS, style blocks or embedded objects. Text entities are decoded
once and escaped again; the fallback is always escaped before rich-text display.
QML receives no agent-supplied QML, shell command, file path or executable plugin.

Accepted tags: `p div span b strong i em u s small sub sup code br hr ul ol li h3
table tr td th`. Attributes must be lowercase and quoted: `align` (left/center/right),
`style`, percentage `width` on table/td/th, and table `cellpadding` (0–12) and
`cellspacing` (0–8). Supported inline styles are `color`, `background-color`,
`font-size` (12–24px), `font-weight` (normal/bold/400–700), `font-style`
(normal/italic) and `text-align` (left/center/right). Colors accept six-digit
lowercase hex or `var(--foreground)`, `var(--muted)`, `var(--accent)` and
`var(--selection)`; prefer theme variables. These variables are substituted by
Companion, not a browser CSS engine. Use literal Unicode for diagram arrows.
Native text layout may simplify formatting; it is not a pixel-perfect web layout.

Limits are 12,288 HTML and 4,000 fallback UTF-16 code units, 160 elements, eight
levels, and four columns/twelve rows per table, with no nested tables. HTML counts
toward the existing 256 KiB transcript character budget and 200-message limit.
Font sizes and table spacing follow reader zoom. A measured layout exceeding the
available bubble width or 480 scaled pixels of height displays the text fallback
instead of clipping a diagram or adding a nested scroll area. Malformed or
unsupported saved HTML also keeps its text. Fixed author colors do not adapt to
theme changes; theme variables do.

### Publication and verification

Only a successful `tool_execution_end` correlated to `companion_html` publishes.
The running tool row is replaced atomically with a completed assistant message,
including `text` and optional `html`; partial results, unrelated tools, errors,
duplicate completions and results received after cancellation cannot publish.
Invalid result metadata produces a visible text fallback/notice without losing
the rest of the answer. A turn's retained message callback is ignored after it
settles. Completed visuals before a later cancellation remain readable history.

`test/unit/agent-html.test.ts` checks the native tool, rejected resource/action
syntax, bounds, real subprocess RPC, lifecycle gates, archive/reopen, damaged
HTML, transcript budget and late callbacks. `test/panel/tst_html.qml` renders an
actual diagram and comparison, checks colored pixels and cell geometry, theme,
zoom, bounds, literal fallback, selection/Copy, composer drafts/focus, scrolling,
streaming, incremental tool-row replacement and reconnect/restore. Its synthetic
preview is `/tmp/companion-html-bubbles.png`. The staged installer test checks that
both renderer files are copied.

The installed Pi 0.85.1 binary registered the extension and included its schema,
snippet and guideline in an isolated offline startup with no model request. An
isolated offscreen Quickshell process also loaded `HtmlBubble` and rendered the
diagram successfully. These checks prove native rendering and protocol handling;
they do not prove how often a model chooses the tool or the live Wayland sidebar
experience. No live installation, listener restart, desktop input or microphone
test was performed. After integration and an independently authorized install,
ask an agent to explain a short pipeline with `companion_html`, then check the
text toggle, copy, zoom, reopen, and a freeform queued follow-up in the sidebar.

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
titles without an emoji keep their Q number. Ring animations stop while the panel
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
tool calls; the installed older sidebar could not render them. The complete
model-to-panel click/voice loop and native compositor interaction have not yet
been verified for this feature.
No choices are inferred from arbitrary bracketed answer text; the model must use
the tool. The existing headless-backend restriction on unrelated interactive Pi
dialogs remains in effect.
