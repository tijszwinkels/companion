# Companion

A CLI that listens, captures the active application when speech ends, detects
one intent, and routes the sensor frame to a subscribed processor. Explicit
command prefixes skip intent inference.
The previous experiment lives in `../companion_spike`.

## Run

From a terminal inside the Hyprland desktop session:

```sh
cd ~/Work/companion
npm ci
npm start
```

This starts microphone capture and **types detected dictation into the active
application**. Select the intended text field and speak. Ctrl+C stops capture,
inference, and child processes.

- **“insert hello”** types `hello`, without pressing Enter.
- **“enter hello”** types `hello`, then presses Enter.
- Other utterances go through the LLM as before; detected dictation never presses Enter.

Both commands bypass the LLM. Matching is case-insensitive and accepts punctuation
after the command, such as “Insert, hello”. It matches whole prefixes: “entering”
does not trigger “enter”. A command with no following text does nothing.

To observe without typing or pressing Enter:

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

## Prerequisites and configuration

- Node.js 22.19 or newer.
- Hyprland, `hyprctl`, `grim`, `pw-record`, and `wtype` on PATH.
- Voxtype 1.0.1 at `~/.local/bin/voxtype` and Parakeet at
  `~/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8`.
- A vision-capable Qwen endpoint. Defaults match the spike:
  `http://127.0.0.1:18081/v1`, model `qwen3.8-128k`.
- FFmpeg for file input. The live test additionally needs `/usr/bin/python`,
  PyGObject and GTK4, and uses Hyprland's 0.55+ Lua dispatch syntax.

The bundled Silero VAD runs locally with ONNX Runtime. Transcription is local.
For utterances without a matching prefix, the configured model endpoint receives
the utterance, window identity, and PNG. Prefix commands make no model request.
Screenshots stay in memory; temporary ASR files are removed after each call.

Optionally copy `companion.config.example.json` to `companion.config.json`.
Supported configuration is defined in [src/config.ts](src/config.ts):
`llm: { baseUrl, model, timeoutMs }`, `asr: { binary, modelDir, timeoutMs }`,
and `vadModel`. Omitted values use defaults. `--config path` selects another file;
`COMPANION_LLM_API_KEY` supplies endpoint authentication. The adapter explicitly
disables Qwen thinking using `chat_template_kwargs.enable_thinking = false`.

## Data flow and review order

The directories follow the responsibilities of the modules:

```text
src/
  cli.ts                         Start, connect, and stop the modules
  config.ts                      Read and validate configuration
  core/
    frame.ts                     Shared types and data contracts
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
      transcriber.ts             Local speech-to-text through Voxtype
    screen/
      capture.ts                 Read and capture the active window
  system/
    command.ts                   Run and cancel external commands
    text-input.ts                Shared focus checks and keyboard delivery
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

| Module | Input | Output |
| --- | --- | --- |
| [Audio capture](src/sensors/audio/capture.ts) | PipeWire / FFmpeg PCM bytes | `Float32Array` frames |
| [Voice activity detection](src/sensors/audio/vad.ts) | One audio frame | Speech probability |
| [Segmentation](src/sensors/audio/segmenter.ts) | Probability + audio | `Segment` containing one utterance |
| [Transcription](src/sensors/audio/transcriber.ts) | Segment samples | Transcript `string` |
| [Screen capture](src/sensors/screen/capture.ts) | Active Hyprland window | `Screenshot` |
| [Pipeline](src/core/pipeline.ts) | Audio segment + capture | `UserSensorFrame` |
| [Router](src/core/router.ts) | Frame + processor subscriptions | Dispatch to one processor |
| [Intent detector](src/core/intent-detector.ts) | Frame + registered intents | Validated intent-name `string` |
| [Text processor](src/processors/send-text-to-application.ts) | Frame, with prefix removed if matched | Type text if focus matches |
| [Enter processor](src/processors/enter-text-to-application.ts) | Frame with `enter` removed | Type text, recheck focus, press Enter |
| [Ignore processor](src/processors/ignore.ts) | Original frame | Log that no action is needed |

Start reviewing with the shared contracts in [frame.ts](src/core/frame.ts), then the
router, detector, and processors. [cli.ts](src/cli.ts) wires the components.

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
contains one user message with text and image together. Each frame gets a fresh
agent with thinking off, no tools, no previous frames, no retries, and a 32-token
output limit. Only an exact registered name is accepted. Invalid, truncated,
failed, or timed-out responses are logged as errors and never dispatched.

Audio/VAD runs independently of the sequential ASR/routing worker. Capture
starts at speech end, before ASR, including when a preceding frame is still being
processed. The worker holds one active and up to two queued utterances; additional
utterances are explicitly logged as dropped. Prefix commands use this same queue
and preserve speech order; they do not overtake an earlier LLM request. File input
waits for each result.
Silero uses the spike's thresholds: 400 ms minimum speech, 800 ms ending silence,
256 ms preroll, and a 30-second segment limit. Voxtype loads Parakeet per utterance,
as in the spike; it is a measurable part of latency.

## Text delivery

Both text processors use the same delivery helper to re-read the active window before invoking
`wtype`. If the window address differs from the screenshot's address, it logs a
skip and types nothing. It never restores focus. ASR text is delivered unchanged
except that matched prefixes are removed and control characters become spaces,
so newlines cannot press Enter and tabs cannot change fields. LLM-based dictation
does not remove any command wrapper or rewrite the utterance.

`EnterTextToApplication` checks focus again after typing and only then presses
Enter. A focus change, typing failure, or cancellation prevents that keypress.
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
npm run test:live
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
