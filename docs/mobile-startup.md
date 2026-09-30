# Supervised phone access (`companion-phone`) — EXPERIMENTAL

`bin/companion-phone` runs the [phone gateway](../src/remote/README.md) without a
terminal: as a hardened systemd **user** service, from one pinned and reviewed
checkout, behind a persistent Tailscale Serve route to a private Unix socket.
Pairing is kept in a durable private directory, so phones stay paired across
gateway restarts, desktop restarts and reboots.

It is **opt-in only**. Plain desktop startup (`npm start`, `npm run ui`) is
unchanged and never starts phone access. Nothing starts at boot or login:
phone access runs from an explicit `companion-phone start` (by you, or by a
launcher that you explicitly asked for phone access, e.g. a `--phone` option)
until `companion-phone stop`, a failure, or the end of the user manager.

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
  package files. Paths are restricted to `A–Z a–z 0–9 / . _ + -`, so nothing
  needs shell or systemd quoting. Not pinned: `node_modules` and the built app in
  `integrations/mobile/dist` (see limits).
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
| `stop`                            | Stop the service. Exit 0 only once it is off and nothing answers on the gateway socket.              |
| `restart`                         | `stop`, then `start` (e.g. after approving a new revision).                                          |
| `status [--json]`                 | Gateway service, gateway socket, pinned checkout, desktop listener, tailnet route and pairing state. |
| `check-serve [--from-file F]`     | Tailscale Serve state: `ours`, `none`, `unexpected` or `unreadable`.                                 |
| `route-commands`, `print-service` | Print the human Serve commands, or the exact `systemd-run` command. Run nothing.                     |

Exit status: 0 success (for `status`: phone access available), 1 refused,
failed or unavailable, 2 usage or configuration error. `start` refuses, before
creating anything, when: the checkout is not the approved revision; the pairing
directory is not private; something already answers on the gateway socket; a
unit of that name exists that `companion-phone` did not start; the desktop
listener does not answer (unless `--without-listener`); or Serve is not exactly
the expected route. A running service with other settings is not replaced by
`start`; use `restart`.

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

3. **Stop any terminal-run gateway** you used before, and end a foreground
   `tailscale serve` session (Ctrl+C, then `sudo -k`). Serve must be empty
   (`companion-phone check-serve` prints `none`). Pairing in `~/companion/remote`
   is reused as is; pairing kept elsewhere must be moved deliberately while no
   gateway runs (see rollback for the direction back).

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

5. **Start and pair:** with Companion running, `bin/companion-phone start`, then
   `bin/companion-remote pair` (add `--state-directory` if you changed it) and
   enter the code on the phone at `https://<machine>.<tailnet>.ts.net`.

## Daily use and launcher contract

Start the desktop as you do today. For phone access, run
`companion-phone start` afterwards, or let a launcher do it when you ask it to.
A launcher's opt-in option (for example `companion-run <profile> --phone`)
should follow this contract; the launcher itself is local, not part of this
repository:

```sh
# Before stopping the listener (switching profiles, or off): stop phone access
# first, and keep the desktop running if that does not succeed. With nothing
# running this is a no-op; it never starts anything.
"$PINNED/bin/companion-phone" stop || { echo "Phone gateway did not stop"; exit 1; }

# Only with the explicit opt-in: after launching the listener, wait for it,
# then start phone access. A phone failure is reported but does not stop the
# desktop.
"$PINNED/bin/companion-phone" start --wait-for-listener 120 || echo "Phone access not started"
```

So phone access follows each explicit choice: a switch with `--phone` turns it
on, a switch without it (or `off`) leaves it off. Plain startup never starts it.
Use the pinned checkout's `bin/companion-phone`. A listener restart outside the
launcher needs no phone step at all (see below).

What happens when:

| Event                          | Effect                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Listener stops or restarts     | Gateway keeps running; phones see "listener unavailable" (close 4503) and reconnect when it is back, with the same pairing.     |
| Gateway crashes                | systemd restarts it after 2 s (at most 3 times a minute); phones reconnect.                                                     |
| Checkout changes while running | The running gateway continues; the next (re)start refuses. `status` reports it; approve with `configure --replace` + `restart`. |
| Serve route changes            | The gateway stops within about a minute; its restarts refuse too, so it ends failed. Fix the route, then `start` again.         |
| Logout                         | Without lingering, the user manager stops the service. With lingering it keeps running; stop it explicitly.                     |
| Reboot                         | The service is gone (transient). Pairing and the `--bg` route persist; phone access returns at the next explicit `start`.       |

Starting phone access automatically at boot or login is **not** part of this
design. It would be a separate decision (for example a small enabled user unit
that runs `companion-phone start --without-listener`), with its own review.

## Stop, disable and roll back

- **Stop phone access:** `companion-phone stop`. Nothing restarts it.
- **Disable completely:** stop, then remove the route yourself:
  `sudo tailscale serve --https=443 off` and `sudo -k` (never `tailscale serve
reset`, which removes unrelated configuration). Delete
  `~/.config/companion/phone-gateway.json` so no launcher can start it.
- **Revoke a phone:** `bin/companion-remote devices`, then `revoke ID`.
- **Forget all pairing:** stop, then remove `~/companion/remote`. Every phone
  must pair again.
- **Back to a terminal gateway:** stop the service and remove the `--bg` route
  first (one route, one owner), then run `companion-remote serve` as before with
  the same `--state-directory` (revoked devices stay revoked). If the old
  gateway used another state directory, copy the _current_
  `~/companion/remote/devices.json` there while no gateway runs, never an older
  copy (that would bring back revoked devices).
- **Another revision:** review it, update the pinned worktree, `configure
--replace --revision NEW`, then `restart`. The previous revision is the
  rollback target the same way.

## Limits

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
  behavior (`unix:` spelling in `serve status --json`, Host and WebSocket
  forwarding over the socket, the login header value, the response while the
  gateway is off), a real phone, logout or an actual reboot.

## Tests

- `npm test` includes `test/unit/phone-service-config.test.ts` (validation,
  quoting, the unit plan, both pin checks, the Serve classifier) and
  `test/unit/phone-service-cli.test.ts` (the CLI with fake `systemctl`,
  `systemd-run`, `tailscale` and `pkill`/`pgrep` trip-wires).
- `npm run test:phone-service` needs a running systemd user manager and creates
  uniquely named transient units `companion-phone-test-*` with fixtures under
  `~/.cache`. It checks the sandbox (read-only home and checkout, no TCP,
  tailscale/flock/listener still reachable; `systemd-analyze security` exposure
  at most 2.5, measured 1.7), refusals before any unit exists,
  the private socket and its Host/login/Funnel guards, a paired phone across
  listener loss and restart, crash restart with durable pairing, the gateway
  failing closed on a changed route, systemd refusing a changed checkout, and a
  stop that never touches a unit of the same name it did not start. It never
  uses the production socket names, state, Tailscale or installed units.
