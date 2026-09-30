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

See [the supervised tailnet trial](../../docs/mobile-tailnet-trial.md) for the
locally audited Serve setup, exact origin policy, validation and rollback gates.
The gateway never uses `Forwarded`, `X-Forwarded-*` or Tailscale identity headers
as authentication or to replace the request's actual Host/Origin. The optional
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
- **Revocation.** `revoke` removes the hash; the gateway rechecks every 5 seconds
  and closes that device's live connections (close code 4403).
- **Origins and hosts.** The WebSocket upgrade and pairing endpoint require an
  `Origin` in the exact allowlist; every request requires a `Host` matching an
  allowed origin. Pairing and WebSocket requests also require that Host to match
  their Origin, even when both localhost and HTTPS are configured. This blocks
  cross-site WebSocket hijacking and DNS rebinding.
  Only HTTPS and loopback HTTP app origins are supported. Bundled wrapper origins
  and cross-origin browser clients need a separate CORS/credential design; they
  are not supported by adding a custom origin today.
- **Actions.** Requests are validated field by field in
  [`protocol.ts`](protocol.ts); unknown actions/fields are refused before reaching
  the listener. Desktop-bound actions (paste, typed Activity submission with a
  window target, media reports, composer focus, draft replies) are not exposed and
  are refused again by the listener for remote connections.
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
- **Limits.** 2 phone relays including draining connections, leaving six of the
  listener's eight slots for desktop clients. Eight unauthenticated sockets,
  32 KiB client messages, 30-request bursts at 10/s per phone. Phone output writes
  one message at a time and bounds the waiting queue to 16 MiB / 256 messages;
  a write stalled for 30 seconds disconnects the phone. Routine state snapshots
  coalesce behind a pending write; ordered events and receipts never do. The
  initial full snapshot is ordered and is not subject to the waiting-queue size
  cap (the upstream line limit still applies). A relay admits at most 32 pending
  requests, waits at most 5 seconds for
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

Desktop-selection events (`agent-actions`, `agent-draft`, `agent-select`) are not
relayed; the phone uses `remote-agent-actions` for its own selection. Only the
declared remote event set is forwarded, and initial snapshots stay at the gateway
until the listener confirms the remote role. Reopen and Activity-based starts
open in the background on the desktop, just like typed phone starts. Activity-based
starts reuse an existing saved screenshot; they do not capture a new one.

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

Close codes: 4401 definitively not paired, 4403 revoked, 4429 too many phones,
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
`test/unit/remote-serve-check.test.ts` covers the Serve matcher, the read
retries, and the CLI flags and warnings against a fake `tailscale` script. Real Tailscale is never used.
The supervised service (`src/remote/service/`) has its own tests; see
[its guide](../../docs/mobile-startup.md#tests). `test/mobile/` drives the built app in headless Chromium. None of
them validates a real iPhone, Safari, Tailscale or production listener.
