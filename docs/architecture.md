# Architecture and internals

How Companion's listener is put together: the inspectable module graph, the
data flow from microphone to processor, text delivery guarantees, tests and code
style. Start with the [development guide](development.md) for the source map,
configuration and activation steps; user-facing behavior is described in
[using Companion](using-companion.md).

## Inspect the module graph

Export the current pipeline wiring without opening the microphone, capturing the
screen, contacting the model, or starting desktop services:

```sh
npm run --silent start -- --graph mermaid
npm run --silent start -- --graph json
```

Modules expose an ID, a label, and their actual named dependencies. The graph
also reads the router's processor registrations, including prefixes and LLM
eligibility. Constructor arguments and `subscribe(router)` still wire the app;
there is no separate connection registry or graph execution engine.

This graph starts at the sensor pipeline. It includes capture, transcription,
routing, processors, and the shared keyboard queue. Audio/VAD internals and
desktop services are outside this first inspection boundary. See the
[module inspection design](module-interfaces.md) for the interfaces,
wiring example, graph semantics, and ownership boundaries.

## Data flow and review order

The directories follow the responsibilities of the modules:

```text
src/
  cli.ts                         Start, connect, and stop the modules
  config.ts                      Read and validate configuration
  core/
    frame.ts                     Shared types and data contracts
    module.ts                    Module identity and inspectable dependencies
    graph.ts                     Read actual wiring into serializable graph data
    graph-mermaid.ts             Render graph data as a Mermaid diagram
    pipeline.ts                  Assemble frames while capture continues
    router.ts                    Register processors and dispatch frames
    prefix.ts                    Match and remove literal command prefixes
    intent-detector.ts           Compose the prompt and run one Pi turn
  processors/
    send-text-to-application.ts   Type an utterance after checking focus
    enter-text-to-application.ts  Type and press Enter on explicit command
    ignore.ts                    Handle speech that requires no action
  sensors/
    audio/
      capture.ts                 PipeWire / file input and PCM decoding
      vad.ts                     Silero speech probability
      segmenter.ts               Collect audio into utterances
      transcriber.ts             Session-owned Parakeet speech-to-text
      asr-worker.ts              Bounded pipes and native worker cleanup
    screen/
      capture.ts                 Read and capture the active window
      sensor.ts                  Named screen sensor used by the pipeline
  system/
    command.ts                   Run and cancel external commands
    text-input.ts                Automatic delivery ownership and feedback
    type-text.ts                 Shared focus checks and literal keyboard input
test/
  unit/                          Automated tests with controlled inputs
  live/                          Optional desktop and microphone checks
  fixtures/                      Public test audio
  helpers.ts                     Shared test data and small test helpers
```

```text
PipeWire → Float32Array (512 samples at 16 kHz) → Silero → Segment
                                                          │
                                      ┌───────────────────┴──────────────┐
                                      ↓                                  ↓
                                  Transcriber                    Active-window capture
                                      ↓                                  ↓
                                  utterance                          Screenshot
                                      └─────────── UserSensorFrame ───────┘
                                                         ↓
                                                 UserSensorRouter
                                                 /               \
                                          prefix match         no match
                                              ↓                    ↓
                                       strip prefix          IntentDetector
                                              ↓                    ↓
                                              │               intent name
                                              └─────────┬──────────┘
                                                        ↓
                                           matching processor.process(frame)
```

| Module                                                            | Input                                 | Output                                |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| [Audio capture](../src/sensors/audio/capture.ts)                  | PipeWire / FFmpeg PCM bytes           | `Float32Array` frames                 |
| [Voice activity detection](../src/sensors/audio/vad.ts)           | One audio frame                       | Speech probability                    |
| [Segmentation](../src/sensors/audio/segmenter.ts)                 | Probability + audio                   | `Segment` containing one utterance    |
| [Transcription](../src/sensors/audio/transcriber.ts)              | Segment samples                       | Transcript `string`                   |
| [Screen capture](../src/sensors/screen/capture.ts)                | Active Hyprland window                | `Screenshot`                          |
| [Pipeline](../src/core/pipeline.ts)                               | Audio segment + capture               | `UserSensorFrame`                     |
| [Router](../src/core/router.ts)                                   | Frame + processor subscriptions       | Dispatch to one processor             |
| [Intent detector](../src/core/intent-detector.ts)                 | Frame + registered intents            | Validated intent-name `string`        |
| [Text processor](../src/processors/send-text-to-application.ts)   | Frame, with prefix removed if matched | Type text if focus matches            |
| [Enter processor](../src/processors/enter-text-to-application.ts) | Frame with `enter` removed            | Type text, recheck focus, press Enter |
| [Ignore processor](../src/processors/ignore.ts)                   | Original frame                        | Log that no action is needed          |

