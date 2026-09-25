# Speech timing: provisional endpoint and continuation

Agreed with Tijs on 2026-09-25. Before this change, the segmenter closed an
utterance after 800 ms of silence, and only then started ASR and intent
inference. Now it closes a **provisional** segment after a short silence and
starts work immediately. If the user keeps talking before the attempt commits
to an action, the provisional attempt is replaced by the whole utterance.

Source: `src/sensors/audio/segmenter.ts` (endpoint), `src/sensors/audio/listener.ts`
(candidate events), `src/core/utterance-continuation.ts` (hold/commit state and
the product constants), `src/core/pipeline.ts` (merge, supersession, cleanup) and
`src/core/router.ts` (commitment point). Prompts are unchanged.

## Timing

| Value | Setting | Effective |
| --- | --- | --- |
| Provisional endpoint | `VAD_SETTINGS.silenceMs = 200` | **224 ms**: silence is counted in whole 32 ms frames; 7 frames is the smallest count ≥ 200 ms (6 frames = 192 ms). Exported as `ENDPOINT_MS`. |
| Shortcut quiet window | `SHORTCUT_QUIET_MS = 800 − ENDPOINT_MS` | **576 ms** after the provisional endpoint, i.e. the legacy 800 ms after speech end. Derived from both constants. |
| Empty-transcript window | `EMPTY_QUIET_MS` | **1200 ms** after the provisional endpoint (see the evaluation). |
| Restored pause | `CONTINUATION_GAP_MS = 800 − 224 − 256` | **320 ms** of audio after the previous candidate that the preroll cannot hold (`Segment.leadIn`). |
| Combined audio cap | `MAX_UTTERANCE_SAMPLES` | 30 s, the segmenter's existing `maxMs`. |

The 0.65/0.35 VAD thresholds, the 128 ms voiced minimum, the 256 ms preroll and
the 30-second segment cap are unchanged.

## Lifecycle of a spoken utterance

1. **Provisional endpoint.** After 224 ms of silence the segment is submitted.
   As before, admission plays the `processing` cue, copies the interaction
   context and starts the screenshot. ASR starts as soon as the worker is free,
   and the intent LLM starts as soon as the transcript is ready. There is no
   additional waiting period.
2. **Resumed speech.** When the listener's segmenter opens a new candidate
   (the first frame at probability ≥ 0.65), `SensorPipeline.speechResumed()`
   _holds_ the newest job if it is an uncommitted speech attempt. A hold stops
   nothing: ASR and inference continue, but the attempt cannot pass its
   commitment point.
3. **The candidate resolves.**
   - _Rejected_ (fewer than 128 ms voiced): `speechDiscarded()` releases the
     hold. The attempt continues with its own result; nothing is lost or
     repeated. Coughs, clicks and the speaker's own cues end here.
   - _Accepted_: `submit()` supersedes the held attempt and admits a new job
     whose samples are the held attempt's raw samples, the real pause, and the
     new segment. The whole utterance is transcribed again, then a fresh intent
     LLM runs on that transcript. This repeats for further pauses.
4. **Commitment.** `ProvisionalAttempt.commit()` is awaited immediately before
   the first externally visible decision: dispatch or skip on every router path,
   and filtering an empty transcript in the pipeline. After it returns, the
   attempt can no longer be held or superseded; any later speech is a new
   request. Side effects are never undone or replayed.

Every listener exit path releases an open hold: a rejected candidate, EOF
(including a too-short tail), pause/abort, capture or VAD failure. A candidate
closed by the 30-second `limit` is an accepted segment and follows `submit`.

### Commitment points by route

