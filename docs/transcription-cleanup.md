# Automatic transcription cleanup

Status (2026-09-25): implemented on `feat/transcription-cleanup` so Tijs can
try it and judge how it feels. It is **off by default**. The cleaned text's
quality was never human-scored; nothing here claims it is better than the raw
transcript.

When the switch is on, the text that the five text routes receive is the local
model's cleaned-up version of the transcript: filler words, false starts and
repetitions removed, punctuation and capitalization corrected. With the switch
off, Companion behaves exactly as before and sends byte-identical intent
requests.

## Using it

- **Switch:** Activity → Intentions → **Clean up transcriptions**, above the
  intent and shortcut cards. The chip follows the listener's acknowledged
  state; it never flips optimistically. It is hidden when the listener has no
  cleanup support (an older build).
- **Saved choice:** `~/companion/transcription-cleanup.json` (beside the
  database, mode 0600), `{"version":1,"enabled":true}`. A missing file means
  off. A malformed file stops the listener at startup instead of guessing.
  Without the desktop service (`--no-desktop`) cleanup is always off.
- **Reverting:** click the switch off; the next utterance uses the raw text.
  Deleting the file, or starting any older checkout, has the same effect.
- **Timing:** the switch is read once when an utterance starts routing. A
  click while an utterance is being processed applies to the next one.

## What happens per route

| How the route was chosen                                                                                    | Cleanup                                                                                                           | Model calls                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Inferred (the intent detector chose SEND, START or CONTINUE)                                                | The detector's single request asks for JSON with the intent **and** the cleaned text.                             | One, as before, with a longer answer. |
| Explicit shortcut for a text route (`insert`, `enter`, `quick question`, `new session`, `continue session`) | A separate cleanup-only request after the prefix is stripped. The route is fixed by the prefix and never changes. | One extra call.                       |
| Anything else (IGNORE, choices, labels, `close session`, `go to session`)                                   | None; these take no text.                                                                                         | Unchanged.                            |

Application-aware formatting uses the screenshot and application metadata only
for `SEND_TEXT_TO_APPLICATION`. The other routes get only the shared cleanup
instruction; their cleanup-only request contains no screenshot or metadata.

### Prompts

All live wording is in [`src/core/transcription-cleanup/prompt.ts`](../src/core/transcription-cleanup/prompt.ts):
the cleanup instruction, the SEND formatting instruction (the approved wording,
byte for byte), the response section appended to the detector prompt, and the
fixed-route prompt. It is the `json-cleanup-v1` wording from the
[offline experiment](intent-json-cleanup-experiment.md). The experiment imports
the same strings, and its tests pin the json-cleanup-v1 prompt hash. Editing any
wording therefore fails those tests on purpose: rename `CLEANUP_PROMPT_VARIANT`
so recordings and eval reports never mix two wordings under one name.

For inferred routes the live request is exactly the experiment's
transformation of today's bare-name request. The two bare-name sentences are
replaced, the response section is appended and `max_tokens` becomes 512. A test
checks this against `transformRecordedRequest` from the experiment.

### Strict responses and fallbacks

Responses are validated by the experiment's parser, unchanged
(`parseExperimentResponse`, json-cleanup-v1 contract). The response must be one
bare JSON object with exactly `intent` and `parameters`. Code fences, prose, a
BOM, duplicate or extra keys, wrong types and unknown intents are invalid. A
text route needs nonempty `text` without leading or trailing whitespace.
Nothing is repaired.

| Situation                                                                                                                                  | Result                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inferred, fully valid                                                                                                                      | The intent, with the cleaned text for a text route.                                                                                                  |
| Inferred, valid object and offered text route, but its `text` is missing, not a string, empty or has surrounding whitespace                | That intent with the **raw** transcript (`fallback`, reason stored).                                                                                 |
| Inferred, no usable intent (malformed JSON, duplicate/extra keys, unknown or unoffered intent, wrong parameters, text on a no-text intent) | A detection failure, exactly like today's invalid intent response: logged, `error` outcome, nothing delivered. The error names only the reason code. |
| Inferred, timeout/transport error/truncated output                                                                                         | A detection failure, as today (`llm.timeoutMs`, default 15 s).                                                                                       |
| Shortcut cleanup: any invalid response, including `route-changed` (a different or no-action intent)                                        | The **raw** text after the prefix, on the same route.                                                                                                |
| Shortcut cleanup: timeout (**8 s**, `SHORTCUT_CLEANUP_TIMEOUT_MS`), HTTP error, truncated output                                           | The **raw** text after the prefix, on the same route.                                                                                                |
| Pause, shutdown or disabling the route during either call                                                                                  | Nothing is delivered (cancellation, not a fallback).                                                                                                 |

