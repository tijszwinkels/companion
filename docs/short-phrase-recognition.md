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
phrase/time was supplied during that investigation. Private recordings and text
are not fixtures or part of this report. The later empty-clip retention described
below changes future diagnostics; it cannot recover those historical samples.

## Diagnostic stages

The ordinary CLI logger timestamps these records. New diagnostics contain only
fixed outcome names, numeric audio levels, durations and character counts. They
do not add transcripts, PCM, file paths or screenshots to the logs. Existing
transcript logging is unchanged; keep the complete CLI log private.

| Stage | What it establishes |
| --- | --- |
| `asr-start` | Human-readable startup notice before loading the resident Parakeet worker. Per-utterance `asr` records remain JSON. |
| `audio-levels` | Five-second aggregate (plus a final partial window): decoded duration, RMS, peak amplitude and peak VAD probability, including sounds that never start a candidate. Persistent low peak probability indicates no onset. |
| `vad` / `too-short` | A candidate reached onset but had fewer than 128 ms of voiced frames; preroll and silence are excluded from that count. |
| `vad` / `accepted` | Candidate duration, voiced duration, ending silence and peak probability. `reason` distinguishes silence endpoint, 30-second limit and EOF. |
| `audio-end` | `eof`, `cancelled` or `failed`; cancellation discards an unfinished candidate. Capture/framing errors still propagate with their existing error detail. |
| `asr` / `silence` | Pre-ASR energy filter rejected the buffer. Includes whole-buffer and strongest-window RMS. No request was sent. |
| `asr` / `empty` or `punctuation` | The worker answered, but its final result supplied no usable words. |
| `asr` … `emptyRetry` | Present only when the first pass returned empty text: `recovered` (outcome `text`), `empty`, `punctuation` or `error` for the one padded retry, or `quiet` / `too-long` when none was sent. `retryMs` times a sent retry. |
| `asr-recorded` | An eligible empty ASR result was saved as a WAV/metadata pair; links the job ID to the clip UUID. |
| `asr` / `text` | Usable text, character count and ASR operation time (including any retry), excluding screen capture. |
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
File decoding zero-pads its final partial frame to 32 ms, so reported decoded
duration can include up to 31.9 ms of padding. Optional transcription observers
cannot change the ASR result or replace its original error if they throw.

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

Validation of the original audio branch (`91fc80a`) on 2026-09-20 passed TypeScript
checking, its **239 unit tests**, both Rust framing tests, formatting, the
prerecorded short-phrase checks, and the
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
additional queue. (The later empty-result retry below is a separate change.) Capture summaries add approximately twelve short lines per
minute while listening. The running listener was not restarted or modified;
integration requires the owner to start the updated source normally.

## Retaining future empty attempts

As of the empty-clip retention change, the desktop saves confirmed `asr/empty`
results that meet the existing duration and energy floors in a separate
`asr-empty/YYYY-MM-DD/<uuid>/` directory outside the successful recordings
under `data/`. This preserves the complete segment
and numeric diagnostics without creating a transcript-history row or saving a
screenshot. Silence, punctuation-only output and ASR errors do not qualify.
The helper reports empty text, not raw token counts. See the
[storage contract](../src/desktop/README.md) for thresholds, cancellation, retention
and the `--no-desktop` opt-out. Recognition and routing behavior are unchanged.

## Empty-result retry

A live utterance on 2026-09-24 passed VAD with clear speech (peak probability
0.999, strongest-window RMS 0.0246), yet Parakeet returned empty text, twice, for
the exact saved segment. The same samples produced words when given 250 ms of
leading silence, 500 ms of trailing silence or 4× gain. The decoder's exact cause
is unknown. The recording is private and is not a fixture.

The transcriber now retries a genuinely **empty** first-pass result once: the
unchanged samples with 250 ms of digital silence (PCM16 zeros) on each side, on
the same resident worker. The first pass is unchanged, so a normal result still
sends exactly one request. No other outcome is retried:

- Punctuation-only results, silence-guard rejections, worker errors, timeouts and
  cancellation never cause a retry. Nothing follows the retry.
- The retry shares the original operation's timeout, cancellation and reaping. A
  retry failure rejects the operation like any request failure; it does not start
  a replacement worker. Only a later utterance can do that.
- Input whose strongest-128-ms-window RMS is below 0.005 (ten times the silence
  floor) is not retried (`emptyRetry: "quiet"`), for the reason shown below.
- Input that padding would push past the 31-second request bound is not retried
  (`too-long`). Live segments are capped at 30 seconds, so this affects only
  direct callers near the bound.
- The caller's samples are never modified. Empty-clip retention uses the final
  outcome and saves the original segment; a recovered result follows the ordinary
  transcript path, and its recording is the original, unpadded segment.

The pipeline receives one `asr` diagnostic per operation. Its `outcome` is final,
so a recovered result reads as `text`, with `emptyRetry` and `retryMs` fields.
Neither contains transcripts or samples.

### Evaluation (2026-09-24, local Parakeet TDT int8)

These measurements used the existing main-checkout helper binary in separate
local processes. The live listener was not touched.

| Input | Result |
| --- | --- |
| Private clip, 10 padding variants × 2 runs (lead 125–500 ms, trail 250–1000 ms) | Unpadded: empty both times. Every padded variant: 8 words, repeatable. All variants agreed except trailing-only padding of 500 ms or more, which gave slightly different words. |
| Private clip through the changed transcriber, 6 runs | Recovered 6/6 with identical text; samples unchanged. Total 388–506 ms, of which the retry took 191–275 ms. |
| Public quiet phrases (gain 0.01, strongest-window RMS 0.0012) that decode empty, 11 cases | Padded retries mostly produced **wrong** words (for example single numbers); with 250/250 padding, 7 of 11 did. Hence the 0.005 retry floor: these stay empty and are retained. |
| Public loud fixture fragments (1.2 s cut mid-word) with an empty first pass | The retry recovers leading words; `npm run asr:short-phrases` now checks one of them (“and says how do I get …”). The final clipped word can be misheard. |
| Public loud/normal phrases and full fixture | First pass succeeds; no retry, one request, unchanged transcripts. Five-second request 250–346 ms. |

False-positive probes sent directly to ASR (bypassing VAD, so harsher than live):

- Synthetic tones, hum, clicks, white/brown noise and all six sound cues at three
  gains (32 inputs): 24 were empty on the first pass, and 250/250 retries produced
  no text for any of them. (Some other padding variants produced a filler word.)
- Time-reversed fixture fragments, which are speech-like but contain no words:
  the model already returns text for 152 of 284 on the first pass. Of first-pass empties
  at or above the retry floor, 19 of 84 (23%) gained text on retry, compared with
  20 of 83 (24%) for forward fragments. **The retry does not distinguish words from
  word-like nonspeech.** Its false-positive risk is whatever VAD admits as speech
  but the first pass leaves empty.

The retry adds one inference (about 0.2 s for a short utterance) only when the
first pass is empty and eligible. This is a bounded mitigation, verified on one
private clip and public fixtures. It is not a universal fix, and other microphones,
voices and rooms are untested.