Start reviewing with the shared contracts in [frame.ts](../src/core/frame.ts), then the
router, detector, and processors. [cli.ts](../src/cli.ts) wires the components.

The shared system prompt is in `core/intent-detector.ts`. Each processor keeps
its own intent instruction next to its action. Prompt text is preserved verbatim
during formatting and structural changes.

Each processor exposes a `name`, `subscribe(router)`, and `process(frame, signal)`,
plus an `instruction`, `prefixes`, or both. Subscription registers the processor
with the router. Only processors with an instruction become LLM choices;
prefix-only processors can only run through an explicit command.

A minimal prefix-only module looks like this:

```ts
import type { UserSensorFrame, UserSensorProcessor } from './core/frame.ts';
import type { UserSensorRouter } from './core/router.ts';

class Remember implements UserSensorProcessor {
  readonly id = 'remember';
  readonly label = 'Remember';
  readonly dependencies = {};

  readonly name = 'REMEMBER';
  readonly prefixes = ['remember', 'take note'];

  subscribe(router: UserSensorRouter): void {
    router.register(this);
  }

  async process(frame: UserSensorFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    // "remember buy milk" arrives here with utterance === "buy milk".
    console.log(frame.utterance);
  }
}

// In the CLI, after creating the router:
new Remember().subscribe(router);
```

Adding a module requires its implementation and a subscription in the CLI; the
detector needs no edit. Duplicate names or prefixes fail during registration.
When prefixes overlap, the longest match wins regardless of subscription order.
Only one prefix is removed: “insert enter hello” types `enter hello` without
pressing Enter. All prefix commands require a nonempty payload.

Prefix routing copies the frame with the remaining utterance, preserving the
screenshot and observation metadata. LLM routing delivers the original frame.
The router passes registrations with instructions to the detector to compose its
prompt, then invokes exactly the processor whose name comes back.

The detector wraps a Pi `Agent` from `@earendil-works/pi-agent-core`. One request
contains one user message with JSON text and an attached screenshot. Alongside
the utterance, application and focus metadata, a visibly selected conversation
contributes its title and first two/last two non-empty user or assistant messages,
with overlaps included once. These are copied at speech end and sent to the
configured intent model: at most 200 Unicode code points for the title and 2000
per excerpt. Roles, message states and truncation flags accompany the text;
tools, notices and unsent drafts are excluded. The excerpts remain contextual
data in the user message, not additional system instructions.

Each frame gets a fresh agent with thinking off, no tools, no previous sensor
frames, no retries, and a 32-token output limit. Only an exact registered name
is accepted. Invalid, truncated,
failed, or timed-out responses are logged as errors and never dispatched.

Audio/VAD runs independently of the sequential ASR/routing worker. Capture
starts at speech end, before ASR, including when a preceding frame is still being
processed. The worker holds one active and up to two queued utterances; additional
utterances are explicitly logged as dropped. Prefix commands use this same queue
and preserve speech order; they do not overtake an earlier LLM request. File input
waits for each result.

