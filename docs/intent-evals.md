# Intent detection evals

Run offline exports and isolated inference comparisons without restarting Companion.
The runner never imports sensors, routing, processors, history writers, or UI code.
It does not type text, execute detected actions, update feedback, or migrate SQLite.

## Exactness contract

Every example uses the saved `utterances.intent_request` plus its checksum-verified
PNG. This is the prepared provider payload, not today's reconstructed prompt. The
runner sends that JSON body directly to `/chat/completions`, changing **only the
`model` field**. System instructions, message roles/order, dynamic choices,
conversation context, screenshots, temperature, token limits, streaming and
provider flags remain unchanged. It never retries or silently converts a request.

Version 1 supports OpenAI-compatible chat-completions endpoints only. A model or
provider that cannot accept the recorded image/flags/settings produces an error;
there is no cross-provider prompt adapter. For fair comparisons choose targets
that accept the same request. An identical request does not guarantee identical
outputs, especially across changed server revisions or nondeterministic inference.

The stored endpoint is evidence only: runs use explicitly configured endpoints.
Reports contain hashes of both the fixed inputs (body without model) and each sent
body, plus the frozen dataset hash. This allows input-parity checks without copying
private prompts into reports. JSON whitespace is not preserved on the wire; JSON
values and prompt strings are preserved exactly.

## Inventory and export

From this checkout:

```sh
npm run eval:intents -- inspect --database ~/companion/utterances.sqlite
npm run eval:intents -- export --database ~/companion/utterances.sqlite \
  --out /path/to/new-private-dataset --limit 100
```

The database is opened read-only and must already have schema 5. Inspection shows
metadata counts, not recordings. Export considers examples oldest first, breaking
ties by UUID, and limits successfully exported examples (default 100). It accepts
both kinds of explicit feedback:

- **Correct:** the explicit actual intent, or the prediction captured by correct
  feedback when that label has no actual-intent field.
- **Incorrect with a corrected intent:** that explicit corrected class.

Incorrect without a correction, unlabeled, and missing-request rows are not scored.
Legacy rows and shortcuts may have labels but no recorded LLM request. They cannot
be exact-replay fixtures and are never reconstructed from current instructions.

Export freezes the selected requests, labels, original predictions, and PNGs into
a new private directory. It refuses existing directories. Missing, modified,
duplicate-across-date-buckets screenshots and labels absent from the recorded
registered intent list are skipped with reasons in `export-report.json` and stdout.
A label that names a historical dynamic intent remains valid if that name appears
in the recorded system prompt. The exporter does not consult today's registry.

`dataset.json` and UUID-named PNGs are sensitive: they contain recorded utterances,
window/context information and screenshots. Keep them outside Git. Directory mode
is 0700 and file mode is 0600 (subject to a more restrictive umask). Exports are
independent copies: deleting live history does not delete an exported dataset.
Delete exports separately when no longer needed. Do not casually share them.

## Compare models

Create `targets.json` with explicit endpoints and model IDs:

```json
[
  {
    "name": "baseline",
    "model": "baseline-model-id",
    "baseUrl": "http://localhost:8000/v1",
    "timeoutMs": 30000,
    "concurrency": 4
  },
  {
    "name": "candidate",
    "model": "candidate-model-id",
    "baseUrl": "https://your-authorized-provider.example/v1",
    "apiKeyEnv": "EVAL_PROVIDER_KEY",
    "timeoutMs": 30000,
    "concurrency": 1,
    "pricing": { "inputPerMillion": 0.5, "outputPerMillion": 2 }
  }
]
```

Use an environment variable for authentication; never put credentials into a URL
or targets file. Only specify `apiKeyEnv` when needed. Endpoints must not contain
query strings, fragments, or embedded credentials. Redirects are refused.

```sh
npm run eval:intents -- run --dataset /path/to/dataset/dataset.json \
  --targets targets.json --out /path/to/new-report.json --send
```

**`--send` authorizes sending the dataset's private text, captured conversation
context and screenshots to every configured endpoint.** Inspect targets first.
Nothing is sent during inspect/export. The runner validates every target, image and
label before the first call. No SDK request rewriting or retries occur. The default
timeout is 30 seconds per request.

## Concurrency and scheduling

Targets run **one after another in isolated batches**, in the order listed. Within
a target's batch, at most `concurrency` requests (integer 1–16, default 1) are in
flight. Two targets never have requests in flight at the same time, so one
target's load cannot inflate another target's latency or throughput. Each request
still sends the exact recorded body with only `model` changed; concurrency never
alters the prompt, flags or streaming mode. A request's timeout starts when that
request is sent, not while it waits for a free slot. Examples are restored from
disk (checksum verified) just before sending, so at most `concurrency` restored
screenshots per target are held in memory.

