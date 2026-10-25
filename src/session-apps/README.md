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

| Field         | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `id`          | Stable UUID, kept across code replacement.                                   |
| `name`        | Library bundle name of the current code.                                     |
| `version`     | Code version: 1 on first apply, +1 per replacement. Host-assigned.           |
| `revision`    | State revision: +1 per committed state change.                               |
| `viewUrl`     | Desktop-only view capability, `http://127.0.0.1:<port>/view/<64 hex>`.       |
| `text`        | The bundle's readable text description (1–4000 characters).                  |
| `eventMode`   | `immediate` (default) or `next-input`; see [Events](#user-edit-events).      |
| `eventStatus` | Delivery state of user-edit events (display only).                           |
| `error`       | The saved application could not be restored; `viewUrl` is absent, data kept. |

When `error` is present the saved record could not be used. If the file is
unreadable, `id` and `name` are empty and `version`/`revision` are 0. The file is
left unchanged and `companion_app_apply` refuses to overwrite it; the
conversation's chat and history stay available.

`viewUrl` stays the same when code is replaced; the open view reloads itself
when it sees a new `version`. Closing the conversation revokes it; reopening
issues a new one. The phone gateway removes `viewUrl`. Agent tools never
receive it.

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
mode for a first apply.

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
- `api.state.subscribe(callback)` → unsubscribe function. `callback({revision,
data})` runs after each observed revision change. The view host polls
  `GET /state` every 400 ms while the page is visible (no polling while
  hidden), so a change may take up to about half a second to appear.
- `api.query(name, args)` → validated query result.
- `api.call(name, args)` → validated action result, after persistence.

The view keeps the widget iframe sandbox and CSP: no network, storage, nested
frames, workers, microphone or other browser permissions. It has no access to
history, the draft, chat sending, native window commands or other sessions.

## View HTTP protocol

All requests go to the loopback widget service; Host and Origin must match it.

| Request                 | Body / response                                                       |
| ----------------------- | --------------------------------------------------------------------- |
| `GET <viewUrl>`         | Trusted host document with the bundle inside a sandboxed iframe.      |
| `GET <viewUrl>/state`   | `SessionApplicationStateResponse`.                                    |
| `POST <viewUrl>/action` | `SessionApplicationActionRequest` → action result + `id`, `revision`. |
| `POST <viewUrl>/query`  | `SessionApplicationQueryRequest` → `{result, revision}`.              |

The native profile maps `companion-widget://view/` onto `viewUrl` and must allow
exactly these four requests. `version` mismatches are refused (`409`), so a view
running replaced code cannot execute successor actions. A request from this
view ingress is a **user** edit; origin is never read from the body.

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
declared query/action must have a handler and the bundle must describe the
state in the renderer. Any failure leaves the previous code and state intact.

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
  runs, without them. The batch stays `pending` with a `failure` note and is
  offered again only by a later edit or message.
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
- Only the Chromium pop-out transport and the native profile may forward the
  four view requests; neither is a general proxy.
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