| Route | Commits | Rationale |
| --- | --- | --- |
| Intent LLM (permanent or contextual intent) | As soon as inference returns, unless a hold is open. | Tijs: no additional wait. Resumed speech during inference replaces it. |
| Prefix and exact-label shortcuts, including their skips | After routing **and** 576 ms of quiet after the provisional endpoint (restarted by a released hold). | Product choice D1. Shortcuts have no inference time in which a pause can be bridged; without the window, "go to session ‹pause› three" would dispatch the bare prefix. This keeps today's 800 ms semantics. Shortcuts are still faster than before: ASR overlaps the window. |
| Empty transcript (no earlier text) | After 1200 ms of quiet after the provisional endpoint, before the empty clip is retained. | A fragment cut by a pause can be unreadable alone (see the evaluation). No action or cue is involved, so the wait is invisible; the window is comparable to how long an attempt with text stays continuable during inference. Costs: typed input queued behind it waits up to 1.2 s, and speech within the window is joined with the unreadable sound. |
| Typed input | Never held, and has no quiet window of its own; it waits only in FIFO order behind earlier jobs (for example up to 1.2 s behind an empty attempt). | Typed input has no VAD. A typed job admitted (or dropped as overload) after a speech attempt is a boundary: later speech cannot merge past it. Text typed while a VAD candidate is open therefore also releases that candidate's hold, so neither the earlier attempt nor the text waits for the candidate to close; the order stays attempt, text, then the resumed speech as a new request. |

Direct `submit()` callers without a listener never hold an attempt; only their
shortcut and empty decisions wait for their quiet windows.

## Cancellation and ownership

- **ASR is never aborted for supersession.** Aborting a request kills the
  resident Parakeet worker (a replacement takes about 1.4 s to load). A
  superseded job lets its short request finish and discards the result. Each
  job therefore has two signals: `signal` (pause/shutdown), used for ASR, and
  `routeSignal` (also supersession), used for capture, recordings, inference
  and dispatch. Supersession aborts the intent LLM request.
- **Ordering.** JavaScript runs these callbacks on one thread. `commit` checks
  for a hold and marks the attempt committed without an intervening `await`, so
  a VAD onset and an inference result are ordered, never interleaved. An onset
  reported in the same tick as the model's answer, before the router resumes,
  still holds the dispatch.
- **Queue bound.** Only the newest job can be continued. A merged job replaces
  the superseded one in place: a waiting job is swapped at its queue position
  and retired without ASR (outcome, capture settlement and `finished` run as
  in the worker). An active job is the newest, so its replacement runs next.
  A replacement bypasses the two-waiting bound because it does not add work;
  the bound still applies to new requests.
- **Pause audio.** A merge contains the previous segment (ending in 224 ms of
  silence), the segment's lead-in (up to 320 ms of the audio that followed it)
  and the new segment (starting with its 256 ms preroll). A pause of up to
  800 ms is therefore restored exactly: the retranscribed audio is the segment
  the legacy endpoint would have produced, apart from its shorter trailing
  silence. A longer pause is shortened to 800 ms of real audio. The evaluation
  motivated this: with the pause compressed to 480 ms, one merged clip lost six
  of its eight words. The lead-in is ignored for new requests. A rejected burst
  between the parts restarts the lead-in, so audio before the burst is not
  restored.
- **Memory.** The combined buffer is copied when the continuation is admitted,
  before the old job's `finally` clears its samples. It is limited to 30 s
  (1.9 MB of Float32). A transcript chain retains only the latest usable text.
- **Targets.** The combined attempt captures a fresh screenshot and interaction
  context at its own endpoint, matching the old "capture at speech end". The
  existing target and composer checks therefore apply to the final utterance.

## Product choices (D1–D4)

Approved by Tijs on 2026-09-25 as recommended. Each is isolated behind one
constant or one branch:

- **D1** Shortcut commitment waits for the legacy quiet window (`SHORTCUT_QUIET_MS`).
- **D2** If the combined retranscription is empty after the padded retry, but
  an earlier attempt of the same utterance had usable text, that latest earlier
  transcript is routed with a fresh LLM (`TranscriptChain`, pipeline `fallback`
  log). The empty combined clip is still retained under the usual floors; if
  that optional write fails, the failure is logged and counted, and the earlier
  transcript is still routed.