Speech end is **provisional**: after 224 ms of silence, ASR and then the intent
LLM start immediately. If speech resumes before the utterance commits to an
action, the attempt is held; a continuation replaces it with the retranscribed
whole utterance, while a rejected burst releases it unchanged. Shortcut commands
still commit only after the old 800 ms of quiet. See [speech timing](speech-timing.md).
Silero requires 128 ms of detected speech (four 32 ms frames), so short words such
as "stop", "yes", and "no" can reach transcription. Shorter triggers are discarded;
lead-in and ending silence do not count toward that minimum. The detector uses
0.65/0.35 start/continue probabilities, a 224 ms provisional ending silence, 256 ms preroll,
and a 60-second segment limit. Audio startup loads one persistent
Parakeet worker before capture. Successful utterances reuse it. Pause keeps an idle
model warm; cancellation during ASR kills the worker, and the next utterance loads
a replacement. Shutdown closes it. Failures are never replayed and the transcriber
has no additional queue. An empty result from clearly audible input gets one padded
retry on the same worker ([details](short-phrase-recognition.md#empty-result-retry)). [Protocol, recovery and measured latency](../native/asr-worker/README.md).

The pre-ASR digital-silence guard measures the strongest 128 ms audio window at
the existing RMS floor of 0.0005. Averaging over a whole utterance could otherwise
discard a quiet short phrase after adding ending silence. Audio is neither
normalized nor trimmed. Bounded numeric logs distinguish VAD rejection, quiet
input, empty model output, worker errors, and later capture/recording/routing
failures. See [short-phrase evidence and diagnosis](short-phrase-recognition.md)
and run `npm run asr:short-phrases` for a local, prerecorded regression.

## Text delivery

Both text processors use the same delivery helper to re-read the active window before invoking
`wtype`. If the window address differs from the screenshot's address, it logs a
skip and types nothing. It never restores focus. ASR text is delivered unchanged
except that matched prefixes are removed and control characters become spaces,
so newlines cannot press Enter and tabs cannot change fields. LLM-based dictation
does not remove any command wrapper or rewrite the utterance.

`EnterTextToApplication` checks focus again after typing and only then presses
Enter. A focus change, typing failure, or cancellation prevents that keypress. If text
was already typed, the outcome is `interrupted`, preserving partial-delivery
uncertainty in history. Both processors share the desktop recovery queue, held
through completion of the Enter keypress.
This processor has no LLM instruction: only the explicit “enter” prefix selects it.

The focus check identifies a window, not a browser tab or an individual text
field. A focus change during keyboard delivery cannot be made atomic with
`wtype`. The screenshot is the visible window rectangle clipped to its monitor;
overlapping surfaces may appear. Intent classification can still make mistakes.
There is no sandboxing in v1.

## Tests

```sh
npm run check
npm test
npm run asr:test
npm run asr:bench  # Public fixture only; no desktop or microphone
npm run test:live
npm run test:desktop
# Desktop shortcut checks only, without microphone, ASR, or LLM:
npm run test:live -- --prefix-only
```

Automated tests cover real Pi HTTP payloads with a local mock endpoint, strict
intent parsing, subscription/dispatch, prefix matching and LLM bypass, explicit
Enter sequencing, focus-change suppression, PCM boundaries,
actual Silero inference on silence, VAD segmentation, capture races, bounded
queues, and cancellation. They do not capture the desktop or type anything.

The opt-in live test opens two disposable text fields, records approximately one
second of microphone audio, transcribes the public speech fixture, captures a
real window, calls the configured model, checks actual keyboard delivery, and
changes focus after inference to verify that neither field gets additional
text. It also verifies actual prefix typing and Enter, including focus changes
before delivery and between typing and Enter. It closes its windows and restores
the previous window afterward. `--prefix-only` runs just these shortcut checks.

The desktop test requires the Omarchy adapter to be installed and Companion to
be stopped. It uses disposable GTK fields and a temporary SQLite database to
check the shortcut, selection, cancellation, recovery, and pause connection.
It briefly enables symbol matching for wtype's synthetic keymap and restores
that setting and the previous focus afterward. It opens no microphone and makes
no model request.

## Code style

Use blank lines between logical steps, one statement per line, and braces around
control-flow bodies. Keep comments close to the code they explain: describe a
module's role, the data it accepts and returns, units, ownership, and why timing
or cleanup matters. Keep one processor per file and preserve prompt wording when
changing layout.

Prettier handles indentation, wrapping, and quote style. It preserves the blank
lines that separate steps:

```sh
npm run format
npm run format:check
```

## Detailed behavior and configuration reference

The complete behavior notes that used to live in the README: exact start modes,
prefix matching rules, conversation limits, panel details, sounds, history
storage, recording formats, prerequisites and `companion.config.json`. The
user-facing summary is [using Companion](using-companion.md).

### Run

After completing the [installation checkpoints](installation.md), run from
a terminal inside the Hyprland desktop session. **The following starts microphone
capture and types detected dictation into the active application.** Select the
intended text field first; add `--paused` to start with microphone capture off.
Even paused startup takes and discards one active-window screenshot, so display
harmless content before launching. Ctrl+C stops capture, inference, and child processes.

```sh
cd ~/Work/companion
npm start
```

To start Companion paused after each desktop login instead, see
[Start Companion after login](installation.md#8-start-companion-after-login-optional).

- **“insert hello”** types `hello`, without pressing Enter.
- **“enter hello”** types `hello`, then presses Enter.
- **“quick question, what does this error mean?”** sends the question and captured
  window to a headless Pi agent and opens its answer in a new panel tab.
- Other utterances go through the LLM as before; detected dictation never presses Enter.

These prefixes bypass the intent LLM. Matching is case-insensitive and accepts punctuation
after the command, such as “Insert, hello”. It matches whole prefixes: “entering”
does not trigger “enter”. A command with no following text does nothing.

To observe without dispatched typing, Enter, or agent starts, use preview.
**It still captures, can call the classifier, and retains desktop history/audio/PNG.**
See the [data and stopping guidance](installation.md#make-the-user-aware-of-what-companion-does).

```sh
npm start -- --preview
```

The CLI prints each stage: listening, speech detection, screenshot, queued audio,
transcription, frame assembly, intent, processor dispatch, delivery or skip, and
elapsed time. Concurrent capture messages carry frame IDs.

Other input modes use the same router and processors:

```sh
npm start -- --preview --text "Please type hello into this document."
npm start -- --preview --text "insert Hello world"
npm start -- --preview --text "enter Hello world"
npm start -- --preview --wav test/fixtures/speech.wav
npm start -- --preview --seconds 10
```

`--text` and `--wav` still capture the currently focused application. `--wav`
accepts formats FFmpeg can decode. `--device NODE_NAME` selects a PipeWire source.
Run `npm start -- --help` for all flags.

With the Omarchy adapter installed, microphone listening automatically pauses when
any media player reports **Playing** through [MPRIS](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html#Property:PlaybackStatus).
The bar and Activity tab show **Paused for media**. Pausing, stopping, or closing
the last playing player resumes listening, unless you paused Companion manually.
**Super+Alt+P** or the Listening switch can explicitly resume during playback;
automatic pausing rearms after playback stops. Pending dictation is cancelled on
pause; existing agent conversations continue.

This uses reported player state only, without monitoring audio. Players without
MPRIS support are ignored; muted playback still counts if its state is Playing.
It requires the running Omarchy adapter and does not apply to `--no-desktop`,
`--text`, or `--wav`. Update both Companion and its adapter to enable it.

### Quick questions

Agents can name their conversations with **`companion_name_session`**. Its
instructions ask for a short topic name early in the first turn, preferably
with an emoji (for example, **🐛 Login fix**). Companion reads the name from Pi's
native session state and retains it when the conversation is saved and reopened.

`START_CODING_AGENT_SESSION` is also available to the intent recognizer, for
questions addressed to the computer's AI assistant. Each invocation starts an
independent agent session in `~/companion/agents` using the configured coding
harness: Pi by default, or Claude Code when `codingDefaultHarness` is
`claude-code`. **“new session …”** bypasses intent inference and does the same;
on Pi it uses the coding model (Astra by default). It replaces the old
“new coding agent” shortcut. **“new claude session …”** always starts Claude
Code with the configured Claude model, and **“new pi session …”** always
starts Pi with the coding model. A Claude Code conversation keeps the effort
it started with; its footer can switch the next turn to another Claude model in
the same Claude history. The "Start a coding session" card under Activity →
Intentions chooses the backend and model for new sessions; existing sessions keep
theirs. Messages you type in Companion may be up to 8000 characters. **“quick question …”** is a separate, prefix-only
`QUICK_QUESTION` processor using local Qwen through the same Pi backend. All of
them send the captured screenshot and utterance and open an ordinary
conversation tab.

When an agent conversation is selected in the visible sidebar,
`CONTINUE_OPEN_AGENT_CONVERSATION` joins the classifier's choices. With its input
field focused, the instruction defaults speech to that conversation unless the
context strongly suggests another intention. Without input focus, the classifier
uses the conversation context to judge whether the utterance is a follow-up;
an open sidebar alone does not imply continuation. **“continue session …”**
bypasses classification and sends directly to the visible, selected conversation,
even when its input field is not focused.
Both paths send the speech as a follow-up, without typing into the composer or
capturing another attachment. **“insert …”** and **“enter …”** send keyboard input
to the focused field, including the Companion composer when it owns focus.

The selected conversation and focus are captured at speech end, before ASR.
Switching tabs, closing the panel/session, changing composer focus, or losing the
UI connection before dispatch skips the continuation instead of redirecting it.
An explicit continuation shortcut without an open conversation is also skipped.
The prefix is now **“continue session …”**, replacing “message coding agent …”.

Say **“close session”** to close the visibly selected conversation, even when its
textbox is unfocused. This explicit-only command stops its current turn, cancels
queued follow-ups, and saves the conversation in Previous sessions. It requires
no text after the command and rechecks the captured selection before closing;
a hidden panel, Activity, Previous sessions or a changed target cannot close a tab.

Spoken and typed follow-ups received during an answer queue in that conversation
and run in order after the current turn finishes. Message prefixes without a
following message do nothing; `close session` is a standalone command.

Pi 0.85.1 or newer must be installed and authenticated. Companion uses real
`pi --mode rpc` processes: questions include the captured PNG and window identity;
answers and tool activity stream back while microphone processing continues.
The backend verifies the selected model and thinking level before sending the
question, and reports startup, model, image, and tool-run failures in the tab.

The first question creates `~/companion/agents/companion-agent.json` if absent:

```json
{
  "executable": "pi",
  "model": "openai-codex/gpt-6-astra",
  "thinking": "medium",
  "quickQuestion": {
    "model": "pillar-vllm/qwen3.8-128k",
    "thinking": "off"
  }
}
```

The top-level model/thinking settings apply to coding sessions; `quickQuestion`
overrides model/thinking for quick questions. The executable is shared. The
conversation keeps its profile for spoken, typed and queued follow-ups, including
after reopening; configuration edits take effect on its next turn. Older saved
conversations remain coding sessions. Existing three-field configuration files
still work and use Qwen defaults for quick questions until an override is added.
The Qwen provider must already be registered in Pi's `~/.pi/agent/models.json`;
this installation uses the same Qwen endpoint as intent detection. An unavailable
local model reports an error instead of silently falling back to Astra.

For a single conversation, use the **Model** and **Effort** selectors at the bottom
of its panel. They apply from its next turn and survive reopening. Each profile-default
option clears only that selector's override. The model menu initially shows Pi's
pinned models; **Show all models** reveals the remaining available models. Effort
choices follow the selected model's capabilities. Pi adjusts an inherited level
when necessary (for example `off` becomes `minimal` for Astra).

Edit this file to change the next turn's model or executable. Pi calls the
Codex provider `openai-codex`. An absolute executable path can pin an installed
Pi release and avoid version-manager wrapper behavior. Existing files are never
overwritten. Companion passes these settings explicitly; project trust is not
needed just to load this configuration. Pi otherwise uses its normal credentials,
tools, global resources, and project trust policy.

New questions select their own vertical tab and open the panel. User text stays
literal; assistant answers render as Markdown. Click a tool bubble to expand
its arguments and output. Text updates are batched at up to 25 frames/second.
Answers use 16px Adwaita Sans when available (with other system sans-serif
fallbacks), spaced paragraphs and headings, and smaller monospace code in shaded
frames. With the conversation focused, **Ctrl++** (or **Ctrl+=**) and **Ctrl+-**
zoom the transcript and composer from 80% to 200%; **Ctrl+0** resets to 100%.
Zoom follows you between tabs for the lifetime of the panel. Links remain
clickable; raw HTML is literal text and Markdown images display their alt text.
The Quickshell panel starts at 600 logical pixels wide (capped to the screen).
The [standalone Qt host](../native/window/README.md) instead provides a remembered
ordinary window, Sidebar and Dock, with embedded widgets using filtered 2×
rendering by default. Switching tabs keeps the host's size. Scrolling
up stops following the stream until you return to the bottom. Conversation wheel
and touchpad scrolling use a 3× multiplier, confined to the transcript area.

Agents can also publish reusable **interactive widgets** from the user widget
library, `~/companion/widget-library` by default (see
[library location](../widget-library/README.md#library-location)): compact diagrams, comparisons,
charts, to-do lists and WebGL views. The agent supplies props or calls a declared
action instead of repeating the implementation. A hover arrow opens a dedicated
Chromium window sharing the same saved state. Widgets may be pinned above the
chat (normally 25% of sidebar height); at 100%, a host-owned **Back to chat**
control restores the transcript and its unsent draft. Chromium and Bubblewrap
are required for visuals; ordinary text conversations remain available.

Activity has a text box pinned at the bottom. **Enter** or **Send** submits what
you would otherwise say; **Shift+Enter** adds a line. **Super+Alt+D** focuses this
input on Activity and the conversation input on agent tabs. Text restores focus
to your previous application, captures its screenshot, and joins the same intent
and shortcut queue as speech, with the same history and feedback. It works while
the microphone is paused. The draft stays until admission is confirmed; a lost
connection never automatically resends it. Text input needs the updated listener,
UI and Omarchy adapter. No audio recording is created for typed input.

Activity shows floating labels for available voice prefixes. In Intentions,
**Intent** cards use the accent color and **Shortcut** cards use amber. Each card
is independently clickable: turning off recognition leaves that processor's
explicit shortcut usable, and turning off its shortcut leaves recognition usable.
Off and context-unavailable routes appear grey, with a written state beneath the
label. `IGNORE` always remains available as the required no-action fallback.
**Clean up transcriptions** (above the cards, default off) sends the text routes
a cleaned-up version of what you said. History keeps the raw transcript next to
the cleaned text; see [transcription cleanup](transcription-cleanup.md).
Switches persist in `~/companion/disabled-intents.json`; existing disabled intents
migrate as disabled in both modes. A disabled prefix remains reserved and is
skipped, never reinterpreted as dictation or another command. Conversation-owned
choices and Stop keep their existing availability rules.

Disabling a route invalidates its pending detection/delivery only, including an
off/on cycle; it does not interrupt the other route or an independent agent turn
that already accepted a question. An updated UI with an older listener shows a
restart hint instead of offering controls the listener cannot honor.

Hover a session tab to read its complete title. Hovering its close button instead
shows the close explanation; the compact tab layout is unchanged.

A compact Activity visualization stays above conversations and Previous sessions
while their contents scroll. It shows the same microphone state, rising phrase,
and detected intent as the Activity tab. Use its top-right arrow to collapse it
to a slim status row or expand it again; the setting follows you between tabs
for the lifetime of the panel.

**Stop** cancels the selected agent. Right-click a question tab, use its hover
**×**, or choose **Close session** to stop it and move it to **Previous sessions**
at the bottom of the tab rail. Pick a saved conversation there to reopen it;
reopening does not run the model. Closing the panel merely hides it. Pausing the microphone leaves accepted
agent questions running; stopping Companion cancels its agents and the tool
subprocesses in their owned process groups. Supplied-text/file modes wait for accepted questions to
finish. CLI logs include completed answers when no panel is attached.

Each conversation tab has a composer. Click it to type a follow-up, press **Enter** to send,
or **Shift+Enter** for a newline. **Super+Alt+D** opens the panel and focuses the
visible Activity or conversation input; press it again to return to your previous
application. A conversation follow-up resumes the same Pi conversation,
including the original screenshot; it does not capture another screenshot.
While the panel has keyboard focus, **Alt+1** through **Alt+9** select Q1–Q9 in
the current tab order and focus that conversation's composer, keeping its draft.
**Super+Alt+0** (or **Alt+0**) selects Activity; **Super+Alt+Tab** cycles
Activity → conversations → Activity. These shortcuts work only while Companion
has keyboard focus. Activity keeps its own visible text input and tab navigation; it never focuses
a hidden agent composer. Outside Companion, Super+Alt+Tab retains Omarchy's group navigation.
Select message text and press **Ctrl+C** to copy the selection. Hover over a
message for its **Copy** button, which copies the whole message (including the
original Markdown for agent answers) without changing your selection or draft.
**Record**, beside Send, dictates into the text box instead of typing: speech is
transcribed in short chunks and added to the end of the draft, where you can
edit it. Nothing is sent and no voice commands run until you press **Send**.
**Stop recording** keeps your last words; Send and Close wait while it shows
**Finishing transcription…**. Recording also stops when you leave the
conversation, pause listening, or the draft reaches 8,000 characters; a note
under the text box says why, and whether any speech may be missing. It works
while listening is paused, without changing that setting; the Companion bar
icon and status then show **Recording into a text box** while the microphone is on.
While Pi works, **Enter** or **Queue** accepts a follow-up for the next turn.
Waiting messages show **queued**. Each conversation permits eight waiting messages;
they run one at a time, without interrupting its answer or taking another agent slot.
Stop, closing the tab, shutdown, or a failed turn cancels the waiting messages and
marks them **not sent**. Reopening a conversation never replays them. Accepted
messages survive microphone pause and switching tabs; they belong to the original
conversation. The queue is in memory; normal transcript saves record it for display,
but a crash can lose messages accepted since the last save.
Drafts remain separate per tab and clear only after the backend confirms receipt.
Closing and reopening a tab preserves its draft while the UI remains running.
With the composer focused, **“insert …”** dictates into it and **“enter …”**
dictates and presses Enter. If the agent is already answering, Enter queues
the follow-up. These explicit prefixes
avoid inferring a new question. The history outcome `sent` confirms keyboard
delivery, not acceptance of a Pi turn; its application field identifies the
ordinary window captured with the utterance, not the overlaid composer.
As elsewhere, dictation requires a visible ordinary application for screen capture.

Activity and conversation tabs accept normal compositor-directed keyboard focus.
Opening the panel alone does not take focus from the application.
Focus changes between a composer and the underlying
application invalidate pending keyboard delivery, even when Hyprland's
`activewindow` still names that same underlying window. Enter rechecks this guard
after typing. Offscreen checks cover these guards; the native host's
[isolated layer-focus regression](../native/window/README.md#build-without-activating)
also exercises Dock/Sidebar typing and focus restoration. This does not establish
every live desktop, monitor or widget-popup interaction.

Click the screenshot in the first question to open a separate, themed viewer on
that display. It starts fitted to the available space. Scroll or use **+ / −** to
zoom, drag to pan, and choose **Fit** (or **0**) to reset. **Escape**, **×**, or a
click outside the image dismisses it.

Pi persists the model conversation in its normal session storage. Companion saves
its display transcript and original PNG separately in
`~/companion/agents/.companion-sessions` (private directory and files). Saved
conversations appear in Previous sessions after a restart; tabs do not reopen
automatically. This history only includes Companion's own saved conversations,
not unrelated Pi sessions. Missing screenshots leave the text readable. Sessions
from before this store existed are not imported and have no recoverable panel
attachment. History has no automatic deletion. Normal Stop/Close/shutdown saves
the partial answer; a hard crash may lose the current turn's unsaved output, but
its saved question is recovered as stopped. A missing Pi transcript still permits
viewing history, but continuing it fails visibly instead of starting without context.
This first version permits four simultaneous
questions and sixteen tabs, with a 256 KiB/200-message display limit per session.
Tool output is clipped to 16 KiB in a bubble. Interactive Pi extension dialogs
are cancelled with a visible explanation rather than left waiting for a terminal.
Per-session speech routing remains for the next iteration.

### Desktop integration and history

Companion plays a short cue when an utterance is accepted for processing.
Destination feedback follows actual delivery or acceptance:

- **Application:** the existing ascending two-note cue after typing completes.
- **Existing agent conversation:** a higher descending two-note cue when a
  follow-up or choice is accepted, including a message queued behind a running turn.
- **New agent session:** a three-note rising cue, including local quick questions.

Ignored speech retains its lower descending cue. Failed/skipped actions and
closing a session do not play a delivery cue.
A distinct quiet two-note chime follows each successful agent turn, including
queued follow-ups. Stopped/failed turns and reopening old conversations stay silent.
Use `--no-sounds` to start with these cues muted, or toggle them from the top bar
microphone menu during a session. Preview mode is silent.

The [standalone Qt window](../native/window/README.md) reuses the conversation UI
with embedded Chromium and Window/Sidebar/Dock presentation, using standard Qt
packages. It is an opt-in development candidate; see its validation limits and
coordinated activation instructions before trying it on the desktop.

The optional [Omarchy adapter](../integrations/omarchy/README.md) adds:

- **Super+Alt+V**: hold to see recent utterances, select with **Up/Down**, and
  release to paste. A quick tap pastes the latest utterance; **Escape** cancels.
- **Super+Alt+C**: toggle the panel. **Super+Alt+D**: toggle focus between the
  selected conversation's input and the previous application.
- **Super+Alt+P**: pause or resume listening.
- A microphone control in the top bar: click for separate listening and sound
  effects switches. Mute the bleeps while keeping Companion active. Pause closes
  microphone capture, cancels pending work, and discards partial speech.

Install the adapter once from this checkout with `npm run omarchy:install`, then
run `npm start`. Stop any older listener first. `--paused` starts with capture
off. Explicit history recovery still works while listening is paused.

All nonempty transcripts are retained in SQLite at
`~/companion/utterances.sqlite`. Records
include the application/window observed at speech end, recognized intent, and
actual outcome. A separate `paste_events` table links manual recovery attempts
and their outcomes to the original utterance, preserving the original decision
for later evaluation. The picker displays the latest 100; older records remain
in the database. Untranscribed audio, including overload drops, has no transcript
to retain. The exact PNG captured for each transcribed utterance is saved as
`~/companion/data/YYYY-MM-DD/screenshots/<id>.png`, using the utterance UUID and
the local date when speech ended. The filename's UUID links to `utterances.id`;
no file paths are stored in SQLite. Old records and failed captures have no screenshot.

Speech audio for each saved transcript is retained alongside its screenshot at
`~/companion/data/YYYY-MM-DD/audio/<id>.wav`, using the same utterance UUID.
The WAV is uncompressed 16 kHz mono PCM16, encoded exactly like the input to
transcription. Audio is saved even if screen capture or the later action fails,
and for ignored speech. Old records and `--text` input have no audio file.
Worker failures and overload drops are not retained. Eligible final empty ASR
results are saved separately as `~/companion/asr-empty/YYYY-MM-DD/<clip-uuid>/audio.wav`
and `metadata.json`; they have no transcript-history row and are not removed by
Activity deletion. See [recording details](../src/desktop/README.md).

Say **“label previous correct”** or **“label previous incorrect”** to give feedback
on the preceding utterance's selected intent. These standalone shortcuts bypass
the LLM and never type text. A separate `intent_feedback` table contains only
explicitly labeled examples: `id` (the utterance UUID), `correct` (0 or 1),
`recognized_intent`, and nullable `actual_intent`. Correct feedback fills in the
recognized intent as the actual intent; incorrect feedback leaves it unknown.
Repeated labeling replaces the same example's feedback, skipping previous
labeling commands. An utterance with no recognized intent cannot be labeled by
these shortcuts. Preview mode logs the command without writing feedback.

On the first desktop-enabled start, Companion imports an existing database and
intent preferences from the former XDG state location into `~/companion`. The
original files remain as a fallback; an existing destination database is never
overwritten. Agent conversations continue to live under `~/companion/agents`.

The Omarchy code lives entirely in `integrations/omarchy`. The generic desktop
service exposes a private local socket; its [protocol and database documentation](../src/desktop/README.md)
describe how other adapters can connect. `--no-desktop` disables that service,
including storage and sounds, for isolated CLI use.

### Prerequisites and configuration

For acquisition and ordered setup commands, use the [installation guide](installation.md).
The defaults below describe existing source configuration, not a clean-machine installer.

- Node.js 22.19 or newer.
- Hyprland, `hyprctl`, `grim`, `pw-record`, `pw-play`, `wtype`, and util-linux
  `flock` on PATH.
- Rust/Cargo 1.88+ and a C/C++ build toolchain to build the bundled ASR helper
  (`npm run asr:build`). The build downloads its pinned dependencies and CPU ONNX
  Runtime. See [persistent ASR setup](../native/asr-worker/README.md).
- The existing Parakeet TDT model at
  `~/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8`.
  Companion does not download or replace model files.
- A vision-capable Qwen endpoint. Defaults:
  `http://127.0.0.1:18081/v1`, model `qwen3.8-128k`.
- FFmpeg for file input. The live test additionally needs `/usr/bin/python`,
  PyGObject and GTK4, and uses Hyprland's 0.55+ Lua dispatch syntax.

The bundled Silero VAD runs locally with ONNX Runtime. Transcription is local.
For utterances without a matching prefix, the configured model endpoint receives
the utterance, window identity, and PNG. Prefixes bypass classification; agent-start/quick-question prefixes still call
their configured model, and optional transcription cleanup can call the classifier
model for text-delivery prefixes.
With desktop history enabled, screenshots and speech audio for saved transcripts
are retained under `~/companion/data`. Transcription itself uses private pipes and
creates no temporary audio files. Eligible empty ASR results are also saved as
diagnostic audio under `~/companion/asr-empty`. `--no-desktop` disables these
desktop stores; it does not disable capture, model requests, typing, or independent
agent conversation storage. See [retention and deletion](installation.md#storage-deletion-and-egress).

Optionally copy `companion.config.example.json` to `companion.config.json`.
Supported configuration is defined in [src/config.ts](../src/config.ts):
`llm: { baseUrl, model, timeoutMs, requestProfile }`, `asr: { workerBinary, modelDir, timeoutMs }`,
and `vadModel`. Omitted values use defaults. `asr.workerBinary` defaults to this
checkout's `native/asr-worker/target/release/companion-asr-worker`. Remove any old
`asr.binary` Voxtype override and run `npm run asr:build`; the old key is rejected
with migration instructions. Keep `modelDir` unchanged. `timeoutMs` bounds startup
and each transcription (including recovery startup), default 90 seconds.
`--config path` selects another file;
`COMPANION_LLM_API_KEY` supplies endpoint authentication. Classifier requests
always switch model reasoning off; `llm.requestProfile` says how the endpoint
expects that: `local-qwen` (default, a local vLLM/Qwen server), `groq` or
`openrouter`. A hosted profile sends every classified utterance's transcript,
screenshot and window details to that provider; see
[installation step 4](installation.md#4-set-up-an-image-capable-intent-and-agent-endpoint).

### Local external coding agents

Companion can optionally expose session list/start/reopen/close/send/draft to local
processes running as your Linux user. Enable `--external-sessions` on the listener
and use `bin/companion-session --help` from its checkout. Access is off by default,
uses a private Unix socket rather than network exposure, and identifies caller
labels as unverified. See the [external session API guide](../src/agents/external/README.md)
for discovery, commands, retries and the same-user trust boundary.
