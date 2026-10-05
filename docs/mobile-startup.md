# Supervised phone access (`companion-phone`) — EXPERIMENTAL

`bin/companion-phone` runs the [phone gateway](../src/remote/README.md) without a
terminal: as a hardened systemd **user** service, from one pinned and reviewed
checkout, behind a persistent Tailscale Serve route to a private Unix socket.
Pairing is kept in a durable private directory, so phones stay paired across
gateway restarts, desktop restarts and reboots.

It is **opt-in only**. Plain desktop startup (`npm start`, `npm run ui`) is
unchanged and never starts phone access. Nothing starts at boot or login:
phone access runs from an explicit `companion-phone start`, or with a listener
you started with the opt-in `--phone` option, until `companion-phone stop`, that
listener's shutdown, a failure, or the end of the user manager.

`companion-phone` never runs sudo, never changes Tailscale, never installs or
enables unit files, and never finds processes by name (`pkill`/`pgrep`). The
one privileged step, creating the Serve route, is yours; the tool prints it.

```text
phone ──HTTPS (tailnet only)──▶ tailscaled (Serve, --bg)
                                   │ unix:$XDG_RUNTIME_DIR/companion-phone/gateway.sock
                                   ▼
               transient user service companion-phone-gateway.service
               (pinned checkout, read-only sandbox, Unix sockets only)
                                   │ desktop listener control socket
                                   ▼
                          Companion listener (started as today)
```

## How it works

- **Transient unit, nothing installed.** `start` creates the service with
  `systemd-run --user`. There is no unit file and no `[Install]` section, so it
  cannot be enabled by mistake and vanishes at reboot. `companion-phone
print-service` shows the exact, shell-quoted command without running it.
- **Pinned code.** `configure --revision SHA` approves one commit of one
  checkout. `start`, and systemd itself before every automatic restart
  (`ExecStartPre`), refuse unless the checkout is exactly at that commit, with no
  tracked changes and no untracked files in `src`, `bin`, `integrations` or the
  package files. Both use the same shell check. It compares the actual bytes,
  file types and executable bits on disk with the approved commit's tree
  (`hash-object --no-filters`), so it does not depend on the index, stat cache,
  attributes or clean filters. It runs no configured command, refuses a
  `core.worktree` pointing elsewhere, and ignores replace refs, `GIT_*`
  environment redirection, `.git/info/exclude`, and global or new nested
  ignore files. Paths are restricted to
  `A–Z a–z 0–9 / . _ + -`, so nothing
  needs shell or systemd quoting. Not pinned: `node_modules` and the built app in
  `integrations/mobile/dist` (see limits).
- **Its own runtime directory.** systemd creates
  `$XDG_RUNTIME_DIR/companion-phone` at start and deletes it with its contents
  at stop. `configure` refuses a name that overlaps the listener's socket
  directory or any configured path, and `start` refuses if a directory of that
  name already exists, so nothing else is ever adopted and deleted.
- **Sandbox.** The whole file system is read-only except the pairing state
  directory, the service's own runtime directory and a private `/tmp`
  (`ProtectSystem=strict` **and** `ProtectHome=read-only`: on systems where
  `/home` is a separate mount, `ProtectSystem=strict` alone leaves it writable).
  Only Unix sockets (`RestrictAddressFamilies=AF_UNIX`): no TCP/UDP at all. No
  capabilities, no new privileges, the `@system-service` system call set.
- **Supervision.** `Restart=on-failure` restarts a crashed gateway (at most 3
  times a minute, then it stays failed). The gateway exits with failure when the
  Serve route stops matching; the pin check then also prevents a restart onto
  changed code.
- **Guards kept.** The service always passes `--require-tailscale-login`,
  `--check-tailscale-serve` and exactly one `https://` origin. Host/Origin
  checks, pairing and device tokens, Funnel refusal and the exact-route check
  work as described in the [gateway README](../src/remote/README.md).

## Commands

| Command                           | What it does                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `configure …`                     | Validate and record settings, approving one revision. Starts nothing.                                |
| `start [--wait-for-listener S]`   | Check every precondition, start the service, wait until it answers (default up to 90 s).             |
| `stop`                            | Stop the configured service. Exit 0 only once it is off and nothing answers on the gateway socket.   |
| `restart`                         | `stop`, then `start` (e.g. after approving a new revision).                                          |
| `status [--json]`                 | Gateway service, gateway socket, pinned checkout, desktop listener, tailnet route and pairing state. |
| `check-serve [--from-file F]`     | Tailscale Serve state: `ours`, `none`, `unexpected` or `unreadable`.                                 |
| `route-commands`, `print-service` | Print the human Serve commands, or the exact `systemd-run` command. Run nothing.                     |

