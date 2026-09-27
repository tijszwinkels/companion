# Inspecting Companion modules

Modules remain ordinary TypeScript objects. Constructors connect dependencies;
processors register with the router through `subscribe(router)`. The inspector
reads those actual objects and registrations to create a serializable `Graph`.
There is no port binding layer, scheduler, or separate list of diagram edges.

## Wiring

This minimal example shows named dependencies from [the CLI](../src/cli.ts).
The CLI registers additional agent, continuation, close, navigation and feedback processors;
the example is not the complete current intent list.

```ts
const detector = new IntentDetector(config.llm);
const cleaner = new FixedRouteCleaner(config.llm);
const router = new UserSensorRouter({ detector, cleaner }, log, activity, 'router', cleanup);

new SendTextToApplication(log, preview, command, activity).subscribe(router);
new EnterTextToApplication(log, preview, command, activity).subscribe(router);
new Ignore(log, activity).subscribe(router);

const screen = new ActiveWindowSensor(command);
const transcriber = new Transcriber(config.asr);

const pipeline = new SensorPipeline(
  { screen, transcriber, router },
  log,
  controller.signal,
  activity,
);

// Read the same references the modules use for processing.
const graph = createGraph(pipeline);
```

`subscribe(router)` calls `router.register(this)`. It registers that processor
as a possible destination: messages go from the router into the selected
processor. Registration does not deliver a message, and the router does not
broadcast frames to every subscriber.

The prefix-only `GoToSession` processor reserves `go to session` and has no LLM
instruction. It parses one exact numeral or cardinal number word from 1–16, then calls
`Activity.selectSession(context, index)`. The desktop runtime validates the
captured `InteractionContext.agentNavigation` client/token/order against current
state before sending a targeted UI selection event. Invalid, disabled, hidden,
out-of-range and stale commands are consumed instead of falling through to
inference or conversation text. This uses the normal processor registration,
shortcut preferences and sensor-frame capture path.

The router still invokes its detector through an ordinary method call:

```ts
const name = await this.dependencies.detector.detect(frame, intents, signal);
```

With transcription cleanup on (`cleanup.enabled`, read once per utterance), the
router calls `detector.detectWithCleanup(...)` instead, which returns the intent
plus cleaned text from one request. For an explicit text-route shortcut it calls
`this.dependencies.cleaner.clean(route, text, frame, signal)`. That method
returns only text (cleaned or raw) and never a route. Off, neither is used. See
[transcription cleanup](transcription-cleanup.md).

The pipeline likewise calls `this.dependencies.screen.capture(...)`,
`this.dependencies.transcriber.transcribe(...)`, and
`this.dependencies.router.route(...)`. The inspector follows these same named
properties. `ActiveWindowSensor` gives the existing capture function an object
identity; the capture algorithm is unchanged.

`SensorPipeline.submit(samples, signal, leadIn?, trailingSilenceMs?)` and
`submitText(text, signal, target?)` share one bounded FIFO: one active job and
two waiting jobs. Speech segments are provisional attempts. The listener passes
each segment's measured trailing silence (`Segment.trailingSilenceMs`; direct
callers omit it, meaning none). It also calls `speechResumed()` when a VAD
candidate opens and `speechDiscarded(burstTrailingSilenceMs?)` when it closes
without a segment (with its measured silence) or listening ends (without); a
`submit` that follows a hold merges the raw audio into a new attempt that
replaces the held one in place. The router receives that attempt as an optional
third argument, `route(frame, signal, commitment?)`, and awaits
`commitment.commit(...)` immediately before dispatching or skipping. A spoken
decision commits at `max(speech end + 800 ms, decision ready)`. Typed input and
direct callers pass no commitment. The pipeline's optional sixth constructor
argument is the monotonic `CommitClock` for these deadlines; tests pass a
controlled clock. See [speech timing](speech-timing.md). Both capture the
screen and interaction context on admission; only audio invokes transcription.
Typed input accepts nonblank text up to 4000 UTF-16 code units. An optional target
address must match the captured window. Admission returns `false` for cancellation
or a full queue; accepted work reports its later processing outcome separately.
The desktop's `submit-utterance` action uses this path after restoring application
focus. It records the utterance and PNG, with no WAV. See the
[desktop contract](../src/desktop/README.md) for capabilities and acknowledgements.

