# Speech timing: provisional endpoint and continuation

Agreed with Tijs on 2026-09-25. Before this change, the segmenter closed an
utterance after 800 ms of silence, and only then started ASR and intent
inference. Now it closes a **provisional** segment after a short silence and
starts work immediately. If the user keeps talking before the attempt commits
to an action, the provisional attempt is replaced by the whole utterance.

**800 ms commitment floor** (Tijs, 2026-09-26). Work still starts at the
provisional endpoint, but a spoken decision (the intent LLM's answer or a
shortcut) commits only when it is ready **and** at least 800 ms have passed
since the latest VAD-detected speech:
`commit time = max(speech end + 800 ms, decision ready)`. It is not the decision
time plus 800 ms. An early answer stays provisional and continuable until the
floor; a slow answer commits as soon as it arrives.

Source: `src/sensors/audio/segmenter.ts` (endpoint), `src/sensors/audio/listener.ts`
(candidate events), `src/core/utterance-continuation.ts` (hold/commit state and
the product constants), `src/core/pipeline.ts` (merge, supersession, cleanup) and
`src/core/router.ts` (commitment point). Prompts are unchanged.

## Timing

| Value | Setting | Effective |
| --- | --- | --- |
| Provisional endpoint | `VAD_SETTINGS.silenceMs = 200` | **224 ms**: silence is counted in whole 32 ms frames; 7 frames is the smallest count ≥ 200 ms (6 frames = 192 ms). Exported as `ENDPOINT_MS`. |
| Spoken commitment floor | `SPEECH_QUIET_MS = LEGACY_ENDPOINT_MS` | **800 ms** after the latest VAD-detected speech ended, for inference and shortcuts. After a silence endpoint 224 ms have already passed at admission, so **576 ms** remain. |
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
   waiting period before either; only the commitment (step 4) waits.
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
   and filtering an empty transcript in the pipeline. It returns once no hold is
   open and the route's deadline has passed (see below). After it returns, the
   attempt can no longer be held or superseded; any later speech is a new
   request. Side effects are never undone or replayed.

Every listener exit path releases an open hold: a rejected candidate, EOF
(including a too-short tail), pause/abort, capture or VAD failure. A candidate
closed by the 30-second `limit` is an accepted segment and follows `submit`.

### Commitment points by route

| Route | Commits | Rationale |
| --- | --- | --- |
| Intent LLM (permanent or contextual intent; cleanup on or off) | When inference has returned **and** 800 ms have passed since the latest speech, and no hold is open. | Tijs (2026-09-26): an answer that arrives within 800 ms of speech stays continuable, so a short pause no longer splits a request just because the model was fast. No time is added after a slower answer. Resumed speech during inference or during the floor replaces the attempt. |
| Prefix and exact-label shortcuts, including their skips | After routing **and** the same 800 ms floor. With cleanup on, a text shortcut's separate cleanup call starts after commitment, as before. | Product choice D1. Shortcuts have no inference time in which a pause can be bridged; without the floor, "go to session ‹pause› three" would dispatch the bare prefix. Shortcuts are still faster than before provisional endpoints: ASR overlaps the floor. |
| Empty transcript (no earlier text) | After 1200 ms of quiet after the provisional endpoint, before the empty clip is retained. | A fragment cut by a pause can be unreadable alone (see the evaluation). No action or cue is involved, so the wait is invisible; the window is comparable to how long an attempt with text stays continuable (the 800 ms floor, or longer during slow inference). Costs: typed input queued behind it waits up to 1.2 s, and speech within the window is joined with the unreadable sound. |
| Typed input | Never held, and has no quiet window of its own; it waits only in FIFO order behind earlier jobs (for example up to 1.2 s behind an empty attempt). | Typed input has no VAD. A typed job admitted (or dropped as overload) after a speech attempt is a boundary: later speech cannot merge past it. Text typed while a VAD candidate is open therefore also releases that candidate's hold, so neither the earlier attempt nor the text waits for the candidate to close; the order stays attempt, text, then the resumed speech as a new request. |

Direct `submit()` callers without a listener never hold an attempt. They pass no
measured silence, so their spoken decisions wait the full 800 ms after admission,
and empty decisions 1200 ms.

### Measuring the speech end

All deadlines use one monotonic clock (`performance.now()`), never the time of
day and never the model's completion time.

