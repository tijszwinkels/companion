# Session applications

A session application replaces one conversation's HTML chat with an authored
bundle. The conversation keeps its ID, agent, history and unsent draft; the
application adds durable state, typed read-only queries and targeted actions
that the user (through the view) and the conversation's own agent (through its
tools) share. Applying or replacing an application never starts a model turn or
creates another conversation.

The backend reuses the widget runtime: the same loopback service, guarded
library loader, retained SHA-256 bundles, per-conversation operation queue,
turn-scoped agent leases and isolated Chromium renderer. Authored JavaScript
never runs in the listener or in an agent extension.

Status: first implementation path. The types in [types.ts](types.ts) are the
contract shared with the UI; this file documents the wire protocol.

## Descriptor

`AgentSession.application` (type `SessionApplicationDescriptor`) is present on
snapshots and patches while the conversation has an application. Absence means
trusted HTML chat. Patches replace the whole session object, so a patch without
it means there is none. It is live-only and never saved in the conversation
archive; the application's own record is the durable source.

| Field         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | Stable UUID, kept across code replacement.                                     |
| `name`        | Library bundle name of the current code.                                       |
| `version`     | Code version: 1 on first apply, +1 per replacement. Host-assigned.             |
| `revision`    | State revision: +1 per committed state change.                                 |
| `viewUrl`     | Desktop-only view capability, `http://127.0.0.1:<port>/view/<64 hex>`.         |
| `text`        | The bundle's readable text description (1–4000 characters).                    |
| `eventMode`   | `immediate` (default) or `next-input`; see [Events](#user-edit-events).        |
| `eventStatus` | Delivery state of user-edit events (display only).                             |
| `chatAccess`  | Desktop-only requested capabilities, read/send status and permission revision. |
| `error`       | The saved application could not be restored; `viewUrl` is absent, data kept.   |

When `error` is present the saved record could not be used. If the file is
unreadable, `id` and `name` are empty and `version`/`revision` are 0. The file is
left unchanged and `companion_app_apply` refuses to overwrite it; the
conversation's chat and history stay available.

`viewUrl` stays the same when code is replaced; the open view reloads itself
when it sees a new `version`. Closing the conversation revokes it; reopening
issues a new one. The phone gateway removes `viewUrl` and `chatAccess`. Agent
tools never receive the view capability or the trusted permission-control revision.

## Bundles

An application bundle is an ordinary widget-library directory (`widget.json`,
`widget.js`, `style.css`, same symlink-refusing loader and size limits) whose
manifest also contains an `application` object:

```json
{
  "name": "task-board",
  "version": 1,
  "description": "Tasks grouped in columns",
  "application": { "eventMode": "immediate" },
  "parameters": { "type": "object", "properties": { "tasks": { "type": "array" } } },
  "actions": {
    "move_task": {
      "description": "Move one task to another column",
      "parameters": { "type": "object" },
      "returns": { "type": "object" },
      "agent": true
    }
  },
  "queries": {
    "list_tasks": {
      "description": "Tasks in one column",
      "parameters": { "type": "object" },
      "returns": { "type": "object" },
      "agent": true
    }
  },
  "example": { "tasks": [] }
}
```

`parameters` is the state schema. `actions` mutate state; `queries` only read
it. Both use the bounded widget schema subset for arguments and results and are
limited to 20 each. `agent` (default `true`) exposes a query/action to the
agent; `false` keeps it view-only. `application.eventMode` is the default event
mode for a first apply. `application.capabilities` may request `chat.read` and
`chat.send` (no duplicates, at most two). A declaration is **not** consent.
Reading and sending use separate native consent controls. The authored sender API
retains a handle before admission and offers read-only receipt lookup after uncertainty.
See [optional chat](#optional-chat-read-checkpoint) and [sending](#sending-backend).

`widget.js` exports:

```js
export function describe(state) {} // readable text, 1–4000 characters
export const actions = {
  move_task(state, args, { requestId }) {
    return { props: state, result: {} };
  },
};
export const queries = {
  list_tasks(state, args) {
    return { tasks: [] };
  },
};
export function mount(root, api) {
  return { update(state) {}, dispose() {} };
}
```

Reducers follow the widget rules (cloned inputs, deterministic, no DOM side
effects, throw to refuse). A query handler receives a cloned snapshot; its
return value is validated against `returns` and its changes are discarded.

## Browser API (inside the restricted view)

- `api.state.read()` → `Promise<{revision, data}>`, the current saved state.
  Simultaneous reads share one request (at most eight waiting), so a read may
  answer with state up to one round trip old.
- `api.state.subscribe(callback)` → unsubscribe function. `callback({revision,
data})` runs after each observed revision change. The view host polls
  `GET /state` every 400 ms while the page is visible (no polling while
  hidden), so a change may take up to about half a second to appear.
- `api.query(name, args)` → validated query result.
- `api.call(name, args)` → validated action result, after persistence.
- `api.chat.read()` → the complete bounded text snapshot described below. It
  accepts no arguments and rejects without observed read consent, while hidden,
  or on refusal. Up to eight callers share one request and the action/query/state
  request budget. Calls within 400 ms may receive that recent cached snapshot.
- `api.chat.subscribe(callback)` → unsubscribe function. Immediately reports
  `{available:false, snapshot:null, error:""}` before access is observed, then
  reports `{available, snapshot, error}` on permission/content changes. `snapshot`
  is null until the first read or after withdrawal; otherwise it is a complete
  window, never a token delta. At most 32 callbacks share one host subscription.
  The host polls every 400 ms while visible and subscribed, supplying the code
  version and digest itself. No caller may pick another conversation or cursor.
  Observed revocation, hidden pages, failed reads and code changes clear the host
  cache and invalidate in-flight delivery. Permission/state refresh is required
  before reading resumes. Already delivered copies cannot be erased.

- `api.chat.prepareSend()` → `Promise<{version, grantId, requestId}>`. Gets fresh
  sending status and returns a frozen handle while the view is visible and a
  grant has remaining quota. It does not reserve, send, consume quota or grant
  permission. Retain this handle **before** calling send.
- `api.chat.send(handle, text)` → host receipt. Sends nonempty text of at most
  4000 UTF-16 units with exactly the retained handle. A queued receipt is not
  proof of execution or completion. See [receipt states](#capability-protocol).
- `api.chat.receipt(handle)` → host receipt or `null`. Read-only lookup; it never
  admits or retries a message. Missing status is **not** proof of no execution.
  Neither sending nor probing needs read permission. Existing handles can be
  probed after revoke/renewal, but not after code replacement or reopen.

Sender calls share the eight-operation budget. Host requests have an abortable
10-second timeout; frame requests also time out after 12 seconds if the host
reply is lost. These are browser timers, not execution deadlines. Errors/timeouts
are not proof of non-admission or cancellation. Keep the original handle and
inspect its receipt; never automatically resend, manufacture a new request ID,
or prepare a fresh handle to retry uncertainty. Explicit exact retries deduplicate
on the original grant/request pair; changing the text with that identity is refused.
Applications that need recovery after a view reload must retain the handle before
sending (for example through their own declared state action). This API does not
persist it automatically, and code replacement/restart can make status unavailable.

The view keeps the widget iframe sandbox and CSP: no network, storage, nested
frames, workers, microphone or other browser permissions. It has no access to
the draft, native window commands or other sessions. History and app-origin
sending are available only through separately consented bounded APIs. These
methods do not themselves grant permission or persist text into application state.

## View HTTP protocol

All requests go to the loopback widget service; Host and Origin must match it.
The trusted host page bounds what authored code can ask of it, including
messages posted directly: at most eight outstanding requests (actions, queries
and shared state/chat reads plus sender preparation/send/probes), reply IDs of 1–100 characters (others are
ignored, never echoed), operation names of at most 48 characters, and JSON
arguments of at most 32 KiB. Non-JSON arguments (for example cyclic objects)
are refused with an answer, so they never hold a request slot.

| Request                       | Body / response                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `GET <viewUrl>`               | Trusted host document with the bundle inside a sandboxed iframe.                           |
| `GET <viewUrl>/state`         | `SessionApplicationStateResponse`.                                                         |
| `POST <viewUrl>/action`       | `SessionApplicationActionRequest` → action result + `id`, `revision`.                      |
| `POST <viewUrl>/query`        | `SessionApplicationQueryRequest` → `{result, revision}`.                                   |
| `POST <viewUrl>/chat-read`    | `{version, after?}` → bounded changed snapshot or unchanged revision; read grant required. |
| `POST <viewUrl>/chat-send`    | `{version, grantId, requestId, text}` → host receipt; separate finite grant required.      |
| `POST <viewUrl>/chat-receipt` | `{version, grantId, requestId}` → read-only receipt or unknown/null; never admission.      |

The native profile maps `companion-widget://view/` onto `viewUrl`. It forwards
only document/state GETs and action/query/chat-read/chat-send/chat-receipt POSTs
to that exact capability.
It never forwards permission-grant operations. Sending and receipt probes have
separate fixed routes and stricter bounds described below. Chat-read request
bodies are capped at 1 KiB and replies at 64 KiB; other operation bounds stay
unchanged. The portable Chromium broker admits the same fixed chat POST routes
with identical chat request/response limits, scoped to the view capability and
without redirects or grant routes. Non-200 backend replies become generic fetch failures in Qt, never
successful empty history. A refused chat read does not disable the whole view.
`version` mismatches are refused (`409`), so a view running replaced code cannot
execute successor actions. An action request from this view ingress is a
**user** edit; origin is never read from the body. Chat reads are non-mutating.

## Optional chat (read checkpoint)

Read consent is shown in native controls below the app's trusted escape bar in
both sidebar and pop-out HTML surfaces. It enables the gated iframe read API,
not chat sending. Sending uses its own native controls and the separately granted
sender API.
The application remains able to show app-only content. Canonical trusted chat,
its escape bar and the trusted draft remain separate from authored content.

### Consent and lifetime

`chatAccess` contains `{requested, read, send, revision}` (`send` is absent on older
hosts and otherwise contains `{grantId, allowed, remaining, busy}`). A trusted desktop client
uses `set-application-chat-read` with `{id, applicationId, version, revision,
allowed}`. The conversation must still be shown by that non-remote desktop
connection when the command is admitted **and** when its queued mutation runs.
The application ID, code version and permission revision must still match.
The new permission revision is returned. Agents' tool dispatch and application
view dispatch have no grant operation. Declaring `chat.read` is required before
it can be allowed; grants never start a model turn or change application state.

Grants are memory-only, tied to this open conversation and exact application
ID/version/bundle. Closing/reopening the conversation, restarting the listener,
or successfully replacing code resets them, even for identical code or capability
names. Failed code replacement does not reset the current grant. State edits
and hiding/showing the view preserve it. Permission revisions change on each
permission change and reset, rejecting old consent confirmations.

The grant's disclosure must say that it includes **recent earlier conversation
text**, not just messages after installation. The app can copy that text into
its own persisted state, actions or agent-visible events. Network restrictions
do not prevent this onward disclosure. Revoking stops future reads; it cannot
recall copies. A read already admitted before revocation may still finish.
Read and send are separate grants; reading does not authenticate an application
composer as a person.

This is a trusted-UI / authored-code / agent-tool boundary, not an OS security
boundary against same-user native processes that can control Companion's local
IPC. The existing local-process trust assumptions still apply.

`SessionView.appChatPermissionControl` is the native consent component, mounted
by `SessionSurface`. Its transport defaults off; `WindowContent` and
`PopoutWindow` explicitly wire `appChatPermissionRequested` through the native
Client and `receiveAppChatPermissionResult` back to the owning view. No page
QWebChannel or iframe grant operation is added. It offers
review → allow and direct revoke, wraps/scrolls at narrow widths, and supports
keyboard activation. Pending requests are single-flight, never replayed after a
timeout. Descriptor identity changes discard old confirmations/replies, and
only canonical descriptors change the displayed permission. The component does
not access the draft or become a bridge exposed to authored code.

### Read requests and bounds

`POST <viewUrl>/chat-read` accepts only `version` and an optional `after` digest
(64 lowercase hexadecimal characters). It never accepts a conversation ID,
permission flag, arbitrary limit or historical-page cursor. The owning view
capability scopes the request. After reading its body and entering the shared
operation queue, the service rechecks the open owner, capability, version and
read grant; delayed old requests cannot cross revocation or close/reopen.

The result is either `{changed:false, revision}` or a full replacement snapshot
`{changed:true, revision, status, truncated, messages}`. Each message has `id`,
`role`, `source`, `text`, `state` and `truncated`. IDs identify streaming row
replacements. `status` is the canonical conversation status, including running,
completed, cancelled and error. No per-row timestamps are invented: the existing
canonical records do not retain them.

- At most 24 user/assistant text rows from the last 256 canonical rows.
- At most 8192 UTF-16 units per row, keeping the newest suffix on truncation.
- At most 48 KiB of JSON-encoded rows and 64 KiB for the response. Escaping and
  metadata count; Unicode surrogate pairs are not split at truncation boundaries.
- Tools, notices, widgets, attachment URLs/bytes and input fields are excluded.
  Non-human user-kind rows carry non-human source labels; unknown retained origins
  are labelled `unknown`, not `human`.
- One successful source read per 250 ms per open application, enforced by the
  backend even for raw requests. Too-frequent requests return 429. Revoked reads
  return 403, stale versions 409, missing views 404, malformed requests 400.
- `revision` digests the bounded projection. Unchanged polls omit history.
  Changed responses replace the entire prior window, including removals; they
  are not append-only token deltas.

`GET /state` reports `chatReadAllowed` so the host bridge can expose or
withdraw optional read delivery. That flag is informational, never authorization.
The read service never implicitly writes its projection into app state.

## Sending backend

The authored API is `prepareSend()` → retain handle → `send(handle, text)`;
use `receipt(handle)` to inspect outcomes, never an automatic retry. Native
controls and both view transports enforce the backend contract below.

Native sending consent has its own disclosure and explicit allow-five/renewal
step, independent of reading, plus direct revoke and canonical quota/busy status.
Confirmations bind code and permission identity, share one pending mutation and
never change displayed permission optimistically or retry on timeout. A missing
sender descriptor on an older host disables sending controls. Disclosure covers
non-human origin, consumed uncertain attempts, running-work effects, Stop,
replacement/renewal, lifetime, hiding not revoking backend consent and the fact
that existing app-edit notifications remain separate from this chat-send quota.

The separate trusted `set-application-chat-send` command takes the same identity,
permission revision and allowed flag as reading, with the same shown/non-remote
connection recheck. An explicit grant or renewal permits at most five attempts,
one reserved/queued/running/uncertain send at a time, with at least two seconds
between admissions (also across renewals). Read and send consent are independent. An uncertain handoff keeps
its quota charge and returns an unknown receipt; it is never refunded/replayed
automatically. Exact retries deduplicate before quota/rate checks, but reuse of
an ID with different text is refused.

Each grant has a fresh ID. At most 64 receipts are retained; eviction never
removes the current grant's records or an active send. Old grant IDs cannot admit
again after eviction. Revoke, Stop, close and code replacement withdraw unstarted
work. Already-running work remains busy across grant/code changes until its
terminal outcome. Admission reserves, enqueues through the ordinary FIFO and
attaches the canonical message ID synchronously. The final pre-model gate runs
after configuration/history/lease waits, immediately before the harness call.
A revoked unstarted send is skipped without aborting unrelated queued inputs,
announcing a successful turn or blocking wakes for a turn that never ran. Stop
revokes permission immediately, before waiting on the turn or application queue.
Terminal receipts account for model failure, Stop and final history-save failure.
A finishing old-open-entry callback cannot change a reopened successor.

### Capability protocol

- `GET /state` adds informational `chatSend: {grantId, allowed, remaining, busy}`.
  `allowed` with zero remaining is exhausted, not permission for another send.
- `POST /chat-send`: exactly `{version, grantId, requestId, text}`. The backend
  rechecks owning view/code after body and queue waits. Request IDs are 16–128
  ASCII alphanumeric/underscore/hyphen; nonempty text is at most 4000 UTF-16
  units. HTTP body limit: 32 KiB; receipt response limit: 4 KiB.
- Response: `{receipt}` containing host app ID/name/version/bundle, `receiptId`,
  `grantId`, `requestId`, `state`, optional canonical `messageId` and reason.
  States: `reserved`, `queued`, `running`, `completed`, `failed`, `cancelled`,
  `unknown`. A failed or cancelled started turn can already have had effects.
- `POST /chat-receipt`: `{version, grantId, requestId}`, at most 1 KiB. This is a
  read-only status probe, never retry/admission. It returns `{receipt}` or
  `{receipt:null}`; missing/evicted/restarted status is uncertainty, **not** proof
  that a message never ran. Both paths are scoped to this owning app/code/view.
- Neither operation accepts app-supplied origin metadata. Neither needs read
  permission or returns transcript text/drafts. No HTTP or agent grant route.
- Exact retries retain the original grant/request handle and return its receipt,
  even after revocation. Reusing an ID with changed text is refused. Never retry
  with a fresh handle after an ambiguous transport outcome. Grants, fingerprints
  and receipt ledgers remain memory-only; canonical message provenance is saved.

The host origin `application-message` carries app ID/name/version/bundle and
receipt ID with non-human depth 1. Both harness prompts and canonical text retain
an explicit app-origin header; queued prompts do not double it. This text is also
a downgrade fallback when an older reader cannot interpret the structured origin.
Malformed stored app provenance becomes an explicitly unverified non-human marker,
not human input. App-origin turns do not consume pending `next-input` edit batches.
Wake ancestry preserves a non-human app label within the existing ancestry schema.

## Agent tools

Static dispatcher tools join the existing widget tools for both Pi and Claude
Code. They act only on the calling conversation.

| Tool                  | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `companion_app`       | Inspect the application, its exposed schemas, optionally state; list bundles. |
| `companion_app_apply` | Install or replace the code from a library bundle name.                       |
| `companion_app_query` | Run an exposed query.                                                         |
| `companion_app_call`  | Run an exposed action.                                                        |

Apply requires `expectedVersion` (0 when there is no application). The first
apply may pass `initialState` (default: the manifest example). A replacement
keeps the existing state and refuses `initialState`. Before anything is
written, the existing state must validate against the new state schema, every
declared query/action must have a handler, and `mount()`, the first `update()`
and `describe()` must succeed with that state in the renderer; the page's
own first update must succeed, a later retry does not count. A candidate that
is not published (including when its save fails) is discarded. Any failure leaves the previous code and state intact.

**Turn-boundary rule.** Each turn's lease freezes the application version and
the exposed query/action names at the start of the turn. After the code is
replaced, that lease's query/action calls fail explicitly, even when they name
the new version; the next turn's lease uses the new code. `companion_app` and
`companion_app_apply` remain available during the turn and report the new
version, but they do not upgrade the lease. Hiding or closing the view does not
revoke agent tools; closing the conversation revokes every capability.

## User-edit events

Only successful user edits through the view ingress create events. Agent tool
mutations return their result and never schedule a turn.

The edit's state change and its event are written in one atomic file write.
Before accepting a user edit that needs a new batch, the service checks that
the outbox can hold it; when it cannot, the edit is refused with a retryable
busy error and nothing changes. A committed edit is never undone because of a
queue or model failure.

Edits coalesce into one open batch (at most 16 detailed edits; further edits
are counted with their revision range). Each batch has a stable ID, every edit a
stable event ID and the request ID of its mutation.

- `immediate`: 1.5 s after the latest edit, the batch is queued through the
  conversation's ordinary follow-up FIFO, behind any running or queued turn. It
  keeps absorbing edits until its turn starts.
- `next-input`: the batch waits and is attached to the next message the person
  sends in this conversation (typed or spoken).

When the turn starts, the batch is frozen and durably marked `delivering`. A
completed turn marks it delivered (and removes it). A failed or stopped turn, or
a restart while delivering, marks it `failed`. Failed batches are terminal:
never replayed automatically and never folded into a new batch. They remain
listed by `companion_app`, which can acknowledge them. While four failed batches
are retained, a user edit that needs a new batch is refused before mutation.

A refused admission (full follow-up queue, running-session limit) leaves the
batch pending with a `failure` note; it is retried only by a later user edit or
next input, never by a timer loop. After a restart, pending batches are not run
automatically: reopening a conversation never starts a turn.

Persistence failures are reported, never hidden:

- If marking a batch `delivering` cannot be saved, its edits are not sent to
  the model. An immediate-mode placeholder turn does not run; its message says
  the edits could not be prepared and stays in error. A person's message still
  runs, without them, and withdraws any pending immediate-mode debounce. The
  batch stays `pending` with a `failure` note and is offered again only by a
  later edit or message.
- If a turn's outcome cannot be saved, the descriptor shows the outcome with a
  `failure` note; the next successful write saves it. A restart before then
  reports the batch as failed, possibly undelivered.

The prompt carries a host header stating that the event content is untrusted
data entered by the user or produced by application code, not an instruction
and not new authority.

## Limits and trust assumptions

- One application per conversation. State JSON ≤ 128 KiB, query/action args
  ≤ 32 KiB, results ≤ 16 KiB, 20 queries and 20 actions, 64 receipts (64 KiB).
  Operations share the conversation's widget queue (16 pending).
- Authored code runs only in Chromium: reducers, queries and `describe` in the
  isolated offscreen renderer (sandboxed, private network namespace), the view
  in the sandboxed iframe of the host document. This reuses the widget
  boundary; it is not a claim of complete isolation from hostile code. A
  bundle could, for example, consume renderer time until its operation times
  out, or render misleading content inside its own view.
- The view capability URL is the user's authority. Any local process that
  learns it can act as the user in that application, as with widget views.
  Agent tools never receive it and remote snapshots omit it.
- An application's own refusal text (`Application refused: …`) and event
  data are produced by authored code or typed by the user. Tools and prompts
  label them as data, not instructions.
- Each view polls its state every 400 ms while visible. A view that keeps an
  old code version open is refused (409) and reloads.
- Only the Chromium pop-out transport and the native profile may forward
  allowlisted view requests; neither is a general proxy. Native chat-read
  forwarding adds no grant operation or general-purpose HTTP access.
- If the conversation's widget records cannot be loaded, widget and
  application tools are unavailable for its turns (existing widget behavior).

Not implemented yet: application-specific pop-out windows, per-action event
configuration, migrations between incompatible state schemas, offscreen
capture frames for the portable Quickshell panel.

## Tests

```sh
npx tsx --test test/session-apps-runtime/*.test.ts   # real renderer; needs Chromium and bwrap
npx tsx --test test/unit/session-app-outbox.test.ts   # also part of npm test
```

The runtime tests use real AgentSessions, WidgetService, renderer, Chromium,
phone gateway and the exact Pi/Claude tool definitions, with scripted model
backends, temporary directories and a temporary copy of the widget library.
