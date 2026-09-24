# External Companion session access

The optional Linux Unix socket lets local coding agents (including Mattermost
sessions) list, start, reopen, close, send to, and draft into Companion
conversations. It uses the listener's existing `SessionToolService`,
`AgentSessions`, FIFO queues and session store. It does not create terminal or
Mattermost sessions, read transcripts, expose unsent drafts, or configure providers.

## Activation and discovery

Access is **off by default**. After an explicitly authorized update/restart, start
the intended listener checkout with:

```sh
npm start -- --external-sessions
# Optional dedicated private parent; its ancestors must already exist:
npm start -- --external-sessions --external-socket /run/user/1000/my-companion/session.sock
```

`--external-sessions` requires ordinary listener mode; preview, graph, supplied
text and WAV modes reject it. It also works with `--no-desktop` (drafts then return
`offline`). The socket starts after saved sessions load and the optional desktop
service starts, and closes with the listener. Startup failure fails the listener
instead of silently serving with weaker protections. No installation or live
activation is performed by tests/builds.

Default path: `$XDG_RUNTIME_DIR/companion-external/session.sock`. Both listener and
CLI honor `COMPANION_EXTERNAL_SOCKET`; explicit `--external-socket` (listener) or
`--socket` (CLI) takes precedence. There is no `/tmp` fallback or socket scan.
Paths must be canonical absolute paths of at most 100 UTF-8 bytes. The final parent
is created as 0700 if absent; its ancestors must exist. An existing final parent
must already be owned by the current user with mode 0700.

Run the checkout's executable by absolute path from any working directory, after
`npm ci` in that checkout. Nothing needs installation in PATH or mm-bridge:

```sh
/home/user/Work/companion/bin/companion-session info
/home/user/Work/companion/bin/companion-session list --query review --limit 10
/home/user/Work/companion/bin/companion-session start --label 'MM Rowan' --text 'Investigate the synthetic test failure'
/home/user/Work/companion/bin/companion-session send --label 'MM Rowan' --id SESSION_UUID --text 'Please check the result'
/home/user/Work/companion/bin/companion-session draft --label 'MM Rowan' --id SESSION_UUID --text 'Suggested response for your review'
/home/user/Work/companion/bin/companion-session close --label 'MM Rowan' --id SESSION_UUID
/home/user/Work/companion/bin/companion-session reopen --label 'MM Rowan' --id SESSION_UUID
```

Use this feature branch's absolute executable path before merge, against an
isolated test listener only. `--help` describes profile/harness/model, focus, draft append,
request IDs and client timeouts. Successful commands emit one JSON object to
stdout (`ok: true`, outcome/session or directory). Failures emit `ok: false`, a
stable `code`, and a bounded explanation. Exit statuses: 0 success, 2 usage,
3 unavailable/unsafe transport before transmission, 4 server refusal, 5 uncertain
mutation outcome. Mutations emit their request ID as JSON on stderr **before**
transmission, so interruption need not lose the identity.

## Authority, attribution and lifecycle

**Any process running as the same OS user may control these Companion sessions.**
Caller `--label` is supplied text, not a verified identity, credential, session ID,
or authorization boundary. Labels cannot create an internal `self`: external
lists return `self: null`, and every open entry has `self: false`. Unknown request
fields (including `origin`, `self`, `depth`, tokens) are refused. Labels reject
control characters, Unicode line/paragraph separators and bidi direction overrides
so they cannot visually break or reverse the attribution header; ordinary emoji
and Unicode text remain usable.

Messages persist `origin: {kind: "external", title: label, requestId, depth: 1}`.
Prompts and the shared UI explicitly label them external/unverified. They have no
internal sender ID and no automatic reply route; the recipient is told to answer
in that Companion conversation. Draft sources likewise carry `kind: "external"`
and a label, never an invented internal session ID. A reply transport to external
agents is outside this API; `send` confirms acceptance, not provider completion.

The shared lifecycle guards still apply: 12 tabs, four running turns, eight queued
follow-ups, FIFO behind human messages, no implicit reopen on send/draft, busy
close refusal, and explicit model validation. `start` accepts the internal tool's
optional `harness` (`pi` or `claude-code`; `--harness`), with the same defaults,
harness-aware model validation and refusal codes (`invalid`, `unavailable-model`);
callers that omit it get the configured coding harness (Pi by default).
Start/reopen/draft default to no focus. Drafts use the existing single panel acknowledgement and default to refusing
existing text; `--append` is explicit. Closing an external target never gets the
internal deferred self-close exception. It can close only an idle conversation.

Internal Pi tools retain their per-turn bearer tokens, six-action budgets,
32-receipt budgets, self-target checks and expiring leases. No internal token is
minted for an external caller. Pi children always receive
`COMPANION_INTERNAL_AGENT=1`, and do not inherit `COMPANION_EXTERNAL_SOCKET`. The
CLI refuses calls in that marked environment, or one containing internal session
or widget tokens, with `internal-caller` (exit 4): those agents must use their
leased Companion tools. This prevents accidental self-send/depth bypass through
bash. It is a convention guard, **not** authentication: a deliberately hostile
same-user process can clear variables or write directly to the socket.

External callers have no known turn lifetime or trusted upstream depth, so their equivalents are deliberately process-wide:

- Each external message starts at depth 1. Subsequent **internal** forwarding
  retains the existing three-hop bound. The internal CLI guard keeps ordinary
  Companion turns on that route. Independent external requests cannot have a
  provable chain.
- At most 60 mutation attempts per 60-second listener window, across all labels.
  The window resets after 60 seconds once no earlier host request is pending.