- **D3** A continuation that would make the combined audio exceed 30 s is not
  merged: the held attempt proceeds and the continuation is a new request.
- **D4** A superseded attempt whose transcript was already recorded keeps its
  history row with the neutral outcome `superseded` (no sound; not shown as a
  failure). An attempt superseded before its ASR result arrived writes no row,
  WAV or empty clip. The combined attempt has its own row.

The `processing` cue plays at every provisional endpoint, including a merged one.

### Shortcuts and pending inference

Tijs's requirement (2026-09-25): the pending LLM is cancelled when a shortcut
arrives. Supersession aborts the old attempt's inference at once, whatever the
combined utterance routes to. A late answer from the old request cannot pass
the commitment gate, and the new route's 576 ms shortcut window is never a grace
period for it. Tests cover a merge that routes to a prefix, an exact contextual
label and inference again (old request aborted, zero stale dispatches, exactly
one new dispatch), both orders of inference completion and resumed speech, and
the shortcut window with a cancelled inference.

**Pending with Tijs:** what happens when the continuation *on its own* is a
shortcut while the earlier inference is pending, for example "Can you help me"
‹pause› "go to session three". The current behavior merges: the whole
utterance routes afresh, so a prefix matches only at the start of the whole
utterance, and otherwise inference decides on the whole string. The
alternatives under discussion are to discard the earlier speech or to keep it
as a separate request. Either would change only the merge decision in
`SensorPipeline.submit`. The continuation's own segment is available there, but
choosing a route for it requires transcribing it separately first.

## Logs

| Stage | Meaning |
| --- | --- |
| `hold` | Speech resumed before dispatch; the job is held. |
| `release` | The resumed sound was rejected; the held job continues. |
| `superseded` | On the old job: replaced by the named continuation, then again when its processing ends. |
| `queued … (continues N)` | The combined job and the attempt it replaces. |
| `continuation` | The combined audio would exceed 30 s; the segment is a new request. |
| `fallback` | Combined audio had no text; the earlier transcript is routed (D2). |

## File input

File input (`--wav`, `asr:short-phrases`) still waits for each segment to finish
processing before reading further frames, so it never merges. A file with pauses
of 224 ms or more is now processed as several requests. The public fixture's
natural 640 ms pause between its two sentences, one segment before, is now two.
`npm run asr:speech-timing` paces frames in real time to reproduce live timing.

## Measured comparison (2026-09-25)

`npm run asr:speech-timing` (`test/bench/speech-timing.ts`) plays clips built
from the public `test/fixtures/speech.wav` in real time through the production
listener, real Silero, the pipeline and the local Parakeet worker. The intent LLM
is simulated with a fixed, abortable latency of 300, 700 or 1500 ms; capture and
the processor are inert. The identical script ran in a detached checkout of the
previous revision (`c5b01c4`, 800 ms endpoint) and at `9c3d86f` (224 ms plus
continuation), 94 runs each, sequentially on the same machine. Latency is
measured from VAD speech end (the report time minus its trailing silence) to the
processor call. Word error rate (WER) compares all dispatched text with Parakeet's
transcript of the same speech without inserted pauses. No microphone, private
audio, screenshot, model service or desktop input was used.

Clips: the first sentence ("And says, how do I get to Dublin?") alone; with a
pause of 150–1800 ms inserted after "And says," (comma) or mid-sentence at
1264 ms; both fixture sentences with a pause of 150–1800 ms; the unmodified
fixture (natural ~640 ms pause); the processing cue mixed in at the endpoint at
gains 1, 0.3 and 0.1; and 64/96 ms bursts of loud speech 100/400 ms after the
endpoint. The shortcut route uses a test prefix `and`.

**Latency, speech end → dispatch (ms):**