Exit status: 0 success (for `status`: phone access available), 1 refused,
failed or unavailable, 2 usage or configuration error. `start` refuses, before
creating anything, when: the checkout is not the approved revision; the pairing
directory is not private or another gateway serves it; the runtime directory
already exists; something already answers on the gateway socket; a
unit of that name exists that `companion-phone` did not start; the desktop
listener does not answer (unless `--without-listener`); or Serve is not exactly
the expected route. A running service with other settings is not replaced by
`start`; use `restart`. Until then `status` reports phone access as
unavailable, because the running gateway does not match the configuration.

A `stop` while the service is already stopping (a stop issued elsewhere)
waits for that stop to finish instead of failing. A `start` waiting for the
listener (`--wait-for-listener`) ends promptly when cancelled and never submits
the service afterwards.

`stop` reports phone access off only when the service is inactive and the
gateway socket path is either absent or a socket that refuses connections. A
symlink, a file that is not a socket, a socket that belongs to someone else, or
one that does not answer in time is left untouched and reported as a failure,
because it might still serve Tailscale Serve.

`stop` needs a readable config to know which service is meant. Without one it
refuses (exit 2) instead of guessing; name the service explicitly with
`stop --unit-name NAME --runtime-directory-name NAME`. With only `--unit-name`
it stops that unit but does not claim phone access is off, because it cannot
check the socket.

`status` distinguishes the parts of phone access, for example:

```text
Gateway service:  active (running) [companion-phone-gateway.service]
Gateway socket:   answering (/run/user/1000/companion-phone/gateway.sock)
Pinned checkout:  ok
Desktop listener: absent (/run/user/1000/companion/control.sock)
Tailnet route:    ours
Pairing state:    private, 2 paired devices (/home/me/companion/remote)
Phone access:     unavailable — the desktop listener is not running
```

## First installation

Each step is a separate decision. Nothing below happens automatically.

1. **Pin a reviewed checkout.** Use a dedicated worktree at the reviewed commit,
   so later work in your main checkout cannot stop (or change) phone access:

   ```sh
   git worktree add --detach ~/src/companion-phone-pinned <REVIEWED_SHA>
   cd ~/src/companion-phone-pinned && npm ci && npm run mobile:build
   ```

2. **Configure** (writes `~/.config/companion/phone-gateway.json`, 0600):

   ```sh
   bin/companion-phone configure \
     --origin https://<machine>.<tailnet>.ts.net \
     --tailscale-login <you>@github \
     --revision <REVIEWED_SHA>
   ```

   The login must equal what `tailscale status --json` reports for your devices.
   Defaults: pairing state `~/companion/remote`, the listener socket
   `$XDG_RUNTIME_DIR/companion/control.sock`, unit `companion-phone-gateway`.