Choose concurrency per endpoint. A local vLLM server can batch parallel requests
(4 is the approved starting point for the local Qwen target); cloud providers may
rate-limit. The client limit does not stop the server from queueing admitted
requests internally; that shows up as higher per-request latency.

Results are stored by position, not completion order: each report lists exactly one
result per example and target, target by target in dataset order, and fingerprints
depend only on the body. Running the same targets in a different order or with a
different concurrency produces the same result records and hashes; only timings,
and nondeterministic model outputs, may differ.

To measure speedup on the same frozen dataset and endpoint, list the same model
twice under different names:

```json
[
  { "name": "qwen-c1", "model": "MODEL", "baseUrl": "http://127.0.0.1:PORT/v1", "concurrency": 1 },
  { "name": "qwen-c4", "model": "MODEL", "baseUrl": "http://127.0.0.1:PORT/v1", "concurrency": 4 }
]
```

The later batch may benefit from a warmer server (prefix/image caches, compiled
kernels), and other traffic on the server confounds both. Consider a second,
separate run with the target order reversed and compare both reports; the runner
never repeats a pass on its own.

The first target is the comparison baseline. Existing reports are never overwritten.
An output file is reserved before any call; failures leave an explicit failure
report. Ctrl+C/SIGTERM stops scheduling new requests, aborts every active request
and waits for them to settle before writing the failure report. Partial results
are not saved. A fatal (non-request) error during a batch does the same. A run
with per-request errors writes a complete report but exits nonzero; classification
mistakes alone are valid eval results and do not make the command fail. Fatal
validation/interruption reports do not claim a completed score.

## Results and limitations

The JSON report (version 2) contains per-example predictions/errors, expected class,
original recorded prediction, request fingerprints, latency and usage, the resolved
target settings including `concurrency` and `timeoutMs`, the total run `wallTimeMs`,
plus per target:

- Target name, model and concurrency.
- Overall accuracy with errors included in the denominator.
- Confusion counts (expected → predicted, with `<ERROR>` for failed responses).
- Batch timing: wall time of the target's batch and throughput in requests per
  second, for all requests and for successful ones. This is the number that
  concurrency is meant to improve. Throughput speedup is the ratio of two batches'
  `requestsPerSecond`, not the ratio of their latencies.
- Per-request latency (mean/p50/p95, nearest rank), measured from sending the
  request to reading the whole response or failing, including queueing inside the
  server. `allRequests` includes errors (fast refusals and slow timeouts both count);
  `successfulRequests` includes only valid intent-name responses. Latency per
  request can rise with concurrency even while throughput improves.
- Regressions/improvements versus the first target, and regressions versus the
  original recorded prediction.
- Estimated cost only when both token usage and explicit target pricing exist.
  Missing usage is **null**, not zero. Prices use the currency you supply; cached,
  reasoning, tiered and other special billing rates are not modeled. Do not label
  the estimate a provider invoice. Recorded streaming flags may omit usage; the
  runner will not modify those flags merely to obtain cost estimates. Current live
  recordings stream without usage options, so expect null cost for them.

Only normal `stop` completions containing a registered intent name are accepted.
Tool calls, reasoning output (including `reasoning_details`), refusals, truncated
responses and unknown names are errors, like the live detector's intent-name-only
contract. The eval is slightly stricter than live pi-ai parsing: streams must end
with `[DONE]` and `finish_reason` must be `stop` (pi-ai also accepts `end` and a
stream without `[DONE]`). vLLM and llama.cpp send both. HTTP error bodies and
invalid-JSON snippets are not saved because they can echo private inputs. Reports omit prompt/image
content, but UUIDs, dynamic intent names and endpoint metadata can still be private.

A small hand-labeled set is a regression suite, not an unbiased population estimate.
Do not tune on all examples and then call the same examples held-out validation.
Keep a separately reviewed, disjoint test dataset for model selection; this first
version does not automatically split, relabel, or expand your dataset. Re-exporting
captures current labels; existing exported labels never change behind your back.

## Validation

```sh
npm run check
npx tsx --test test/unit/intent-evals.test.ts
npm test
```

Tests use synthetic recordings, temporary databases and local HTTP fixtures. They
verify request-body parity, correct-label inclusion, missing-evidence handling,
checksum preflight, privacy modes, HTTP failures/no retries, timeouts/cancellation,
stream parsing, scoring, cost nullability and safe CLI defaults. Concurrency tests
count overlapping requests on a real local HTTP server (exactly 1 at concurrency 1,
exactly 4 at concurrency 4, never two targets at once), and cover out-of-order
completion, per-request errors/timeouts, and cancellation without later scheduling. Passing these tests
does not establish any particular model's accuracy or live-provider compatibility.