- Identical start/send/draft content to the same destination is reserved across
  all labels for that window. A definite refusal releases it; uncertain drafts
  keep it. This bounds accidental repeated delivery, not malicious same-user use.
- At most 32 admitted connections, 16 executing mutation host requests, and 1024
  unexpired mutation receipts. Eight additional connections may briefly drain
  explicit capacity-refusal replies; further connections are dropped. Full tables
  reject new mutations; they never evict still-valid mutation receipts. Read-only
  `list` polling always fetches fresh state and consumes no mutation receipt slots.

Agents should act within the user's requested scope, avoid automatic reply loops,
and stop/report to the user when a guard refuses work. Repeatedly changing labels
is not a way around the shared budget. A same-user adversarial process can bypass
application conventions; it already has access to the user's code and data.

## Requests, retries and cancellation

Wire format: one JSON object followed by LF per connection, maximum **32 KiB**
including LF; one JSON reply followed by LF, maximum **256 KiB**. A client may
half-close its write side after the complete request and still receive its reply.
There is no HTTP,
TCP listener, streaming transcript or subscription. Incomplete input times out
following five idle seconds; execution has a 15-second deadline. Messages retain
the existing 1–4000-character bound. Errors are at most 600 characters, arbitrary
backend/filesystem errors are replaced with an uncertain outcome, and
requests/content/tokens are not logged. Known queue/capacity/closing refusals
retain their bounded, useful shared lifecycle wording.

First request `{ "method": "info" }` returns `protocol: 1`, a random listener
`epoch`, `receiptLifetimeMs: 600000` and `deadlineMs: 15000`. Every lifecycle request
(including list) carries `label` and `requestId`:

```json
{
  "method": "send",
  "label": "MM Rowan",
  "requestId": "EPOCH_TIMESTAMP_UUID",
  "id": "SESSION_UUID",
  "text": "Synthetic follow-up"
}
```

The real ID is `<epoch>_<13-digit Unix milliseconds>_<UUID>`; the CLI generates it
after discovery. IDs are global across labels/methods. During their ten-minute
lifetime, identical mutation arguments return the same pending/completed receipt.
Reusing a mutation ID with changed arguments returns `request-conflict`. Read-only
lists are not cached; repeating a list ID reads the current state again. Argument ordering does
not matter; omitted/default values versus explicit fields do matter. Receipts are
in memory. Expired IDs and IDs from another listener epoch return `expired-request`
without executing, including after a restart. Clock skew over two seconds into
the future is refused. A receipt is an admission result, not a durable guarantee
that an accepted provider turn completed or its final save succeeded.

The CLI **never retries automatically**. To retrieve an uncertain receipt,
explicitly repeat the exact command with `--request-id ID`. This is safe only
within the same listener/receipt lifetime; a missing/expired receipt is not
permission to use a new ID. Inspect the destination/user-visible conversation
before deciding what to do next. Restart/crash may leave an accepted action
without a retrievable receipt. There is no exactly-once guarantee across restart.

`--timeout-ms` bounds the client exchange (default 20 seconds). SIGINT/SIGTERM or
lost transport after mutation transmission returns exit 5. Discovery-only
failure reports exit 3 and confirms that no mutation was sent. A definite server
capacity refusal reports exit 4; dropped transport without a reply remains
conservatively uncertain. Client disconnect or CLI interruption does **not**
request cancellation of admission: the server cannot distinguish it from a valid
write-side half-close, and may still perform the action. Retrieve its receipt
with the exact `--request-id` instead of assuming it was cancelled.

The server deadline (or listener shutdown) aborts pending admission. Model
discovery/reopening check the signal before committing; a forwarded draft can
already exist and reports `unconfirmed`. Once a start/send has been accepted,
its turn or FIFO entry belongs
to the session and is **not** cancelled by client disconnect. Close may already
have saved/removed the tab. Cancellation never promises rollback. Stopping an
accepted provider turn remains the user's existing Companion UI control.

## Filesystem boundary

Requires unprivileged Linux, `/proc/self/fd`, and util-linux `flock`. Ancestors are
opened one component at a time with `O_NOFOLLOW|O_DIRECTORY`; only root/current-user
ownership is accepted, with no group/other writable ancestors except root-owned
sticky directories such as `/tmp`. Held directory descriptors anchor subsequent
operations. Symlinks, wrong ownership, permissive parents, non-socket targets and
unsafe/hardlinked lock files are rejected, not repaired with chmod.

A persistent 0600 lock file holds a kernel lifetime lock. It is never unlinked.
After acquiring it, an existing owned 0600 socket is probed; only `ECONNREFUSED`
permits removing the unchanged inode. Active listeners and inconclusive probes
are refused. A new socket binds inside a newly created 0700 staging directory,
becomes 0600, then is renamed into place. Filesystem reachability is private from
creation; global umask is never changed. The staged bind name means Node's automatic
socket unlink cannot delete a replacement at the public path. Explicit cleanup
checks the published device/inode and holds ownership until cleanup finishes.
Crash leftovers can include an empty/private `.bind-*` staging directory; these
are not automatically swept because another instance may own one.

Node's supported `net.Socket` API does not expose Linux `SO_PEERCRED`. We use the
kernel filesystem boundary rather than undocumented Node internals or a native
addon. Root and same-user processes are trusted; a same-user process can rename
its own private directories or pass an open descriptor to somebody else. Labels
remain unverified even if peer UID checking is added later.

Tests use synthetic scripted backends, disposable profile/session databases and
real CLI subprocesses/Unix sockets. They do not establish a paid provider turn,
production activation, live Mattermost-to-production messaging, or live Wayland
focus behavior.
