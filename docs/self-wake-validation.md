# Self-wake validation

Run with checkout dependencies (`ONNXRUNTIME_NODE_INSTALL=skip npm ci` on CPU-only
machines). Everything below uses temporary synthetic data and scripted backends:

```sh
npm run check
node --import tsx --test test/unit/self-wakes*.test.ts
node --import tsx --test --test-concurrency=4 test/unit/*.test.ts
QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test/panel
npm run ui:build
npm run test:window
npm run format:check
git diff --check
```

No production listener, model turn, installed adapter or real timer is needed.
The focused timer suite is also a reproducible synthetic demonstration: it
advances an injected UTC clock, admits scripted same-conversation turns, cancels
queued ones and reconstructs the store across listener lifetimes.

## Acceptance map

| Accepted scenario | Synthetic coverage |
| --- | --- |
| 1. Pi/Claude parity, positive capability gating | `self-wakes`: shared schemas and leased adapter execution; `session-tools-compatibility` and `claude-bridge`: child process/config propagation and older listeners |
| 2. Current lease, forged owner, cross-owner isolation | `self-wakes`: unknown owner arguments, expired lease, foreign cancellation; `session-tools`: lease revoked during body arrival |
| 3. Process-independent persistence and durable cancellation | Separate scheduler/store reopen after schedule and cancel; session shutdown/restart test |
| 4. Receipts, replacement and old IDs | Durable retry, atomic replacement rollback on injected disk failure, old-ID cancellation and running predecessor/successor |
| 5. Review before due | Real leased cancellation; zero wake turns |
| 6. Review while due and queued | Busy session plus ordinary FIFO; reply cancels before dispatch |
| 7. Cancel/dispatch race | Controlled asynchronous preparation gate versus cancellation; post-claim returns dispatch-started |
| 8. Capacity and expiry | Four agents, eight ordinary messages, 16 tabs, per-owner/global pending caps and visible grace expiry |
| 9. Stop/close/hide/shutdown | Active lease revocation, late callback refusal, explicit close, restart preservation; QML draft/selection retention |
| 10. Restart/crash boundaries | Scheduled, claimed and started store reopen; failed display admission; failed terminal save after simulated backend effects; no automatic replay |
| 11. Suspend/clocks/offsets/long waits | Injected forward/backward jumps, clock reversal during preparation, explicit offsets, 30-day deadlines and grace |
| 12. Missing owner/history/model/config/corrupt data | Owner instruction deletion, missing native transcript error, unavailable catalog, malformed configuration, corrupt-row quarantine and exclusive store ownership |
| 13. Rearm/ancestry/limits | More than three successive occurrences, active same-key successor, preserved depth, self-wake attribution, pending limits and Stop revocation |
| 14. Terminal backend failures | Scripted provider failure and missing resume; ordinary predecessor quota/policy/runtime/exception cases block pending work |
| 15. No live side effects | Injected clocks, temporary directories, scripted backends; offscreen UI only; no screenshot in wake request |
| 16. Ordinary restore remains dormant | Existing `session-store`, `agent-sessions` and lazy-tool restart tests; timer projection excluded from transcript persistence |

The `self-wakes-races` suite preserves the independent R1 reproductions and adds
multi-candidate cancellation/replacement/Stop/block/expiry across owners, failed
Stop/close/block writes before and during preparation, explicit recovery across
restart, intervening ordinary turns, and absolute receipt replay after reopen.

## Delivery limits to review

The durable claim is the cancel boundary, before display history persistence
and backend invocation. A crash anywhere after it can miss a wake, but cannot
cause an unproven automatic replay. A `started` marker means backend invocation
was about to begin; it does not prove provider completion. A failed terminal
save leaves the last durable transition visible and becomes uncertain at restart.
There is no exactly-once claim for arbitrary external tool effects.

The scheduler checks clocks once per second. Suspend pauses execution; resume
re-evaluates due and expiry. Capacity does not extend grace. Harness resume checks
may require starting the harness process, but must reject missing native history
before sending the scheduled prompt. Tests cover the existing resume checks with
synthetic processes; they do not establish actual provider availability.

Failed single-ID cancellation (including post-dispatch intent), Stop/close or
failed-predecessor timer writes halt **all wake admission and
new scheduling in that listener**, including already prepared work. Ordinary
user-requested turns remain available. The warning and rejected cancellation do
not claim a durable write: the last committed timer state can become eligible
again after restart if no saved owner error blocks it. Repair storage, inspect
pending timers and retry cancellation successfully before restarting. A successful
retry persists cancellation but does not automatically clear the listener's fault.
Listener shutdown alone still preserves pending timers; it is not human close.

Store corruption fails closed; invalid rows are quarantined, whole-database
failure refuses ownership/startup. The UI is a bounded native list (20 recent
terminal entries), not a full global management dashboard. Deleted saved owners
are reconciled at startup; any future explicit conversation-deletion API must
call `wakes.deleteOwner` as part of deleting owner data. Closing a tab archives it
and cancels timers; it is not deletion.

Independent review must cover the exact combined backend/tool/native UI revision.
A later real provider smoke test needs its own bounded plan and authorization,
and does not follow automatically from passing these tests or a clean review.

## Capture-storage compatibility

`self-wakes-capture` uses the shared Pi/Claude harness fixture to exercise
background restoration while capture storage changes, preserving each original
message's saved/not-saved provenance. It inventories PNG/WAV bytes before and
after wake dispatch, gates a revoked first-turn PNG publication, checks ordinary
reply priority, and exercises desktop labeling refusal alongside timer
cancellation. The shared offscreen panel test renders both capture provenance
and scheduled-wake attribution while retaining draft/selection and cancellation.
The existing capture-storage suites continue to cover default-off, label and
publication boundaries, including old-client/phone restrictions.

`self-wakes-cancel-failure` exercises native and leased cancellation failures
before/during due preparation, persistent listener inhibition after storage
repair, visible warnings, explicit cancellation retry across restart, and
post-dispatch intent failures without aborting active or ordinary turns. Both
harnesses retain ordinary work and capture-policy independence. Unknown/foreign
IDs and validation refusals do not fault a healthy scheduler.

## Paged-history compatibility

`self-wakes-paging` combines both harnesses' live and background-restored wakes
with more than 4,000 retained rows and 1M UTF-16 units. It checks lossless
history paging, bounded ordered deltas, stable lifetime tokens, dormant ordinary
messages, old tool-group anchors, live canonical pin projection and image-free
scheduled turns. Timer notices are reconciled by ID in full authoritative history;
only display pages are bounded. A saved service warning is updated rather than
duplicated when its owner reopens.

The shared history QML regression retains frozen pages and drafts while timer
states/cancellation update, and rejects stale replies after a new lifetime.
Gateway and phone history fixtures schedule/cancel real leased synthetic timers
while exercising old-page URL sanitization, canonical pins and draft retention;
remote timer writes remain refused. These fixtures use no production transcripts,
providers, capture devices or installed clients.
