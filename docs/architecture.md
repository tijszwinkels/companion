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

| Module                                                         | Input                                 | Output                                |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
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
and a 30-second segment limit. Audio startup loads one persistent
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