| Route | 800 ms | 224 ms | Change |
| --- | --- | --- | --- |
| LLM 300 ms, single sentence | 1329 | 726 | −603 |
| LLM 700 ms, single sentence | 1680 | 1118 | −562 |
| LLM 1500 ms, single sentence | 2487 | 1902 | −585 |
| LLM, median over all one-request results (300 / 700 / 1500) | 1364 / 1756 / 2545 | 731 / 1149 / 1944 | about −600 |
| Prefix shortcut (single and merged) | 1051 median | 801 (800–803) | −250 |

Merged utterances pay one extra ASR pass (150–200 ms) after the continuation, so
their latency is up to about 150 ms above a single utterance of the same length.

**Which pauses were joined into one request** (pause inserted in the audio; VAD
measures it roughly 50–100 ms longer):

| Clip | 800 ms | 224 ms, LLM 300 | 224 ms, LLM 700 | 224 ms, LLM 1500 |
| --- | --- | --- | --- | --- |
| Comma pause | ≤ 750 | ≤ 450 | ≤ 900 | ≤ 1200 |
| Two sentences | ≤ 600 | ≤ 450 | ≤ 900 | ≤ 1200 |
| Natural fixture (~640 ms) | joined | split | joined | joined |
| Prefix shortcut, comma pause | ≤ 750 | ≤ 750 (all latencies) | | |

The join window is now the time until commitment: 224 ms plus ASR plus
inference, instead of a fixed 800 ms. With a fast model, pauses of 600–750 ms
that used to join are split into two requests (more false splits); with a slow
model, pauses up to about 1.2 s join (more false joins of genuinely separate
requests). Shortcuts keep the legacy window by design (D1). All merges produced
the same words as the unpaused reference, except as listed below.

**Recognition quality.** Mean WER over all 94 runs: 0.122 at 800 ms and 0.133 at
224 ms. Single utterances, all merges, cues and bursts: WER 0 in both modes except
the prefix payload (the stripped word `and` counts as an error in both). The
differences come from splits and fragments:

- Split sentences are slightly worse at the boundary: "And says," / "But how do I
  get to Dublin?" (inserted "but"), in both modes when a split happens.
- A mid-sentence cut produces fragments that Parakeet cannot read alone, even
  after the padded retry. In the main run (576 ms empty window), pauses up to
  600 ms merged exactly. At 750 ms (VAD: 864 ms) both modes split; the 800 ms
  baseline still read "And says, how do I" with its longer trailing silence,
  while the 224 ms fragment was empty (WER 0.5 vs 0.875). At 900 ms both modes
  lost the whole sentence.
- A follow-up run of the mid-sentence clips (pauses 600–1800 ms, LLM 300 and
  700 ms) compared the 576 ms empty window with 1200 ms. With 1200 ms, pauses
  of 750, 900 and 1200 ms merged into the exact sentence (WER 0) at both
  latencies, where 576 ms and the 800 ms baseline lost words (WER 0.75–1).
  1800 ms still lost the first fragment. Latency was unchanged (710–1160 ms).
  `EMPTY_QUIET_MS` is therefore 1200 ms. Clips without an empty fragment are
  unaffected by this window.
- Before restoring the real pause, a merge with the pause compressed to 480 ms
  lost six of eight words once ("And says," only, at a 600 ms comma pause). With
  the restored pause, all comma-pause merges are exact.

**Races and cues.** Neither mode had a pipeline failure. In every run, dispatches
≤ accepted segments − superseded attempts, i.e. no superseded attempt dispatched.
47 attempts were superseded and retranscribed; ASR calls rose from 130 to 173
(+33 %) over this pause-heavy matrix. The processing cue at all three gains never
opened a candidate. A 64 ms burst 100 ms after the endpoint did not either; the
other three bursts each held the attempt and released it, with the same text, one
ASR pass and unchanged latency (1070–1115 ms at LLM 700).

**Limits.** One public five-second recording, digitally inserted silence, a
simulated LLM with constant latency and one machine. Live rooms have background
noise, and real inference latency varies, which moves the join window. These
numbers do not measure intent accuracy on partial transcripts.
