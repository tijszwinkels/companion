# Remote phone gateway

`companion-remote` is an **opt-in** process that lets a paired phone use the
Companion panel over a private network such as Tailscale. The listener itself
still opens no network port: the gateway connects to the listener's private Unix
control socket as a [remote panel](../desktop/README.md#remote-panels) on behalf of
each authenticated phone. Nothing starts the gateway automatically, and it never
changes Tailscale, firewall or system settings. `service/` holds the optional
`companion-phone` supervisor for it.

```text
phone browser / iOS wrapper ──HTTPS+WSS──▶ companion-remote ──Unix socket──▶ listener
                          (Tailscale)       (this directory)   (remote role)
```

Engine work (speech, routing, agents, storage) stays on the computer. The gateway
adds no telemetry, cloud relay or third-party request. Which models a conversation
uses is unchanged: the coding profile may still be a cloud provider, exactly as
on the desktop, and the phone app shows each conversation's model.

## Running it

```sh
npm ci && npm run mobile:build          # once per checkout / update
bin/companion-remote serve              # loopback only: http://127.0.0.1:8787
bin/companion-remote pair               # prints a one-time code for the phone
bin/companion-remote devices            # list paired phones
bin/companion-remote revoke DEVICE_ID   # remove one; live connections close
```

To run it without a terminal, supervised and opt-in, see
[supervised phone access](../../docs/mobile-startup.md) (`bin/companion-phone`).

The listener must already be running (its socket defaults to
`$XDG_RUNTIME_DIR/companion/control.sock`) and must include the remote-panel
protocol; an older listener refuses the role and the gateway refuses to relay.

### Reaching it from a phone over Tailscale

Both modes are **user decisions**. The supervised trial used loopback plus
Tailscale Serve; initial iPhone access was user-confirmed on 2026-09-28. Direct
gateway TLS has automated coverage but was not the live phone trial route. See
[the current dated status](../../integrations/mobile/README.md#trial-and-merge-status--2026-09-28)
before changing an existing installation.

1. **Gateway terminates TLS.** Obtain a certificate for the machine's MagicDNS name
   with `tailscale cert` (requires HTTPS certificates to be enabled for the
   tailnet), then bind the Tailscale address:

   ```sh
   bin/companion-remote serve --host 100.x.y.z --port 8443 \
     --tls-cert desk.tailnet.ts.net.crt --tls-key desk.tailnet.ts.net.key \
     --origin https://desk.tailnet.ts.net:8443
   ```

2. **`tailscale serve` terminates TLS** and forwards to the loopback gateway:
   run `serve --origin https://desk.tailnet.ts.net` on 127.0.0.1 and configure
   `tailscale serve` to proxy to it. The gateway sees loopback connections but
   still requires the configured origin/host and a paired device token.

3. **`tailscale serve` forwards to a Unix socket.** This is meant for a
   persistent `tailscale serve --bg` route and a supervised user service; see
   [`companion-phone`](../../docs/mobile-startup.md), which runs this mode (with
   both flags) from a pinned checkout in a hardened transient user service.
   It has not been live-tested yet.

   ```sh
   bin/companion-remote serve \
     --listen unix:$XDG_RUNTIME_DIR/companion-phone/gateway.sock \
     --origin https://desk.tailnet.ts.net \
     --require-tailscale-login user@github \
     --check-tailscale-serve
   ```

   With a TCP route, anything that binds the loopback port while the gateway is
   down would be served under the tailnet name. A socket in a private directory
   cannot be taken over by other users. At startup the gateway:
   - requires the socket's directory to be owned by the user, not group/world
     accessible and not a symlink (checked with `lstat`; created 0700 only when
     missing). Its ancestors should be owned by root or the user, as
     `/run/user/UID` is; only the final directory is checked. The socket itself
     is created 0600;
   - holds a lifetime `flock` on `<socket>.lock`, so a second gateway fails
     instead of replacing the first. The lock file stays after the gateway stops;
   - removes an existing path only if it is a socket nobody answers on (a crashed
     gateway's leftover). A live socket, a socket it cannot probe, a symlink, a
     regular file or anything else is refused and left in place;
   - requires at least one `--origin`, all of them https, and adds no loopback
     default origins. `--host`, `--port` and `--tls-*` cannot be combined with it.

   `--require-tailscale-login` refuses any request whose `Tailscale-User-Login`
   header is not exactly the given login (compare `tailscale status --json`).
   Tailscale Serve strips client-supplied identity headers and sets this one
   only for a tailnet user's device, not for tagged devices, Funnel or local
   connections. It is therefore trustworthy only in Unix socket mode, where only
   tailscaled and the user can connect. On a loopback TCP port any local user
   could forge it, and the gateway prints a warning when it is used there.

   `--check-tailscale-serve` (Unix socket mode, exactly one https origin on port 443) reads `tailscale serve status --json` without sudo before binding, then
   again every minute. It accepts only `TCP 443 → HTTPS`, one Web entry
   `<host>:443` and one handler `/` → `Proxy: "unix:<socket path>"`. Any other
   setting fails closed: a foreground session, Funnel, another port, handler,
   target or service. On a mismatch the gateway refuses to start (exit 1), or
   stops serving and exits 1. A status that cannot be read (for example while
   tailscaled restarts) is retried: 5 reads 3 seconds apart at startup, and 3
   unreadable minute-checks in a row at runtime, before it fails the same way.
   On any shutdown the gateway socket closes first (before the optional app
   proxy), and the process exits within 5 seconds even if a connection lingers.
   The gateway never changes Serve. The `unix:<path>` Proxy spelling follows
   Tailscale's own help text but has not yet been seen in a live `--bg` route.

   In Unix socket mode without both flags, the gateway prints a warning. The
   optional `--apps-listen` app proxy (below) remains a separate loopback TCP
   listener: the socket, Funnel and login checks above apply to the gateway
   origin only.

See [supervised phone access](../../docs/mobile-startup.md) for the Serve setup,
origin, validation and rollback steps.
The gateway never uses `Forwarded`, `X-Forwarded-*` or Tailscale identity headers
as authentication. Over TCP it never uses them to replace the request's actual
Host/Origin. The one exception is the Unix socket (`--listen unix:`): tailscaled
sends `Host: localhost` to a `unix:` target and the browser's host in
`X-Forwarded-Host` (seen with Tailscale 1.102.4). Only this user and root can
connect to that private socket, so there `X-Forwarded-Host` takes the place of
`Host` and `Host` is ignored. The optional
required Tailscale login is an additional gate in front of pairing and device
tokens, never a substitute for them.

In every mode, requests to the gateway carrying `Tailscale-Funnel-Request`
(public internet via Funnel) are refused with 403, WebSocket upgrades included.

Plain HTTP on a non-loopback address, binding every interface, and non-HTTPS
non-loopback origins are refused at startup. Browsers need HTTPS for a secure
context; Tailscale's WireGuard encryption alone does not make an `http://100.x`
page a secure context.

## Security model

- **Network reachability is not authorization.** Every WebSocket must send
  `{"type":"auth","token":"…"}` as its first message within 5 seconds. Tokens are
  never put in URLs (which leak into logs and history). Native clients can forge
  Host/Origin: those checks defend browser boundaries, not pairing authority.
  Reachable unauthorized peers can consume global pairing/connection limits;
  restrict tailnet access with ACLs as well as pairing.
- **Pairing.** `pair` writes a random 10-character code (≈50 bits, confusable
  letters removed) to `pairing.json` as a SHA-256 hash, valid for 10 minutes and
  5 wrong guesses, single use. `POST /api/pair {code, name}` returns a 256-bit
  device token once; only its hash is stored in `devices.json`. The endpoint also
  has a global limit of 10 requests per minute. State lives in
  `~/companion/remote/` (0700; files 0600, atomic rename). The directory must
  already be private if it exists, and must not be a symlink. CLI/gateway writes hold a shared Linux `flock`
  through the complete transaction, preventing double redemption or revocation
  being overwritten by a concurrent pair/revoke. Requires util-linux `flock`.
  Separately, a running gateway holds an exclusive lifetime lock on
  `gateway.lock` there: one gateway per state directory, TCP or Unix socket; a
  second one refuses to start. Gateways from before this lock do not take it.
- **Revocation.** `revoke` removes the hash; the gateway rechecks every 5 seconds
  and closes that device's live connections (close code 4403).
- **Origins and hosts.** The WebSocket upgrade and pairing endpoint require an
  `Origin` in the exact allowlist; every request requires a `Host` (on the Unix
  socket: `X-Forwarded-Host`) matching an allowed origin. Pairing and WebSocket
  requests also require that host to match
  their Origin, even when both localhost and HTTPS are configured. This blocks
  cross-site WebSocket hijacking and DNS rebinding.
  Only HTTPS and loopback HTTP app origins are supported. Bundled wrapper origins
  and cross-origin browser clients need a separate CORS/credential design; they
  are not supported by adding a custom origin today.
- **Actions.** Requests are validated field by field in
  [`protocol.ts`](protocol.ts); unknown actions/fields are refused before reaching
  the listener. Desktop-bound actions (paste, typed Activity submission with a
  window target, media reports, composer focus, draft replies) are not exposed and
  are refused again by the listener for remote connections. Draft editing is
  available only to a connection that asked for it ([drafts](#drafts)).
- **Content.** The app is served with a strict CSP (`default-src 'none'`, self
  scripts/styles only, no inline script, `frame-ancestors 'none'`). Transcript text
  is rendered as text or sanitized Markdown, never as HTML.
- **Screenshots.** Session screenshot `file://` URLs become
  `api/screenshots/<session-uuid>`, fetched with the bearer token. The gateway
  serves only `<sessions directory>/<uuid>.png`, and only to a device that was
  shown that conversation. Widget view URLs are removed.
- **Data minimization.** The desktop's recent-utterance list (latest 100 across
  earlier runs, used for paste recovery) is emptied before snapshots reach phones;
  the phone shows only the current run's Activity.
- **Limits.** 8 authenticated connections in total and at most 4 per paired
  device (a browser with a few tabs plus a phone), draining connections
  included, leaving 8 of the listener's 16 client slots for desktop clients. A
  connection over a limit is refused after authentication with close code 4429
  and the reason `device` (its own device already has 4) or `total` (the gateway
  already relays 8); the device limit is reported first. Open connections are
  never closed to make room, and the reason never names another device. The
  limits are exported as `maximumConnectionsPerDevice` and
  `maximumRemoteConnections` from [`protocol.ts`](protocol.ts). Eight
  unauthenticated sockets (the upgrade is refused with 503 beyond that or beyond
  16 sockets in all). Client messages of at most 128 KiB
  (`maximumClientMessageBytes`), enough for a 16,000-unit draft written as
  escaped JSON; a larger message closes that connection. Before its relay
  starts, a socket may send at most 32 KiB + 8 bytes in all, counted on the
  wire with frame headers (`maximumUnauthenticatedBytes`: one 32 KiB message
  in one frame, the bound every message had before drafts), so an
  unauthenticated socket, or one still closing after it was refused, never
  makes the gateway hold more than before; past it the socket is cut at once.
  30-request bursts at 10/s per
  device, shared by all of that device's connections, so more tabs never raise
  a device's rate ([`request-rate.ts`](request-rate.ts)). Draft edits draw from
  a separate bucket per device (bursts of 120 at 40/s, see [drafts](#drafts)).
  A device's buckets are dropped when its last connection has closed.
  Receipts keep a SHA-256 digest of each request, not its text. Each connection's output writes
  one message at a time and bounds the waiting queue to 16 MiB / 256 messages;
  a write stalled for 30 seconds disconnects it. With 8 connections the gateway
  may therefore hold up to 8 × 16 MiB of queued output at worst. Routine state snapshots
  coalesce behind a pending write; ordered events and receipts never do. The
  initial full snapshot is ordered and is not subject to the waiting-queue size
  cap (the upstream line limit still applies). A relay admits at most 32 pending
  requests, plus at most 120 pending draft edits counted apart (the device's
  draft-edit burst, which a stalled network may deliver at once; the listener
  answers each edit at once), waits at most 5 seconds for
  remote-role confirmation and 15 seconds for a request reply. Draining relays
  continue counting toward capacity and remain subject to revocation. Malformed
  WebSocket frames disconnect only that client. Compression is disabled.

Credential storage: the web app keeps the device token in `localStorage` for its
origin. That is readable by any script running on that origin, which the CSP limits
to the app's own bundle. An iOS wrapper should move it to the Keychain. Anyone who
unlocks the phone and opens the app can use Companion; revoke a lost phone.

## Local apps

With `--apps-listen 127.0.0.1:PORT` and one `--app-origin ID=ORIGIN` per app, the
gateway also starts the app proxy from [`src/apps/`](../apps/proxy.ts) and offers
phone-enabled [local apps](../../docs/local-apps.md) to paired phones:

- `GET /api/apps` (bearer token) lists apps whose registration has phone access
  and an origin configured here. Without `--apps-listen` it returns no apps.
- `POST /api/apps/ID/open` (bearer token and the gateway's exact Origin) returns
  a one-time URL on that app's own origin. The phone opens it top-level; the app
  proxy turns it into an HttpOnly session cookie on the app origin.

App pages never run on the gateway's origin, and each app origin must use a host
name distinct from every other app and from the gateway (cookies ignore ports).
The device token never leaves the gateway origin: app origins refuse requests
carrying it. Revocation, phone opt-out and registration changes end app sessions
and live app connections using the same recheck interval as phone relays. The app
proxy binds loopback only; TLS and host names for app origins are separate user
deployment decisions. See the [local apps guide](../../docs/local-apps.md) for the
full policy and limits.

## Requests, receipts and reconnection

Phone messages are `{"type":"request","requestId":"…","action":"…",…}`; replies
echo `requestId`. Listener events arrive as `{"type":"engine","message":{…}}`.

The current phone authenticates with `incrementalSessions: true`. The gateway
always sends the first full state on each connection, then omits `sessions`,
`previousSessions` and `sessionOrderRevision` from routine state. Their absence
means unchanged: the phone retains those fields from ordered `agent-session`,
`agent-restored`, `agent-removed`, `agent-order` and `agent-history` events.
Reconnect starts with a full authoritative snapshot again. Older clients that
omit this capability continue receiving full snapshots. This negotiation is
local to the gateway; it does not forward desktop incremental/focus/navigation
fields to the listener, and requires no listener restart. The desktop protocol
and its per-client selection remain unchanged. No compression is enabled.

Conversation windows follow the [paged-history contract](../desktop/README.md#paged-conversation-history):
merge delta rows then retain exactly `history.ids`. `agent-history-page` is a
nonmutating, selected-conversation read; it is validated by the remote allowlist
and answered only to its requester. Page replies and canonical pin attachments
receive the same screenshot authorization and local widget-URL removal as
session snapshots. Retained history is never exposed through an unbounded reply.

[Turn and message times](../agents/README.md#turn-and-message-times)
(`turnStartedAt`, `lastTurnDurationMs`, message `createdAt`) and the state
message's [`listenerTime`](../desktop/README.md#listener-time) pass through the
gateway unchanged, in snapshots, events and history pages. A held initial
snapshot or a queued phone write delivers `listenerTime` late by that wait, so
the phone should refresh its clock offset from every later `state` message.

Desktop-selection events (`agent-actions`, `agent-view-actions`, `agent-draft`,
`agent-draft-focus`, `agent-select`) are not relayed; the phone uses
`remote-agent-actions` for its own selection. `draft-snapshot` and `draft` are
relayed only to [draft hosts](#drafts).

A connection reports its selection with `panel-state` `{id, visible?}`.
`visible` is a boolean: whether the page showing `id` is visible to the person
(for example `document.visibilityState === "visible"`). Send it with every
selection change and whenever the page's visibility changes. A report without it
counts as not visible, so an older app never clears unread marks and never marks
a conversation read. Every conversation carries the listener's shared
[unread mark](../desktop/README.md#unread-mark), `unread`, which the gateway
relays unchanged; a visible selection clears it for every device. When the
client leaves while its requests still drain, the gateway sends the listener
`{"action":"withdraw-visibility"}` on its behalf, so a page nobody sees any more
does not keep reading conversations. It names no conversation, keeps the
selection for the draining requests and is admitted even while the client's
requests fill every slot. Phones cannot send it. Reports still waiting for role
confirmation when the client leaves, or starts closing, are forwarded in order
with `visible` set to `false`, and the withdrawal follows them. Only the
declared remote event set is forwarded, and initial snapshots stay at the gateway
until the listener confirms the remote role. Reopen and Activity-based starts
open in the background on the desktop, just like typed phone starts. Activity-based
starts reuse an existing saved screenshot; they do not capture a new one.

## Drafts

The listener keeps each conversation's unsent text, the **draft**, in memory
([text-box drafts](../desktop/README.md#text-box-drafts-listener-owned-last-write-wins)).
A remote connection can share those drafts with the desktop instead of keeping
its own. It is opt-in per connection, uses the one remote role and needs no
per-device grant.

Rules:

1. **Opting in.** A client asks in its first message:
   `{"type":"auth","token":"…","drafts":true}`. For that connection, and only
   for it, the gateway adds `"draftHost": true` to every `panel-state` it
   forwards to the listener; the client cannot send `draftHost` itself. The
   listener makes the connection a draft host at its first such report and
   keeps it one until it disconnects. A client should send `panel-state` as
   soon as it is authenticated (the phone already does). A connection that
   never asks behaves exactly as before: `draft-set` is refused as "This
   action is not available remotely", `pendingSend` and `draftHost` as unknown
   fields, and no draft event reaches it.
2. **Reading.** At its first report a draft host receives
   `{"type":"engine","message":{"type":"draft-snapshot","sequence":12,"drafts":[{"id","text","source","sequence"}]}}`
   with every nonempty draft, then a `draft` event
   (`{"type":"draft","id","text","source","sequence","editId"?}`) for every
   accepted change, wherever it came from: a desktop editor, another remote
   draft host, an agent's proposal, a send that cleared it (empty `text`).
   `editId` is present only on the connection that wrote the change.
3. **Writing.** A draft host sends
   `{"type":"request","requestId":"…","action":"draft-set","id":"<conversation>","text":"…","editId":"…"}`
   with at most 16,000 UTF-16 units of text and a 1–100 character `editId`.
   The listener accepts it for any conversation it knows, open or saved; the
   last edit it receives wins, from any connection, as on the desktop. The
   result is `{"accepted":true,"sequence":13}` or
   `{"accepted":false,"reason":"…"}`. A refused or unanswered edit changes
   nothing; the client keeps the text and shows it as not saved. Draft edits
   have **no receipt**: they are never answered from a receipt and the
   client must never resend one by itself (an old edit replayed over newer
   text would be wrong). An edit sent before the connection's first
   `panel-state` is refused as "This action is only available on the desktop".
4. **Rate.** Draft edits draw from their own bucket per device, shared by
   its connections and separate from the request bucket: bursts of 120, then
   40 per second (`draftEditBurst`, `draftEditsPerSecond` in
   [`request-rate.ts`](request-rate.ts)). One keyboard types into one tab at a
   time; holding a key repeats about 30 times a second, and four tabs each at
   a fast 10 keystrokes a second add up to 40, so ordinary typing is never
   refused while a flood is. A refused edit is answered
   `{"type":"error","requestId","action":"draft-set","message":"Too many draft edits; this edit was not saved"}`;
   the connection stays open and its request bucket is untouched.
5. **Agent proposals.** An agent's proposed draft reaches a remote draft host
   as an ordinary `draft` change whose `source` carries the label the desktop
   shows (the proposing conversation's title, or `external (unverified) · …`).
   It is stored when any draft host, desktop or remote, is connected
   (`offline` only when none is). `focus: true` moves only a desktop panel; a
   remote connection never receives `agent-draft-focus` and never becomes the
   navigation owner.
6. **Pending send.** A draft host may add `"pendingSend":"<conversation>"`
   (or `""`) to `panel-state` while its `send-agent` from that conversation
   waits for a reply, as the desktop does. Agent proposals for it are a
   `conflict` meanwhile. Each report replaces the previous value.
7. **Sending.** When a draft host's `send-agent` is accepted, the listener
   clears the draft if it still equals exactly the sent text, as for a desktop
   send. A send from a connection that is not a draft host leaves the draft
   alone. `send-agent` allows 1–8,000 characters for every remote connection
   (the desktop composer's bound; it used to be 4,000).
8. **Lifetime.** Drafts live in the listener's memory only. They survive
   conversations being closed and reopened and remote connections coming and
   going: a reconnecting draft host gets a fresh `draft-snapshot`. A listener
   restart loses them; relays close with 4503 and a reconnect starts from an
   empty snapshot.

Everything else remote connections cannot do stays refused, draft host or
not: `paste`, `submit-utterance`, `media-playback`, `composer-focus`,
`agent-draft-result`, `set-capture-storage`, `set-application-chat-read`,
`set-application-chat-send`, `coding-defaults`, `set-coding-defaults`,
`agent-browser-open-result`, `agent-present-result`, `start-recording`,
`stop-recording`, `recording-append-result` and `cancel-agent-wake`, and the
events `agent-actions`, `agent-view-actions`, `agent-select`, `agent-present`,
`agent-draft-focus`, `recording-append` and `recording-finished`.

What a paired device can now read and change:

|                                            | Before | Connection without `drafts` | Draft host (`drafts: true`)                       |
| ------------------------------------------ | ------ | --------------------------- | ------------------------------------------------- |
| Read conversations' unsent drafts          | no     | no                          | yes, all of them (`draft-snapshot`, `draft`)      |
| Change a draft                             | no     | no                          | yes, any open or saved conversation (`draft-set`) |
| Block agent proposals while its send waits | no     | no                          | yes (`pendingSend`)                               |
| Clear a draft by sending it                | no     | no                          | yes, only if it equals the sent text              |
| See which agent proposed a draft           | no     | no                          | yes, the desktop's label (`source`)               |
| Move the desktop's selection or focus      | no     | no                          | no                                                |
| Follow-up length (`send-agent`)            | 4,000  | 8,000                       | 8,000                                             |
| Largest message                            | 32 KiB | 128 KiB                     | 128 KiB                                           |

Authenticated `{ "type": "ping" }` messages receive `{ "type": "pong" }`
without contacting the listener. The phone checks every 15 seconds. After 30
seconds without an incoming message it allows a final five-second probe before
reconnecting, even if the browser still calls the socket OPEN and never emits
an offline event. This grace period lets buffered replies arrive after page
suspension. New mutations are refused during the probe; existing pending
mutations become uncertain only if their request or connection deadline expires.
They are never automatically resent.

State-changing requests keep a **receipt per device for 10 minutes** (512 max,
memory only). At capacity new mutations are refused until receipts expire;
unexpired outcomes are never evicted to admit new work. Pending duplicate waiters
are bounded and removed on disconnect. Repeating the same `requestId` with identical arguments returns the
original reply with `duplicate: true`, or waits for it; different arguments are
refused. If the phone disconnects mid-request, the gateway keeps that upstream
socket open up to 15 seconds so the receipt records the real outcome. If the
listener disconnects first, the receipt records an explicit uncertain-outcome
error. The phone app never resends an unconfirmed mutation automatically; the
receipt is a second guard, not an exactly-once guarantee across gateway restarts.

Close codes: 4401 definitively not paired, 4403 revoked, 4429 too many
connections (reason `device` or `total`, see Limits above; older apps ignore the
reason),
4408 slow connection/authentication timeout, 4503 listener or device authorization
unavailable (including unsupported remote role), 4001 gateway stopped. Transient
4408/4503 failures do not discard the phone credential. Gateway protocol pings
every 20 seconds terminate peers missing the next pong and release their slots.
TLS certificates are read once at startup; installing a renewed certificate
requires an explicitly arranged gateway restart.

## Tests

`test/unit/remote-panel-role.test.ts` (listener role) and
`test/unit/remote-gateway.test.ts` (pairing, origin/host checks, authorization,
refused actions, receipts across reconnects, screenshots, revocation, listener loss,
TLS) and `test/unit/remote-apps.test.ts` (app list/open endpoints) use temporary directories, a real control socket, synthetic agent backends and
loopback only. `test/unit/remote-unix-socket.test.ts` covers Unix socket mode:
directory permission and symlink refusal, the lifetime lock, live and unprobeable
socket refusal, stale-socket removal, rollback of a failed start, Host 421 /
Origin 403 / WebSocket 101 over the socket, unauthenticated sockets receiving no
data, and Funnel and login refusals on every route.
`test/unit/remote-connection-limits.test.ts` tables the connection limits
(per device and in total, draining connections, the refused newcomer's reason, a
slot freed by a close, a revoked device, unauthenticated sockets, the listener's
16 slots and the shared per-device request rate) and
`test/unit/listener-unread.test.ts` the unread mark through the gateway and the
`visible` validation, both against the real gateway and listener.
`test/unit/remote-drafts.test.ts` tables the [draft rules](#drafts) (who edits
× what happens), and `test/unit/remote-draft-limits.test.ts` the message sizes
for authenticated and unauthenticated sockets, the draft-edit rate, receipts
and the send length, both against the real gateway and listener.
`test/unit/remote-plain-unchanged.test.ts` compares everything a connection
without `drafts` receives in a scripted session with a transcript recorded
on the revision before remote drafts (`test/fixtures/remote-plain-transcript.json`).
`test/unit/remote-serve-check.test.ts` covers the Serve matcher, the read
retries, and the CLI flags and warnings against a fake `tailscale` script. Real Tailscale is never used.
The supervised service (`src/remote/service/`) has its own tests; see
[its guide](../../docs/mobile-startup.md#tests). `test/mobile/` drives the built app in headless Chromium. None of
them validates a real iPhone, Safari, Tailscale or production listener.