- **Admission.** The segmenter reports the silence it actually counted after the
  last voiced frame (`Segment.trailingSilenceMs`) and the listener submits the
  segment in the same tick; `submit` requires this (a later submission would only
  anchor the floor late). The attempt's speech end is admission time minus that
  silence. A silence endpoint measured 224 ms; a segment closed by the 30-second
  `limit` or at end of input measured less, often 0, and owes the rest of the
  800 ms. No silence is assumed that was not heard.
- **Queueing, ASR and inference** after admission (processing-queue delay, not a
  delay before admission) count toward the floor: the
  user was silent throughout. A job that waited 2 s behind another dispatches as
  soon as it is decided.
- **Merged attempt.** Its speech ends with the continuation segment, so it gets
  a fresh floor measured from that segment's own trailing silence.
- **Rejected burst.** A too-short candidate (cough, click) was still the latest
  VAD speech. The listener passes its measured trailing silence to
  `speechDiscarded`, including for a too-short tail still open at end of input
  (often 0 ms), and both quiet periods restart from it: the floor 800 ms
  after the burst ended, the empty window 1200 ms after the burst was rejected,
  exactly as they count from an endpoint.
- **Other releases** (typed input as a boundary, pause, capture or VAD failure,
  shutdown, a continuation over the 30-second cap) end a hold because no later
  sound can join the attempt any more. Waiting longer could not change the
  outcome, so the attempt keeps its deadlines. (Previously every release
  restarted the shortcut and empty windows.)
- **Latency of VAD itself.** The speech end is taken when the listener processes
  the frame. If VAD falls behind the microphone, onsets are observed with the same
  delay, so the floor is late rather than early.

## Cancellation and ownership

- **ASR is never aborted for supersession.** Aborting a request kills the
  resident Parakeet worker (a replacement takes about 1.4 s to load). A
  superseded job lets its short request finish and discards the result. Each
  job therefore has two signals: `signal` (pause/shutdown), used for ASR, and
  `routeSignal` (also supersession), used for capture, recordings, inference
  and dispatch. Supersession aborts the intent LLM request.
- **Ordering.** JavaScript runs these callbacks on one thread. `commit` checks
  for a hold and the deadline and marks the attempt committed without an
  intervening `await`, so a VAD onset, the deadline timer and an inference
  result are ordered, never interleaved. An onset reported in the same tick as
  the model's answer or the deadline timer, before the waiting commitment
  resumes, still holds the dispatch. A timer alone never commits: the
  commitment re-examines hold, supersession and cancellation first. Each wait's
  timer and abort listener are removed when it ends.
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

- **D1** Shortcut commitment waits for the legacy 800 ms of quiet. Since
  2026-09-26 inference shares the same floor (`SPEECH_QUIET_MS`).
- **D2** If the combined retranscription is empty after the padded retry, but
  an earlier attempt of the same utterance had usable text, that latest earlier
  transcript is routed with a fresh LLM (`TranscriptChain`, pipeline `fallback`
  log). The empty combined clip is still retained under the usual floors; if
  that optional write fails, the failure is logged and counted, and the earlier
  transcript is still routed.
- **D3** A continuation that would make the combined audio exceed 30 s is not
  merged: the held attempt proceeds and the continuation is a new request.