3. **Stop any terminal-run gateway** you used before (see
   [one gateway per pairing state](#one-gateway-per-pairing-state)), and end a
   foreground `tailscale serve` session (Ctrl+C, then `sudo -k`). Serve must be
   empty (`companion-phone check-serve` prints `none`). An existing
   `~/companion/remote` is used as it is: no migration, reset or copy. Pairing
   kept elsewhere must be moved deliberately while no gateway runs (see rollback
   for the direction back).

4. **Create the tailnet route yourself, once** (`companion-phone route-commands`):

   ```sh
   sudo tailscale serve --bg --https=443 unix:/run/user/<uid>/companion-phone/gateway.sock
   sudo -k
   ```

   `--bg` keeps the route in tailscaled across reboots. While the gateway is off,
   tailnet peers get an error from Serve (expected 502; not yet verified live);
   nothing else can answer there, because only you can create that directory in
   your private runtime directory.
   Upstream Tailscale source stores `unix:` targets as given without checking
   that the socket exists; this has not been verified live on every version. If
   your `tailscale` refuses the command or asks for account, HTTPS or operator
   changes, stop and decide separately; do not grant `--operator` for this.

5. **Start and pair:** with Companion running, `bin/companion-phone start` (or
   restart the listener with `--phone`), then
   `bin/companion-remote pair` (add `--state-directory` if you changed it) and
   enter the code on the phone at `https://<machine>.<tailnet>.ts.net`.

## Daily use: `npm start -- --phone`

Phone access can follow the desktop listener. Start the listener with the
opt-in `--phone` option (a launcher only has to pass it through, e.g. for
`companion-run <profile> --phone`):

```sh
npm start -- --external-sessions --phone
```

| Moment                                 | What happens                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Listener without `--phone`             | Never runs `companion-phone`: starts nothing, stops nothing, whatever gateway may be running.                                                                                                                                                                                                                                                    |
| `--phone` listener is up               | After its control socket answers, it runs this checkout's `bin/companion-phone start` in the background. The desktop never waits for it.                                                                                                                                                                                                         |
| Phone start fails or is refused        | Logged in the listener output (`phone` lines) with the reason; the desktop keeps running. `companion-phone status` shows which part is missing.                                                                                                                                                                                                  |
| `--phone` listener stops (Ctrl+C/TERM) | First, while its socket still exists: a start still in progress is cancelled, then `companion-phone stop`. The cancelled start finishes or undoes its current step and never leaves a gateway appearing later (details below). Usually about a second. If stop fails it is logged ("Phone access may still be on") and the listener still exits. |
| Desktop restart by a launcher          | The old `--phone` listener stops phone access on its way out; the new one starts it only if it has `--phone` too. Wait for the old listener to exit before starting the new one.                                                                                                                                                                 |
| Listener crash or SIGKILL              | No hook runs. The gateway keeps running and phones see "listener unavailable" (4503) until a listener is back; a new `--phone` listener keeps the running service. `companion-phone stop` ends it any time.                                                                                                                                      |

**Cancelling a start.** `companion-phone` runs in its own process group, so a
Ctrl+C in the listener's terminal does not interrupt it half-way. The hook
sends it SIGTERM. It stops between steps, lets an in-flight `systemd-run`
finish (at most 20 s), stops a service it has just created, and exits. Only if
it has not exited after 30 s is its whole process group killed. Stop then runs
a second time 3 s later, in case systemd accepted the start request from the
killed client. A start that overruns its own time limit is cancelled the
same way; a shutdown during that cancellation waits for it and shares its stop
rather than running a second one. Worst case, shutdown therefore waits about 1.5 minutes for
phone access; a launcher that gives up earlier should say so rather than
start a new listener while the old one is still stopping.

`--phone` is refused outside ordinary listener mode (`--no-desktop`,
`--preview`, `--text`, `--wav`, `--graph`). `companion-phone start` and
`stop` also work by hand, independently of any listener.

Other events:

| Event                            | Effect                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener restarts without a hook | The gateway keeps running; phones see "listener unavailable" (close 4503) and reconnect when it is back, with the same pairing.                                                        |
| Gateway crashes                  | systemd restarts it after 2 s (at most 3 times a minute); phones reconnect.                                                                                                            |
| Checkout changes while running   | The running gateway continues; every (re)start refuses, so after a crash it ends failed. `status` reports it; approve with `configure --replace` + `restart`, or restore the checkout. |
| Serve route changes              | The gateway stops within about a minute; its restarts refuse too, so it ends failed. Fix the route, then `start` again.                                                                |
| Logout                           | Without lingering, the user manager stops the service. With lingering it keeps running; stop it explicitly.                                                                            |
| Reboot                           | The service is gone (transient). Pairing and the `--bg` route persist; phone access returns at the next `--phone` listener or explicit `start`.                                        |

Starting phone access automatically at boot or login is **not** part of this
design. It would be a separate decision with its own review.

## One gateway per pairing state

A gateway holds an exclusive lifetime lock on `gateway.lock` in its pairing
state directory for as long as it serves, whether on a TCP port or a Unix
socket. A second gateway on the same state refuses to start ("Another phone
gateway serving this pairing state holds …"), and `companion-phone start`
refuses before creating anything. (`state.lock` is different: it only
serializes single pairing/revocation transactions, and `pair`/`revoke` keep
working while a gateway runs.)

**Handover and upgrade limit:** gateways from before this lock take no lock
and cannot be detected. When switching from an older terminal gateway, stop it
first yourself; `companion-phone` cannot see it. Likewise, a service pinned to
an older revision does not take the lock itself (the preflight in
`companion-phone start` still refuses while a newer gateway holds it).

## Stop, disable and roll back

- **Stop phone access:** `companion-phone stop`. Nothing restarts it until the
  next explicit `start` or `--phone` listener.
- **Disable completely:** stop, then remove the route yourself:
  `sudo tailscale serve --https=443 off` and `sudo -k` (never `tailscale serve
reset`, which removes unrelated configuration). Delete
  `~/.config/companion/phone-gateway.json` so no `--phone` listener can start it.
- **Revoke a phone:** `bin/companion-remote devices`, then `revoke ID`.
- **Forget all pairing:** stop, then remove `~/companion/remote`. Every phone
  must pair again.
- **Back to a terminal gateway:** stop the service (and stop passing `--phone`)
  and remove the `--bg` route first (one route, one owner), then run
  `companion-remote serve` as before with
  the same `--state-directory` (revoked devices stay revoked). If the old
  gateway used another state directory, copy the _current_
  `~/companion/remote/devices.json` there while no gateway runs, never an older
  copy (that would bring back revoked devices).
- **Another revision:** review it, update the pinned worktree, `configure
--replace --revision NEW`, then `restart`. The previous revision is the
  rollback target the same way.

## Limits

- The pin trusts Git's object store in the pinned checkout (same user) and the
  `git` binary it runs.
- `node_modules` and `integrations/mobile/dist` in the pinned checkout are not
  hashed. Anyone able to change them already runs code as you; do not share or
  modify the pinned worktree.
- The `--apps-listen` local-app proxy needs TCP and is not available in this
  mode.
- Pairing state holds token hashes only, but it is in your home directory and
  in any backups of it.
- The gateway's code and the listener's checkout are independent. A listener
  without the remote-panel protocol is refused by the gateway.
- Tests (below) use a real systemd user manager with synthetic listener, state,
  checkout and a fake `tailscale`. They do not prove real Tailscale Serve
  behavior (`unix:` spelling in `serve status --json`, WebSocket forwarding
  over the socket, the login header value, the response while the gateway is
  off), a real phone, logout or an actual reboot. Observed live with Tailscale
  1.102.4: a `unix:` target receives `Host: localhost` with the real name in
  `X-Forwarded-Host`, which the gateway checks in socket mode.

## Tests

- `npm test` includes `test/unit/phone-service-config.test.ts` (validation,
  quoting, the unit plan, both pin checks, the Serve classifier),
  `test/unit/phone-service-cli.test.ts` (the CLI with fake `systemctl`,
  `systemd-run`, `tailscale` and `pkill`/`pgrep` trip-wires, synthetic HOME and
  config; read-only `status`/`check-serve` that print no token, hash or code),
  `test/unit/phone-desktop-hook.test.ts` (the `--phone` hook: background start,
  failure reporting, stop ordering and time bounds, cancellation of a start
  whose descendants ignore SIGTERM or whose request escaped the kill, flag
  validation), cancellation during a slow `systemd-run` and during the Serve
  check with the real `companion-phone` (in the CLI tests) and, in
  `test/unit/remote-unix-socket.test.ts`, one gateway per pairing state across
  TCP and Unix socket gateways, with handover in both directions.
- `npm run test:phone-service` needs a running systemd user manager and creates
  uniquely named transient units `companion-phone-test-*` with fixtures under
  `~/.cache` and a synthetic HOME. The pinned checkout's path contains
  `+ . _ -`. It checks the sandbox (read-only home and checkout, no TCP,
  tailscale/flock/listener still reachable; `systemd-analyze security` exposure
  at most 2.5, measured 1.7), that the gateway is a child of the user manager
  rather than of the caller, refusals before any unit exists, the private
  socket and its Host/login/Funnel guards, a paired phone across listener loss
  and restart, crash restart with durable pairing, the gateway failing closed
  on a changed route, systemd refusing on automatic restart each of: an edited
  tracked file, an untracked source file and a moved HEAD (ending
  `start-limit-hit`, cleaned up by `stop`), a terminal TCP gateway on the same
  pairing state blocking the service and vice versa, the `--phone` hook end to
  end, shutdown during a `systemd-run` delayed 1.5 s before the real
  submission (nothing appears afterwards), an existing runtime directory left
  untouched, and a stop that never touches a unit of the same name it did not
  start.
  It never uses the production socket names, state, Tailscale or installed
  units, and needs the tested revision committed (it pins a clone of HEAD).
