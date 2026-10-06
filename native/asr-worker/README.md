# Persistent Parakeet ASR

Companion's audio session owns one `companion-asr-worker` process. It loads the
existing Parakeet TDT model before listening, then reuses it for each utterance.
The helper calls `ParakeetTDT::transcribe_samples` from **parakeet-rs 0.3.5**,
with the same CPU defaults as Voxtype 1.0.1 (4 intra-operation / 1 inter-operation
threads). It does not implement an ASR decoder or change the model's precision.

The upstream [Voxtype Parakeet implementation](https://github.com/peteonrails/voxtype/blob/v1.0.1/src/transcribe/parakeet.rs)
and [lockfile](https://github.com/peteonrails/voxtype/blob/v1.0.1/Cargo.lock) establish
those versions and calls. Voxtype's hidden `transcribe-worker` uses Whisper and
is not a persistent Parakeet service. The system Voxtype installation and daemon
are independent of this helper.

## Build and migrate

From the checkout you intend to run:

```sh
npm ci
npm run asr:build
npm run asr:test
npm run asr:bench
# When ready to start a Companion session in your desktop:
npm start
```

Build requirements: Rust/Cargo 1.88 or newer, a C/C++ compiler/linker, `pkg-config`,
OpenSSL development files and CA certificates. The Cargo build downloads crates
and the CPU ONNX Runtime archive; it does not download a model. The committed
`Cargo.lock` and exact direct dependency versions pin the decoder and Rust ONNX
bindings. `--locked` prevents unnoticed dependency resolution changes. The default
build bundles ONNX Runtime; no Python environment or ONNX shared library setup is
needed. Build on the target machine. Linux arm64 was validated with Rust 1.98.1.

The default helper path is resolved relative to Companion's source checkout:
`native/asr-worker/target/release/companion-asr-worker`. Build it separately in each
checkout, or set `asr.workerBinary` to an existing build's absolute path. A worktree
has its own default binary path. Building does not install a system executable.

Existing configuration migration:

- Remove `asr.binary` (formerly the Voxtype executable). It now produces an
  actionable error rather than accidentally invoking Voxtype with a new protocol.
- Keep `asr.modelDir` pointing to the existing local **TDT** model directory.
  The default remains `~/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8`,
  expanded using the home directory in code. Explicit JSON paths must be expanded.
- `asr.workerBinary` is optional. Set it only for a separately built helper.
- `asr.timeoutMs` remains 90000 by default. It bounds explicit model startup and
  each transcription operation, including replacement startup after a failure.

Model files must already exist, including encoder/decoder ONNX files and
`vocab.txt`. The library selects the model files as it does in Voxtype; the tested
folder contains `encoder-model.int8.onnx` and `decoder_joint-model.int8.onnx`.
CTC, GPU execution providers and other model architectures are outside this
helper's scope. Missing worker/model errors settle startup before capture begins.
There is no silent fallback to a different decoder, model or precision.

## Lifetime, cancellation and recovery

`Transcriber` construction is inert. `start(signal)` loads the model; the CLI calls
it only after help, graph and supplied-text branches have returned. `transcribe`
can also lazily start it for direct callers. Every owner must call `close()` in
`finally`; the CLI and opt-in live test do so. `close()` is permanent and idempotent.

Only one operation is allowed; overlapping calls fail immediately. SensorPipeline
still owns one active plus two pending frames. Screenshots still start at speech
end. No routing, prefix, prompt, delivery or 800 ms silence-boundary behavior was
changed by the worker (the later [provisional endpoint](../../docs/speech-timing.md)
changed the boundary separately). The input bound (31 seconds then; now 61 seconds, the 60-second utterance cap plus retry padding), RMS silence threshold of 0.0005, punctuation
filter and 4000 UTF-16-code-unit transcript bound are preserved. The silence floor
now applies to the strongest 128 ms window, so quiet short speech is not diluted
by endpoint silence. It does not normalize or trim the model input. PCM16 conversion
is shared with the old WAV encoder, preserving the audio seen by the model.

On timeout, cancellation, EOF, process failure or invalid response, the parent
kills its worker with SIGKILL and awaits the child's `close` event before rejecting.
This interrupts even synchronous native inference or model loading. No late text
is returned to the pipeline. Pause keeps an **idle** model resident but cancels
an active request. Shutdown cancels outstanding work and releases the process.

Failed, timed-out and cancelled requests are never retried or replayed. The one
exception is a successful but **empty** result: the transcriber sends the same
samples once more, with 250 ms of digital silence on each side, to the same worker
within the same operation timeout. Punctuation-only results, quiet input below the
retry floor, and input that padding would push past 61 seconds are not retried. See
[empty-result retry](../../docs/short-phrase-recognition.md#empty-result-retry).
A later utterance can create one replacement after the previous process has closed. Repeated failures consume one
attempt per new utterance, never a background restart loop. An idle worker exit is
noticed by the next call. The bounded pipeline remains the only utterance queue.

The helper uses inherited private pipes, no socket, no microphone, no desktop
integration and no temporary audio/transcript files. Native diagnostics are drained
without being retained or included in error messages. Errors use fixed descriptions.
The parent clears encoded audio buffers after each request; the library owns its
inference buffers. Model weights, ONNX allocator caches and reusable inference
memory remain resident intentionally until the process exits. This is not secure
memory erasure; the process boundary provides cancellation and resource reclamation.

## Protocol 1

The executable accepts `--model DIRECTORY`. After loading, stdout emits:

```json
{ "type": "ready", "protocol": 1, "engine": "parakeet-tdt", "decoder": "parakeet-rs/0.3.5" }
```

Each stdin request consists of a little-endian unsigned 32-bit sample count,
followed by that many signed little-endian 16-bit PCM samples (16 kHz, mono).
The helper checks `1 <= count <= 976000` (61 seconds) before allocating. Only one request may
be outstanding. The empty-result retry is an ordinary second request after the
first response. No request IDs, retry protocol or cancellation messages are needed:
cancellation destroys the process, so its response cannot be mistaken for a later
utterance's result.

Each response is exactly one newline-terminated UTF-8 JSON object:

```json
{ "type": "result", "text": "Recognized speech." }
```

Failures emit `{"type":"error","code":"model"}` (or `input`, `inference`,
`transcript_limit`, `output`) and exit. The parent accepts at most 32768 bytes per
response, rejects malformed UTF-8/JSON, wrong message types, extra/unsolicited
messages and oversized transcripts, and never includes response data in diagnostics.
Clean stdin EOF releases the model; partial headers/audio fail. stdout EOF is a
worker failure for the parent. `--version` prints build/protocol identity without
loading a model.

## Benchmark and tests

`npm run asr:bench` uses only the public five-second
[test/fixtures/speech.wav](../../test/fixtures/speech.wav). It runs three fresh
Voxtype processes with explicit `--engine parakeet`, then loads one helper and
runs five requests on it. Both paths receive identical PCM16 and the same model
folder. All eight transcripts must match exactly and contain “Dublin”. The report
includes raw timings and SHA-256 hashes. `COMPANION_BENCH_VOXTYPE` overrides the
baseline executable (default `~/.local/bin/voxtype`); version must be 1.0.1. FFmpeg
is required for fixture decoding. No fixture selector can silently skip an engine.

Measured 2026-09-18 on this Linux arm64 host, Node 26.8.1, Rust 1.98.1.
The [raw report](benchmark.json) records the final implementation:

| Operation                          | Milliseconds                           |
| ---------------------------------- | -------------------------------------- |
| Fresh Voxtype process, three runs  | 1672.59, 1801.79, 1745.95              |
| Persistent helper model startup    | 1444.04                                |
| Five transcriptions on that helper | 283.92, 276.79, 191.85, 249.49, 313.69 |
| Startup plus first transcription   | 1727.96                                |

Median ASR request latency fell from **1745.95 ms to 276.79 ms (6.31×)**.
The first request above is already model-loaded; it is included in the warm series.
Cold startup here means a new process, not a flushed OS file cache. File caches
were not flushed and existing services were left running. CPU model identification
was unavailable (`os.cpus()[0].model` returned `unknown`). This benchmark excludes
VAD, ending silence, screenshots, intent detection and delivery; it does not imply
that full end-to-end latency is 6.31× lower.

The unchanged transcript was:

> and says, How do I get to Dublin? And the answer that comes back is

Model SHA-256:

- encoder-model.int8.onnx: `6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09`
- decoder_joint-model.int8.onnx: `eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70`
- vocab.txt: `d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d`
- Fixture: `523c26311148fb0aba901a1cca4809d4b80b4850749790c00b3ab523cc19ff7d`

One-minute input, measured 2026-10-06 on the same host with this worker and
model: the public fixture repeated with 300 ms gaps took about 2.5 s for 60 s
(real-time factor about 0.04), well within the 90-second operation timeout even
with the retry. Worker RSS rose from about 0.97 GB after loading to about 1.23 GB
after 30 s inputs and 1.4–1.85 GB after 60 s inputs; it stays resident until the
worker exits. Repeated audio is not natural speech: transcription quality of a
continuous spoken minute was not measured.

`npm test` uses disposable subprocesses to test worker reuse, bounded responses,
UTF-8 fragmentation, invalid protocol, cancellation/timeout/close during startup
and inference, missing executables, model failures, idle exits, recovery, no replay,
and pause through the real pipeline. Fresh CLI processes prove help/graph/text
acquire no audio processes or native ONNX libraries; desktop commands are mocked.
`npm run asr:test` checks native PCM framing, bounds and EOF handling. Neither test
command captures the desktop or microphone. The prerecorded benchmark validates
the actual native decoder separately from the protocol fixtures.

Validation completed on this branch: TypeScript check, all 114 unit tests (including
33 ASR/CLI lifecycle checks), both native framing tests, Prettier and rustfmt checks,
the prerecorded benchmark, and a real helper missing-model startup check. No live
desktop/compositor, microphone, input-injection or desktop plugin tests were run.
The live test was updated to close its worker but was not executed.

For the later quiet short-phrase regression, run `npm run asr:short-phrases`.
It uses the same public fixture through actual PCM16 file decoding, Silero,
segmentation, persistent ASR and an inert router. It also reports acoustic cases
where the current model still returns empty text; passing the energy guard does
not guarantee words. See [evidence and diagnostic stages](../../docs/short-phrase-recognition.md).