Partially cleaned text is never delivered: text is either the complete valid
cleaned text or the raw transcript.

The shortcut timeout of 8 s is bounded and independent of the detector timeout.
The measured json-cleanup-v1 latency on the local Qwen was about 2.8 s per call
(bare-name about 1.8 s). The margin covers long dictation up to the 512-token
output budget. Later utterances wait behind this call, as they already wait
behind intent detection. Dictation longer than the output budget ends truncated
and falls back to the raw text.

### Safety

- **Routes cannot change.** Inference can only pick an offered intent. The
  shortcut-only routes (`ENTER_TEXT_TO_APPLICATION`, `QUICK_QUESTION`) are never
  offered, and the router still refuses any unregistered answer. A shortcut's
  cleanup result carries text only; an answer naming another route is refused.
- **Prompt injection:** the prompts treat the utterance, application metadata
  and screenshot as data. The contract makes it impossible for an instruction
  in the screenshot to add actions or keys. Whether a model resists injected
  wording is a model-quality question. It is not measured here.
- **ENTER never gains a trailing newline.** Surrounding whitespace in `text` is
  refused, so a trailing line break falls back to the raw text. Control
  characters, including internal line breaks, are still replaced by spaces
  before typing (unchanged keyboard safety), and Return is pressed once, only by
  the Enter processor.
- **Line breaks for SEND are flattened.** For the same reason, paragraphs or
  list line breaks the model adds for an email are typed as spaces. Typing real
  line breaks safely (for example as Shift+Enter) is a separate product
  decision, not part of this change.

## History

The raw transcript stays in `utterances.transcript`, unchanged. Each routed
utterance also gets the following nullable columns:

| Column             | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `cleanup_enabled`  | 1 on, 0 off, NULL unknown (older rows or older checkouts, or never routed) |
| `cleanup_status`   | `cleaned`, `fallback` or `no-text` while on                                |
| `cleaned_text`     | the text a text route received instead of the transcript                   |
| `cleanup_fallback` | reason code when the raw text was used although cleanup was on             |

The columns are additive. The schema version stays 5, so every older checkout
still opens the same database and ignores them. Deleting an utterance deletes
them with its row.

Activity history cards keep the raw transcript as their main text. When cleanup
cleaned a text route, the card shows **Cleaned: …** below it and offers **Copy
cleaned** next to **Copy**; a fallback shows its reason. **Insert** and **New
coding session** from history still use the raw transcript, as before.

## Evaluation data

The intent-request recorder marks the prompt that produced a request:

- cleanup off: the unchanged version 1 record;
- cleanup on: a **version 2** record with `"promptVariant": "json-cleanup-v1"`.

`npm run eval:intents -- export` (exact replay of the bare-name prompt) skips
version 2 recordings with a stated reason, and a dataset containing one fails
before any model call. Older checkouts refuse version 2 as unsupported rather
than treating it as a bare-name recording. `inspect` counts them as
`recordedWithCleanupPrompt`. Shortcut cleanup calls are not recorded; shortcuts
never had an intent request.

## Limitations

- Cleanup quality is not measured or claimed.
- Each shortcut to a text route makes one extra local model call (latency).
- The live requests use the same adapter flags as the detector. For Qwen this
  includes `preserve_thinking: true` next to `enable_thinking: false`, which
  the offline fixed-route experiment requests did not send.
- SEND formatting line breaks are typed as spaces (see Safety).
- Cleanup covers speech and typed Activity text routed through the pipeline;
  conversation composer text goes straight to its conversation and is never
  cleaned.
- No automatic retry with the bare-name prompt after a failed cleanup detection.

## Validation

```sh
npx tsx --test test/unit/transcription-cleanup.test.ts
npm test
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
```

The tests use synthetic text and local fake servers. They pin the switch-off
wire request and recording to master's bytes. They check that the switch-on
request equals the experiment's transformation, and they cover strict parsing,
fallbacks, route immutability, cancellation, ENTER typing, history columns, the
exact-replay export and the desktop switch.
