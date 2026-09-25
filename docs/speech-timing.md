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
| Shortcut/empty quiet window | `SHORTCUT_QUIET_MS = 800 − ENDPOINT_MS` | **576 ms** after the provisional endpoint, i.e. the legacy 800 ms after speech end. Derived from both constants. |
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
     whose samples are the held attempt's raw samples followed by the new
     segment. The whole utterance is transcribed again, then a fresh intent
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
| Empty transcript (no earlier text) | After the same quiet window, before the empty clip is retained. | A fragment cut by a pause can be unreadable alone (see the evaluation). No action or cue is involved, so the wait is invisible. |
| Typed input | Never held and never waits. | Typed input has no VAD. A typed job admitted after a speech attempt is a boundary: later speech cannot merge past it. |

Direct `submit()` callers without a listener never hold an attempt; only their
shortcut and empty decisions wait for the quiet window.

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
- **Memory.** The combined buffer is copied when the continuation is admitted,
  before the old job's `finally` clears its samples. It is limited to 30 s
  (1.9 MB of Float32). A transcript chain retains only the latest usable text.
- **Targets.** The combined attempt captures a fresh screenshot and interaction
  context at its own endpoint, matching the old "capture at speech end". The
  existing target and composer checks therefore apply to the final utterance.

## Product choices (D1–D4)

Recommended by the implementation session and endorsed by the tech lead on
2026-09-25; **awaiting Tijs's confirmation**. Each is isolated behind one
constant or one branch:

- **D1** Shortcut commitment waits for the legacy quiet window (`SHORTCUT_QUIET_MS`).
- **D2** If the combined retranscription is empty after the padded retry, but
  an earlier attempt of the same utterance had usable text, that latest earlier
  transcript is routed with a fresh LLM (`TranscriptChain`, pipeline `fallback`
  log). The empty combined clip is still retained under the usual floors.
- **D3** A continuation that would make the combined audio exceed 30 s is not
  merged: the held attempt proceeds and the continuation is a new request.
- **D4** A superseded attempt whose transcript was already recorded keeps its
  history row with the neutral outcome `superseded` (no sound; not shown as a
  failure). An attempt superseded before its ASR result arrived writes no row,
  WAV or empty clip. The combined attempt has its own row.

The `processing` cue plays at every provisional endpoint, including a merged one.

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

## Evaluation

See [the measured comparison](#measured-comparison-2026-09-25) below.