At each supersession the pipeline calls `Activity.attemptSuperseded(id)`. When a
continued utterance's final attempt settles, the pipeline calls
`Activity.continuationSettled(finalId, supersededIds)` just before
`finished(finalId)`. The desktop runtime then keeps one record per utterance;
see [final-only retention](speech-timing.md#final-only-retention).
`audioCaptured` resolves after the WAV is published; the runtime records that
per frame to decide ownership. `Transcript.source` is `earlier-attempt` when the
text is an earlier attempt's (D2 fallback or a recovered failed final attempt),
and `audio-only` (with an empty `utterance`) for a failed continued utterance
without any usable text.

Confirmed empty ASR results (after the transcriber's single padded retry, when
eligible) that meet the existing duration/energy floors call
`Activity.emptyAudioCaptured` when available. This observer saves a separate
WAV/metadata pair and returns its UUID for the job log. The pipeline awaits it
before clearing samples; empty results still skip transcript history and routing.
See the desktop contract for thresholds, storage paths and retention.

## Contextual intent instructions

Permanent processors register with `router.register(this)`. Their `instruction`
is the default text for the detector's `Name`/`Instruction` entry. An optional
`availableForInference(context)` gates eligibility; an optional
`instructionForInference(context): string` overrides the wording for an eligible
observation. An override requires a nonblank default instruction and must also
return nonblank text. Existing processors need no changes.

```ts
instructionForInference(context: IntentContext): string {
  if (context.interaction?.agentComposerFocused) {
    return this.instruction;
  }

  return unfocusedInstruction;
}
```

The router resolves this text once from the captured frame, after enabled and
availability checks. It does not mutate the registered default, invoke the
override during UI inventory reads, or use it for explicit-prefix dispatch.
Intent identity, toggles and cancellation stay with the registered processor.

Dynamic choices still use `router.registerScoped(source)`, where a source accepts
`(context, reservedPrefixes)` and returns ephemeral `ScopedIntent` objects with
their own `name`, optional `instruction`, optional `exactUtterance`, and guarded
`process(frame, signal)`. Scoped strings can already be built from context; they
do not need the permanent-processor override method.

The context includes the captured sidebar selection and focus. At speech end,
the desktop also copies bounded selected-conversation excerpts into
`interaction.agentConversation`. The detector serializes those as JSON data in
its user message alongside the utterance, with a separate image content part.
Processor instructions remain system text; history is not interpolated into them.

## The inspection contract

[module.ts](../src/core/module.ts) contains the complete shared interface:

```ts
interface InspectableModule {
  readonly id: string;
  readonly label: string;
  readonly dependencies: Readonly<Record<string, InspectableModule>>;
  readonly processors?: ReadonlyMap<string, RegisteredProcessor>;
}

interface RegisteredProcessor {
  readonly processor: InspectableModule;
  readonly prefixes: readonly string[];
  readonly llmEligible: boolean;
}
```

`id` identifies an instance within one application. `label` is for display and
need not be unique. Built-in modules have useful default IDs; their constructors
accept an optional final ID argument when multiple instances of a type are needed.
Two references to one object produce one node. Two distinct objects with the
same ID produce an error instead of being silently merged.

An object with no inspectable module dependencies exposes `{}`. Module behavior
retains its existing interface: `Detector.detect`, `ScreenSensor.capture`,
`SpeechTranscriber.transcribe`, and `UserSensorProcessor.process`. Their request,
reply, and cancellation types remain TypeScript types rather than runtime ports.

The router's `processors` getter produces an inspection snapshot from its private
registry and validated prefix table. It returns the actual processor references,
the normalized prefixes used for dispatch, and eligibility derived from the same
instruction field used for LLM choices. This small registration view avoids
exposing a mutable registry, and correctly reflects registration even if a caller
later changes its original prefix array. Generating a new graph sees subsequent
registrations; changing an exported graph does not change routing.

## What `Graph` contains

[graph.ts](../src/core/graph.ts) defines `Graph`, `GraphNode`, `GraphEdge`, and
`createGraph(root)`. A graph is an ordinary object with two arrays:

```ts
interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

Nodes contain IDs and labels. Edges contain source and destination IDs, a label,
and a kind (`dependency` or `route`). Route edges also include their prefix list
and whether the LLM can select them. For example, the existing Enter registration
produces this edge:

```json
{
  "from": "router",
  "to": "enter-text",
  "label": "ENTER_TEXT_TO_APPLICATION",
  "kind": "route",
  "selection": {
    "prefixes": ["enter"],
    "llmEligible": false
  }
}
```

`createGraph` walks named dependencies and processor registrations. It remembers
visited objects so cycles and shared dependencies are safe. It does not invoke
processing methods. It copies only the declared inspection fields, leaving out
configuration values, credentials, prompts, audio, screenshots, transcripts,
and operational state. This first refactor does not introduce a configuration
schema or a live configuration editor.

An arrow describes a possible call, from caller to dependency or selected
processor. Return values travel back on that call. A screen edge therefore points
from the pipeline to the screen sensor even though the screenshot returns to the
pipeline. The graph is a dependency and routing view, not a chronological data
flow or execution trace.

The routing policy stays in the existing router: longest prefix first, one prefix
removed, nonempty payload required, and LLM classification only without a matching
prefix. Only instruction-bearing registrations are eligible LLM results. A bare
prefix is consumed without dispatch. Graph edges describe potential destinations;
they neither run these rules nor cause fan-out.

## Export and scope

```sh
npm run --silent start -- --graph json
npm run --silent start -- --graph mermaid
```

The CLI builds the same inert pipeline, sensor, detector, processor, and queue
objects used for normal execution, exports their connections, and returns before
opening any desktop, screen, microphone, transcription, or VAD resources. Graph
export still loads and validates configuration, but does not serialize it. The
shared delivery queue comes from the existing activity object during normal
desktop operation and from the normal fallback queue during graph export.
An automated comparison checks the exported graph against wiring using the real
desktop-owned queue, including the queue's identity and shared connections.
ONNX is imported only when entering audio mode, so graph export does not load
its native library or create a VAD session.

The JSON output is directly serializable. [graph-mermaid.ts](../src/core/graph-mermaid.ts)
renders that data; it does not infer extra connections. Solid edges represent
named dependencies, and dotted edges represent conditional processor dispatch.
The renderer generates safe node identifiers independently of module IDs.

The initial pipeline graph contains nine nodes: pipeline, screen sensor,
transcriber, router, detector, three processors, and one shared keyboard queue.
Both text processors point to that same queue. `createGraph(router)` gives the
smaller view reachable from just the router.

This is an explicit boundary: the microphone/VAD loop, individual external
commands, logging, activity callbacks, pause control, history, sounds, and desktop
server internals are not yet modeled as nodes or edges. Their existing ownership
and callbacks stay in place. The graph should not be described as a complete
inventory of every call in the application. More named module boundaries can be
added using the same interface as needed.

## Behavior and validation

The refactor preserves the existing execution owners:

- The listener runs serial VAD while the pipeline processes accepted utterances.
  (Since the provisional endpoint, it also reports candidate onsets and
  rejections with their measured trailing silence, and the router awaits a
  commitment, including the 800 ms speech floor, before dispatch.)
- `submit` synchronously starts capture and retains the one-active/two-pending
  FIFO limit. Graph generation introduces no promises or extra queues.
- Cancellation travels through the same `AbortSignal` arguments, including pause
  periods and checks after transcription and inference.
- Text delivery and explicit recovery retain their shared queue. Text and Enter
  stay inside one claim; focus is checked at the same boundaries.
- Activity callbacks, history retention, interrupted-delivery outcomes, and the
  speech indicator retain their existing paths and timing.
- Processor instruction strings and the shared detector prompt are unchanged.

Run `npm run check`, `npm test`, and `npm run format:check`. Existing routing,
queue, cancellation, delivery, desktop, and VAD checks exercise the adapted
construction sites. [graph.test.ts](../test/unit/graph.test.ts) additionally checks
real wiring and shared ownership, prefix metadata, export isolation, cycles,
duplicate IDs, rendering, and both CLI export formats with external resources
deliberately unavailable. The CLI checks also verify that the native ONNX library
was not loaded and that desktop and export wiring match. Live microphone/keyboard
tests remain opt-in.
