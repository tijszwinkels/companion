# Short-phrase recognition

The reproduced defect is in the pre-ASR digital-silence guard. The old guard took
the RMS over the entire segment, including its preroll and 800 ms ending silence.
That penalized short phrases: Silero could accept clear speech, then the guard
would return an empty string without calling Parakeet.

The guard now applies the same 0.0005 floor to the strongest contiguous 128 ms
window. It still rejects digital silence and uniformly quieter input before
starting a worker. This measurement does not change, normalize, pad or trim the
captured audio. The 0.65/0.35 VAD probabilities, four-frame minimum, 256 ms preroll,
800 ms endpoint, 30-second cap, queue bounds and native model/protocol are unchanged.

## Reproduction and scope

The committed public `test/fixtures/speech.wav` begins with “and says” in its first
500 ms. Scale those samples by 0.01, put them after 500 ms of silence, append one
second of silence, encode PCM16 and decode using the production FFmpeg/framing
path. Real Silero accepts 320 ms of speech with peak probability 0.731. The
resulting 1376 ms segment has whole-buffer RMS **0.0004080**, but strongest-window
RMS **0.0012322**. The original transcriber from `e27ca3c` rejects it; the corrected
transcriber sends identical samples to the worker and returns “And says”.

This was reproduced with the local Parakeet TDT int8 model and parakeet-rs 0.3.5
on 2026-09-20. Replaying the baseline transcriber against the same regression
fails its first quiet-phrase delivery assertion. No microphone, screenshot,
external model service, desktop input or production database writes are involved.

Measured cases in `npm run asr:short-phrases`:

| Case | Result |
| --- | --- |
| Normal-volume short phrase at offsets 0, 127 and 511 samples | All three reach the inert router with the expected words. |
| Quiet phrase at offsets 0 and 511 | Both recover the expected words; both previously failed the RMS guard. |
| Quiet phrase at offset 127 | Passes VAD (192 ms) and the corrected guard; native ASR returns empty. Explicitly reported as an acoustic limit. |
| Same accepted quiet segment with 800 ms extra silence | Guard measurement is unchanged; native ASR still returns the expected words. |
| Same accepted quiet segment with 3200 ms extra silence | Guard measurement is unchanged; native ASR returns empty. Guard invariance does not imply model invariance. |
| Full five-second fixture, before and after short requests | Same words; direct ASR repeats the exact original transcript. |
| Digital silence and deterministic broadband noise | No VAD segment, ASR job or routed text. |

The two empty-output characterizations allow correct words if a future model
improves; they do not require an incorrect transcript. They never allow an energy
filter rejection or a worker error to masquerade as an acoustic limit.

The offset case also illustrates why model context matters: a delayed VAD onset
can leave less acoustic lead-in, and changing silence changes model output. This
change does not adjust preroll or invent missing speech. No universal improvement
for whispering, clipped syllables, microphone dropouts or every short word is claimed.

Read-only investigation of 18 recent stored short recordings reproduced all 18
stored transcripts exactly through direct ASR. Two records marked `error` already
contained text and reproduced that text again: those failures occurred after
transcription, although the exact later error was not retained in the database.
Cold VAD replay rejected three saved segments; saved audio lacks the preceding
recurrent VAD context, so that cannot classify their original capture. None of
these facts identifies the cause of every historical missed attempt. Rejected VAD
bursts and empty ASR outputs had no retained recording, and no specific failed
phrase/time was supplied during this investigation. Private recordings and text
are not fixtures or part of this report.

## Diagnostic stages

The ordinary CLI logger timestamps these records. New diagnostics contain only
fixed outcome names, numeric audio levels, durations and character counts. They
do not add transcripts, PCM, file paths or screenshots to the logs. Existing
transcript logging is unchanged; keep the complete CLI log private.

