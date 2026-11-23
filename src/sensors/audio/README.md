# Microphones and listening periods

Companion hears through one or more microphones at the same time: the
computer's own microphone, and one more for every paired browser that switched
on **Listen here** (browser shell). Everything after the microphone is shared
and unchanged: speech from a browser is recognised, routed and acted on exactly
as speech at the computer (decisions D1–D8 of the browser voice design). This
directory holds the listening side; the pipeline's part is in
[`src/core/pipeline.ts`](../../core/pipeline.ts), the control-socket protocol in
[the desktop guide](../../desktop/README.md#microphones-and-listening-browsers)
and the gateway's in [the remote guide](../../remote/README.md#listening-browsers).

| File                     | Responsibility                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `capture.ts`             | The computer's recorder (`pw-record`) or a file (`ffmpeg`), as 16 kHz frames (`pcmFrames`).                     |
| `network-source.ts`      | A browser's stream as the same frames, fed by `audio-chunk` pieces; bounded queue.                              |
| `listener.ts`            | One listening period: voice detector, segmenter, candidate events to the pipeline, for one microphone.          |
| `microphone-loop.ts`     | The computer's microphone loop: lost-capture retry and the Record hand-over (unchanged by several microphones). |
| `computer-microphone.ts` | The computer's microphone switch (D8) in front of that loop's periods.                                          |
| `browser-microphones.ts` | Listening browsers: one stream and one listening period per remote connection.                                  |
| `speech-indicator.ts`    | "Hearing speech" while any microphone hears speech.                                                             |

## Rules: microphones and periods

1. **Every microphone has its own listening period**: its own voice detector,
   segmenter and `listen` call. The computer's period runs in
   `listenToMicrophone` exactly as before (lost-capture retry, Record
   hand-over). A browser's period runs on its stream; a fresh voice detector
   is loaded when the stream starts and closed when its period has ended.
2. **All microphones that are on feed the same pipeline at the same time**
   (D2). Recognition, intent requests and routing stay one queue in order of
   arrival (the queue's overload rule — one utterance active, two waiting —
   is shared too; it counts distinct utterances: while a continued
   utterance's earlier attempt still finishes its recognition, its
   replacement waits at the front beside two other microphones' utterances). A browser's speech goes where the computer's goes and may do
   what it does (D3, D4): the conversation selected on the computer, typing
   into the window in front on the computer, the computer's screenshot.
3. **Pause stops every period** and cancels accepted work, as it always did.
   Each browser's stream ends with `paused`; the browser opens a new stream
   when the state says listening again. **Resume** starts the computer's
   period again (if its switch is on) once the work accepted before the
   pause has settled, as before; a browser's speech accepted after the Pause
   is not waited for (`SensorPipeline.idleForComputer`, with the cutoff taken
   at Pause by `pauseStarted`), also while the computer's old period is
   still unwinding, so it cannot keep the computer's microphone closed.
   Typed text is still waited for; without browser speech the wait is
   exactly the one from before. `audio-start` is refused while paused.
4. **The computer's microphone switch** (D8) turns only the computer's
   listening off or on. Off ends its current period like Record's hand-over:
   the open candidate is discarded, accepted utterances continue. On starts a
   new period unless paused. The switch lives for the listener's run and
   starts on, like the sound switch. Record still uses the computer's
   microphone while the switch is off (an explicit request for it), and only
   that microphone: browsers keep listening during a recording.
5. **A browser stream that ends simply ends its period**, whatever the
   reason: stopped by its page, replaced by a newer stream of the same
   connection, its connection closed (page closed, revocation, lost
   gateway), its queue full, its sound more than three seconds behind real
   time (`stalled`, with 1% of the stream's age allowed for clock drift, at
   most 10 seconds; sound sent ahead of real time counts for at most two
   seconds; so a stream ends at most 15 seconds after its last piece, at
   any age, and a browser whose sound clock runs 0.01% slow is ended after
   about 36 hours, after which it must start a new stream to go on
   listening: a phone's capture stopped, or it
   delivers far too little sound, while its page stays connected), its
   period failed, or shutdown. The stream's hold and "hearing speech" are
   released, and its unread sound dropped, the moment it ends, even while
   its voice detector is still loading or busy with a frame. The open candidate is discarded, also when the
   frame that would close it was still in the voice detector (the same now
   holds for Record's hand-over and for the computer's switch; before, a
   frame already in the detector at the hand-over could still close and
   submit its candidate); accepted
   utterances continue (only pause and shutdown cancel them). Ending one
   microphone's period never touches another microphone's candidate, hold or
   queue position. The three-second bound matters because one queue serves
   every microphone: an open candidate holds its microphone's attempt, and a
   stream that stopped sending would otherwise hold it, and everything queued
   behind it, forever.
6. **Limits on the listener's side** (the gateway enforces its own first,
   four streams): one stream per control connection (a second `audio-start`
   on it replaces the first); at most eight listening periods, counting
   those of ended streams whose voice detector is still loading or closing
   (so restarts never pile up detectors, and a takeover's new start never
   meets the old stream's stop still on its way); pieces of 2–8192 bytes of
   whole 16-bit samples; at most 5 seconds of sound, and one piece per 20 ms
   of that, waiting for a stream's voice detector (beyond that the stream
   ends as `slow`; sound is never dropped silently inside a stream).
7. **With the computer's microphone off and no browser listening, Companion
   hears nothing** and says so: the state's `microphones.listening` is empty.
   The computer is listed there only while its ordinary listening period
   actually runs: not while switched off, between a lost recorder and its
   retry, or while Record has the microphone. `microphones.computer` is the
   switch itself.
8. **"Hearing speech"** (`speaking`) is on while any microphone hears speech.
   With one microphone it is exactly that microphone's state, as before.
9. **The listener restarts**: every stream ends with its connection; the
   computer's switch is on again (it is not stored). Browsers start new
   streams after reconnecting.

## Rules: continuation per microphone

The pipeline joins speech that resumes after a short pause to the attempt
before it ([speech timing](../../../docs/speech-timing.md)). That state is
kept per microphone; everything else stays one queue.

1. `submit`, `speechResumed` and `speechDiscarded` name the microphone they
   belong to; without a name they belong to the computer's microphone, so
   callers from before (and every single-microphone path) are unchanged.
2. Each microphone has its own **newest** attempt and its own **held**
   attempt. Speech resuming on one microphone holds and may join only that
   microphone's newest attempt, never another's.
3. Speech from another microphone is **not** a boundary: it neither releases
   a hold nor prevents a merge on this microphone.
4. **Typed input is a boundary for every microphone**, admitted or dropped
   as overload, exactly as it was for the one microphone: every hold that can
   no longer change an outcome is released at once.
5. A rejected burst (`speechDiscarded` with its trailing silence) restarts
   the floor of that microphone's held attempt only. A period that ends
   (`speechDiscarded` without silence) releases only its own microphone's
   hold, leaving its deadlines unchanged.
6. A dropped utterance (queue full) is a boundary for its own microphone
   only: its later speech must not skip over it into an older attempt.
7. A continuation replaces its attempt at its queue position, or runs next
   if the attempt is already being processed. With several microphones,
   another microphone's later utterances wait behind it.
8. A microphone forgets its newest attempt once that attempt has settled
   (it can no longer be continued), so an ended stream keeps no audio or
   screenshot in memory.
9. **With one microphone the behavior is exactly what it was**: the existing
   pipeline, continuation and listener tests run unchanged, and
   `test/unit/pipeline-one-microphone-reference.test.ts` compares twelve
   scripted sessions with a trace recorded on the base revision.

## Stored audio

Stored audio follows the existing capture-storage switch
([guide](../../../docs/capture-storage.md)), with one rule for streams: a
browser's sound may have been captured and buffered in the browser before it
arrives, and no recorder clock bounds that on the computer. So a stream is
admitted like a file replay: once, when the listener accepts its
`audio-start`, before any of its sound is queued. A stream begun while
storage was off stays unsaved (turning storage on applies from the
browser's next stream, for example after Pause and Resume); turning storage
off revokes the admission at once, as for every capture. Nothing else is
stored for a stream: no raw stream, only what the computer's microphone
stores, under the same admission: each utterance's WAV and screenshot, and
the empty-recognition diagnostic clips (`asr-empty/…/audio.wav` and
`metadata.json`, see the [capture-storage guide](../../../docs/capture-storage.md)).

## Activity

Each Activity entry heard by a browser carries `microphone` with that
device's name (this run only; it is not stored in the database), so a
sentence heard twice by two microphones in one room is recognisable. The
listener does not detect such duplicates (D8 is the answer: switch one
microphone off).

## Known limits

- The queue bound counts waiting entries: while microphone A's utterance is
  still in recognition, its continuation and microphone B's utterance fill
  both waiting places, so a third microphone's utterance arriving then is
  dropped (logged as `dropped`), although only three utterances exist. Kept
  on purpose: it needs three microphones and one interleaving, and changing
  the bound risks the one-microphone overflow behaviour.

## Tests

- `test/unit/microphones-periods.test.ts`: the microphones-and-periods table
  through a real control socket, the test recogniser and synthetic audio.
- `test/unit/pipeline-microphones.test.ts`: the continuation-per-microphone
  table on a controlled clock.
- `test/unit/pipeline-one-microphone-reference.test.ts`: one microphone as on
  the base revision.