- **D4** (revised by Tijs, 2026-09-27: one retained final utterance per
  continuation chain, prospectively). An attempt superseded before its ASR
  result arrived writes no row, WAV or empty clip, as before. An attempt
  superseded after its transcript was recorded still gets a row, WAV, PNG and
  possibly an intent request while it is live, with the neutral outcome
  `superseded`. It is then removed once the final record of its utterance owns
  the whole utterance; see [final-only retention](#final-only-retention). The
  final record, with its true outcome, is the one record.

The `processing` cue plays at every provisional endpoint, including a merged one.

### Shortcuts and pending inference

Tijs's requirement (2026-09-25): the pending LLM is cancelled when a shortcut
arrives. Supersession aborts the old attempt's inference at once, whatever the
combined utterance routes to. A late answer from the old request cannot pass
the commitment gate, and the new route's 800 ms floor is never a grace period
for it. Tests cover a merge that routes to a prefix, an exact contextual label
and inference again (old request aborted, zero stale dispatches, exactly one new
dispatch), both orders of inference completion and resumed speech, and the
shortcut floor with a cancelled inference.

**Pending with Tijs:** what happens when the continuation *on its own* is a
shortcut while the earlier inference is pending, for example "Can you help me"
‹pause› "go to session three". The current behavior merges: the whole
utterance routes afresh, so a prefix matches only at the start of the whole
utterance, and otherwise inference decides on the whole string. The
alternatives under discussion are to discard the earlier speech or to keep it
as a separate request. Either would change only the merge decision in
`SensorPipeline.submit`. The continuation's own segment is available there, but
choosing a route for it requires transcribing it separately first.

## Final-only retention

Tijs (2026-09-27): each spoken utterance ends with **one** authoritative record
in SQLite, its recordings and the current-run Activity list, even when pauses
made it several provisional attempts, and including failed or cancelled final
attempts. This applies to utterances recorded from now on only. Source:
`TranscriptChain` and `Activity.attemptSuperseded`/`continuationSettled` in the
pipeline, `DesktopRuntime.settleContinuation`/`retire`, and
`UtteranceHistory.retireSuperseded`.

1. **Chain.** Each supersession appends the replaced attempt's frame id to the
   utterance's chain and reports it with `Activity.attemptSuperseded(id)`; only
   frames reported this way are chain members (never a row merely because its
   outcome is `superseded`). When the chain's final attempt settles, whatever
   its outcome, the pipeline calls `continuationSettled(finalId, supersededIds)`
   just before `finished(finalId)`. The sensor worker is serial, so every
   superseded attempt that reached ASR has already finished; its frame no longer
   maps to a row, so no late write can recreate its row or files. An attempt
   replaced while queued never reached ASR and recorded nothing.
2. **Deferred card and hold.** A chain member's row is held from the moment it
   is superseded (or from its `finished`, if its row appeared later) until the
   chain settles, and its Activity card is not published at `finished`. The
   replaced attempt may still be finishing, and the recent database list may
   show its row for the second or so until the chain settles, but paste,
   label, history-agent questions and user deletion of a held row are refused
   ("replaced by a continuing utterance"), so it cannot be used or race the
   retirement. The hold ends when the chain settles, on every path.
3. **The final record.** Normally the final attempt records its own transcript,
   combined WAV and PNG, with its real outcome (sent, ignored, error, cancelled).
   If it fails *before* recording a transcript while an earlier attempt had
   produced usable text (ASR error, pause or shutdown during ASR), the pipeline
   records
   a **recovered failure** instead: the latest usable earlier text, marked
   `transcript_source = 'earlier-attempt'`, with the combined WAV, the final
   attempt's own PNG if its capture succeeded, and the true `error` or
   `cancelled` outcome (or an audio-only record, below, when there is no
   usable earlier text). It is written in the failure path and is never routed,
   so earlier text or an earlier screen can never drive an action. The D2
   fallback (empty combined transcript routed with earlier text) is marked the
   same way. The Activity card shows "Text from an earlier part of this
   utterance; the full recording was not transcribed", and the recovery picker
   "earlier words". NULL means unspecified, not a verified full transcript: old
   rows, typed input and ordinary ASR rows all read NULL.
4. **Ownership and retirement.** The final record owns the utterance once its
   row exists and its WAV, which contains every earlier part's raw audio, was
   published. A fresh PNG is not required, and an earlier PNG is never moved
   to the final record: when the final capture failed, the final record has no
   screenshot (history-agent questions are unavailable for it, as for any
   missing screenshot) and the earlier screen is lost. Then each superseded row
   is retired after dispatch, off the sensor worker: files first, then the row,
   and `history-deleted` is published. `retireSuperseded` is narrower than user
   deletion: the row must be finished, have outcome exactly `superseded`, and
   have no paste attempt or feedback. Shutdown waits for pending retirements
   before closing the database; the CLI already waits for the pipeline, and so
   for recovered-failure writes, before closing desktop storage.

### Exceptions: residual records

**No usable text at all** (Tijs, 2026-09-27). If no part of a continued
utterance yielded usable text (every earlier part was empty, or its ASR never
returned) and the final ASR fails or is cancelled, the final attempt records
one **audio-only** record instead: an empty transcript marked
`transcript_source = 'audio-only'`, the combined WAV, its own PNG if captured,
and the true outcome. No words are invented, it is never routed, and paste
recovery and history-agent questions refuse it ("audio only"). The Activity card
reads "Audio only: no speech was recognized, so nothing was sent" and offers no
copy, insert or new-session action; the picker shows "(audio only)". This
applies only to continued utterances: a single utterance whose ASR fails still
records nothing, and an ASR result that *returns* empty keeps the existing
empty-result policy (no history record; qualifying clips go to `asr-empty`).

Otherwise, failures end in one record (step 3). More than one record remains
only in these explicit cases, each logged as `retention-incomplete` with the
row UUIDs and reason; nothing publishes a removal that did not happen:

- **Failed ownership.** The final attempt's row or WAV could not be written. The
  superseded rows are kept as ordinary rows, beside a final row if one exists.
- **Failed cleanup.** A file or SQLite removal failed. Files are removed first,
  so a row kept after a failed SQLite step may already have lost some
  recordings; the final WAV covers its audio, but its PNG may be gone.
- **Crash** before or during retirement leaves superseded rows (possibly
  without files). There is no startup sweep.
- **User references.** A row is visible, and can be manually pasted, from its
  transcript until commitment, which can be before it is superseded. A
  superseded row with a paste attempt (or feedback) is kept as the user's
  evidence.

Only rows this listener run created and linked in memory are touched. There is
no migration, startup sweep, outcome filter or hiding: `superseded` rows from
earlier runs remain. Preview mode records rows too, so retirement applies there
as well. No durable "incomplete" status is stored.

**Side effects.** Removed with a superseded row: its partial transcript, its
screenshot and window title from the earlier endpoint (the only copy of that
earlier screen), and its `intent_request` (a partial-transcript prompt that was
never acted on). Its audio is contained in the final WAV. A recovered-failure
record's text may miss the final words, which is why it is labelled. Paste
recovery and history-agent questions can no longer start from a partial row once
it is retired. How often speech was superseded is now visible only in listener
logs, and `inspectDatabase().recorded` no longer counts those prompts. ASR and
model work are unchanged: nothing is saved in compute. Retirement costs two file
removals and one small transaction after dispatch; a recovered failure adds one
row and WAV write before the failed job finishes. Listener logs, SQLite WAL/free
pages and backups can still contain the removed text; nothing is purged.

## Logs

| Stage | Meaning |
| --- | --- |
| `hold` | Speech resumed before dispatch; the job is held. |
| `release` | The resumed sound was rejected, or can no longer join the job; the held job continues. |
| `superseded` | On the old job: replaced by the named continuation, then again when its processing ends. |
| `queued … (continues N)` | The combined job and the attempt it replaces. |
| `continuation` | The combined audio would exceed 30 s; the segment is a new request. |
| `fallback` | Combined audio had no text; the earlier transcript is routed (D2). |
| `retired` | Desktop: a superseded row and its recordings were removed; its continuation keeps the utterance. |
| `recovered` | The final attempt failed before its own transcript; the earlier words (or audio only, if there were none) are recorded with the combined audio. |
| `retention-incomplete` | Desktop: superseded rows kept, because the final record could not be written or a retirement failed. |

## File input

File input (`--wav`, `asr:short-phrases`) still waits for each segment to finish
processing before reading further frames, so it never merges. A file with pauses
of 224 ms or more is now processed as several requests. The public fixture's
natural 640 ms pause between its two sentences, one segment before, is now two.
Files decode faster than real time, but the floor is measured on the monotonic
clock, so each spoken decision from a file still waits until 800 ms after its
segment was read (576 ms after a silence endpoint), as file shortcuts already
did. `npm run asr:speech-timing` paces frames in real time to reproduce live timing.

## Measured with the 800 ms floor (2026-09-26)

`npm run asr:speech-timing -- --quick` (pauses 300, 700 and 1200 ms; 44 runs)
at the floor's implementation commit, with the same public fixture, real Silero
and Parakeet, simulated LLM and inert processor as the comparison below. No
failures; no superseded attempt dispatched.

| Measure | LLM 300 ms | LLM 700 ms | LLM 1500 ms |
| --- | --- | --- | --- |
| Single sentence, speech end → dispatch | 803 ms (was 726) | 1082 ms (was 1118) | 1935 ms (was 1902) |
| All one-request results | 801–860 ms | 1082–1264 ms | 1888–2158 ms |
| Pauses joined (comma / two sentences) | ≤ 700 ms (was ≤ 450) | ≤ 700 ms | ≤ 1200 ms |

A fast answer now waits for the floor; slower answers are unchanged, as the
design intends. Pauses up to 700 ms join at every latency, and 1200 ms joins
only while a slow model is still running. The mid-sentence 1200 ms pause joined
at all latencies through the unchanged empty-transcript window. Shortcuts
dispatched at 801 ms, as before. The processing cue at gains 1, 0.3 and 0.1
never opened a candidate. A burst that opened and released a hold now restarts
the floor from the burst: 1281–1538 ms instead of about 1100 ms at LLM 700.
One quick run on one machine; the full matrix below was not repeated.

## Measured comparison (2026-09-25)

These measurements predate the 800 ms commitment floor; see the section above.

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