| Stage | What it establishes |
| --- | --- |
| `audio-levels` | Five-second aggregate (plus a final partial window): decoded duration, RMS, peak amplitude and peak VAD probability, including sounds that never start a candidate. Persistent low peak probability indicates no onset. |
| `vad` / `too-short` | A candidate reached onset but had fewer than 128 ms of voiced frames; preroll and silence are excluded from that count. |
| `vad` / `accepted` | Candidate duration, voiced duration, ending silence and peak probability. `reason` distinguishes silence endpoint, 30-second limit and EOF. |
| `audio-end` | `eof`, `cancelled` or `failed`; cancellation discards an unfinished candidate. Capture/framing errors still propagate with their existing error detail. |
| `asr` / `silence` | Pre-ASR energy filter rejected the buffer. Includes whole-buffer and strongest-window RMS. No request was sent. |
| `asr` / `empty` or `punctuation` | The worker answered, but its result supplied no usable words. |
| `asr` / `text` | Usable text, character count and ASR operation time, excluding screen capture. |
| `asr` / `error` | Worker startup, transport, native inference, timeout or cancellation failed. The accompanying existing error supplies the fixed description; no native stderr is forwarded. |
| `error` / `transcription`, `capture`, `recording`, `routing` | Identifies the pipeline stage that failed. Errors in later stages are not speech-recognition failures. |
| `dropped`, `filtered`, `intent`, delivery/outcome logs | Existing evidence for queue overload, missing text, classification and dispatch. |

ASR and pipeline records carry the same job ID. VAD reports precede job creation
and are ordered next to the existing utterance/submission logs. Capture summaries
retain four numeric accumulators, not a per-frame history. VAD reports occur once
per closed candidate, and ASR reports once per valid transcription operation.
Invalid/oversized input and pre-cancelled requests can fail before those metrics
exist; the pipeline still identifies the transcription stage. A capture failure
and empty ASR output can coexist; an empty result still prevents routing as before.

## Validation and tradeoffs

From this checkout, with the existing local model and FFmpeg:

```sh
npm ci
npm run asr:build
npm run check
npm test
npm run asr:test
npm run asr:short-phrases
npm run asr:bench
npm run format:check
```

These checks are headless. The regression supplies a static screenshot and an
inert detector/processor; it tests the real audio pipeline through dispatch, not
live screenshot capture, model intent accuracy or desktop delivery. Do not use
the ordinary `--wav` CLI for an isolated headless diagnosis: it also runs desktop
capture and routing.

Unit coverage includes odd pipe chunks and final-frame padding, 96 ms rejection
and 128 ms acceptance, EOF and duration limits, precise failure-stage diagnostics,
silence padding, nonfinite samples, all worker cancellation/reaping/recovery paths,
and all four sound cues at three gains and three frame offsets (36 combinations)
through real Silero. Those cue cases yield no accepted speech. This is a controlled
false-trigger check, not a measurement of a particular room or microphone.

Validation on 2026-09-20 passed TypeScript checking, all **239 unit tests**, both
Rust framing tests, formatting, the prerecorded short-phrase checks, and the
existing ASR benchmark. Its three fresh Voxtype transcriptions and five resident
worker transcriptions matched exactly. Warm five-second ASR took 232–288 ms
(median 260 ms); helper startup took 1440 ms. Recovered 1376 ms quiet phrases took
129–133 ms in the short-phrase run. These are local observations under the current
host load, excluding VAD, endpoint waiting, capture and intent inference; no OS
file caches were flushed. The native worker binary was built in this worktree.

The new guard performs one linear scan using constant extra memory. It permits
quiet VAD-approved speech that previously never incurred ASR work, so those
requests now pay the ordinary local inference cost. It can also expose any quiet
false positives already admitted by VAD to the model; VAD thresholds are not
loosened. It adds no ending-silence latency, retries, native model instances or
additional queue. Capture summaries add approximately twelve short lines per
minute while listening. The running listener was not restarted or modified;
integration requires the owner to start the updated source normally.
