# Trusted local web apps

Companion can present ordinary local web applications next to its restricted
[widgets](../widget-library/README.md). A widget is a sandboxed view with JSON
props and declared actions and no network. A **local app** is the opposite: a
normal web application whose backend runs on this computer with the OS user's
full trust, shown in a normal browser with normal HTTP, WebSocket, cookies,
storage, file selection and dialogs. There is no Companion data protocol, SDK or
bridge for apps: an app is whatever the web platform already allows.

Status (2026-09-28, branch `feat/trusted-browser-apps`): desktop registration,
lifecycle and app windows work from the CLI. The phone proxy is implemented and
tested on its own; wiring it into the phone gateway and the phone app's Apps list
is pending. Nothing is activated on the live desktop, gateway or tailnet.

## Trust model

| Part                | Trusted with                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App backend         | Everything the OS user can do. It is not isolated; register only code you would run in a terminal.                                                                                                                                                                            |
| App page JavaScript | Only what a web page on its origin can do in Chromium/Safari. No Companion API, credential, session tool, shell, file bridge or native object is exposed.                                                                                                                     |
| Companion           | Registers (CLI only), starts the registered argv on request, opens the window, proxies phone traffic to the exact registered loopback port. It never derives launch or registration authority from transcripts, widgets, imported content, page navigation or phone requests. |

## Quick demo (synthetic)

```sh
npm ci
bin/companion-app demo            # CSV notebook on http://127.0.0.1:8791, window if a desktop is present
bin/companion-app demo --no-open  # just the backend; open the URL yourself
```

The demo registers the synthetic **CSV notebook** in a temporary directory and
runs it in the foreground; Ctrl+C stops it and deletes that directory. Use
`--directory DIR` to keep its registry, browser profile and data between runs.
In the window: choose a CSV file and **Import** (streamed to the backend, stored
on disk, progress over a WebSocket), watch **Activity**, try **Rename notebook…**
(`prompt`/`confirm`), and **Stop backend** to see the page switch to
"reconnecting…". Rerun the demo with the same `--directory` and the page
reconnects on its own with the data intact.

## Registering and running an app

```sh
bin/companion-app add budget --name "Budget" --upstream http://127.0.0.1:8123 \
  --cwd ~/code/budget -- node server.js --port 8123
bin/companion-app list
bin/companion-app run budget --open   # foreground; Ctrl+C stops the backend
bin/companion-app open budget         # another window, backend already running
bin/companion-app desktop-entry budget  # optional launcher entry (runs `open`)
bin/companion-app remove budget
```

- **Upstream** must be exactly `http://127.0.0.1:PORT` or `http://[::1]:PORT`.
  Host names (including `localhost`), paths, other addresses and TLS are refused,
  so no DNS answer or path rewrite is involved. The app is served at its own root.
- **Launch** is an argv array, never a shell string. The executable is resolved
  to an absolute path at registration and the working directory must exist.
  `set-launch ID -- …` replaces it; `set-launch ID --none` removes it.
- The registry lives in `~/companion/apps/registry.json` (directory 0700, file
  0600, atomic replace, shared `flock` with other CLI processes). Every change
  increases the app's `revision`. An existing directory readable by other users
  is refused rather than silently repaired.

### Lifecycle

`run` owns exactly the process it starts:

1. It refuses if anything already listens on the registered port. Companion
   never attaches to, adopts or kills a process it did not start and keeps no
   PID file.
2. It starts the argv in a new process group with the registered working
   directory. The environment is the caller's minus `COMPANION_*` variables, so a
   run started from a Companion agent turn does not pass internal tokens on.
3. It reports readiness when the port accepts connections (30 s limit; a
   backend that never listens is stopped).
4. Ctrl+C/SIGTERM stops the group: SIGTERM, then SIGKILL after 5 seconds. If the
   backend exits by itself its leftover helpers get SIGTERM.

The backend lives as long as that foreground command. Closing a window does
not stop it, and stopping it never deletes app data. If the supervisor is killed
with SIGKILL, the backend keeps running; a later `run` refuses the busy port until
you stop that process yourself. Apps registered without a launch command are
started however you like; Companion then only opens them.

App-owned data is wherever the app keeps it (the demo uses its `--data`
directory). `remove` forgets the registration but keeps the browser profile and
all app data.

## Desktop windows

`open` starts `/usr/lib/chromium/chromium --app=<upstream>/` with a dedicated
persistent profile in `~/companion/apps/profiles/<id>` (0700). Consequences:

- Each app's cookies, localStorage, IndexedDB, service workers, permission
  decisions and cache are separate from every other app, from your personal
  browser profile and from Companion's own Qt WebEngine UI. Two apps cannot read
  each other's storage even though both live on `127.0.0.1` (cookies ignore ports;
  separate profiles do not share a cookie jar). Tests also open one app's origin
  inside another app's profile and see none of its state.
- The profile survives window close, backend restarts and Companion restarts.
- The page sees its real origin (`http://127.0.0.1:PORT`, a secure context), so
  root paths, cookies and the backend's own authentication work unchanged.
- The system binary is started directly, not the distribution wrapper, so your
  personal `chromium-flags.conf` does not apply. No sandbox, web-security, proxy,
  extension or remote-debugging flags are added; `CHROME_*`/`CHROMIUM_*` and
  `COMPANION_*` variables are removed from its environment. Tests check
  `chrome://sandbox` with these exact arguments.
- Ordinary browser behavior applies: the file chooser is the normal system one,
  `alert`/`confirm`/`prompt` work, downloads use Chromium's download folder, and
  navigation away from the app origin or `target=_blank`/`window.open` pop-ups
  follow Chromium's normal app-window and pop-up-blocking rules in the same
  profile. The file chooser and dialogs are exercised in headless tests; the
  windowed navigation/pop-up presentation has not been checked on a live desktop.
- A second `open` for the same profile hands off to the running browser for that
  profile and opens another window. Windows carry the class
  `companion-app-<id>` for compositor rules.

The Companion panel does not list apps yet; the CLI and optional launcher entry
are the native list/open path in this slice. A panel Apps list needs a listener
protocol change and is left for a follow-up.

### Loopback services

Browser profiles separate storage, not the network. Like any page in any
browser, an app page can send requests to other ports on `127.0.0.1`. Because the
app page is itself loopback, Chromium's Private Network Access rules do not block
this. The same-origin policy still prevents reading responses without CORS, and
the app's profile holds no other app's or site's cookies, so such requests carry
no ambient credentials. Remaining risk: a loopback service that performs state
changes on credential-less "simple" requests (no-cors POST/GET) without checking
Origin. Companion's own control surfaces are Unix sockets (listener, external
sessions, UI) or the phone gateway, which requires a bearer token and exact
Origin/Host; none use cookies. Chromium has no per-profile setting that blocks
loopback reliably (implicit proxy bypass rules exempt loopback), so this slice
documents rather than blocks it. Register apps you trust, and keep other local
services protected with their own authentication.

## Phone access

Phone access is off for every app until `companion-app phone ID on`. Turning it
off (or any other registration change) ends existing phone sessions within the
sweep interval (5 seconds) and immediately for new requests.

```text
phone ──HTTPS──▶ TLS terminator ──▶ AppProxy (loopback) ──▶ http://127.0.0.1:PORT
                 (user-configured)  src/apps/proxy.ts        registered backend
```

The **app proxy** is a separate loopback listener from the phone gateway. It
serves only app origins, so app JavaScript never runs on the gateway's origin
where the phone keeps its device token.

- **Origins are explicit.** Each phone app needs `--app-origin ID=ORIGIN`
  (HTTPS, or loopback HTTP for tests such as `http://budget.localhost:8790`).
  Nothing allocates DNS names or certificates.
- **One host name per app.** Browsers share cookies across ports of the same
  host, so two apps on `desk.example.ts.net:8444` and `:8445` could read and
  overwrite each other's cookies and forward them to each other's backends. The
  proxy refuses such configurations. An app may share the gateway's host name on
  another port, because the gateway uses bearer tokens and Origin checks, never
  cookies. With a single tailnet host name that allows one phone app; more apps
  need distinct host names (for example Tailscale Services or your own DNS and
  certificates), which are separate, explicit deployment decisions.
- **Routing** is by the exact `Host` of a configured origin (unknown hosts get
  421). The upstream address and port always come from the registry. The request
  path is passed through untouched as an opaque origin-form target; absolute-form
  targets and CONNECT are refused; redirects are returned to the browser, never
  followed (a `Location` naming the loopback upstream is rewritten to the public
  origin). `Host` and `Origin` reach the backend as the browser sent them, as do
  the app's own cookies and `Authorization`. `Forwarded`/`X-Forwarded-*`,
  hop-by-hop headers and Companion's cookie are removed.
- **Opening.** The authenticated gateway asks the proxy for a grant for that
  device: 256 random bits, single use, 60 seconds, bound to device, app and
  registration revision. The phone opens
  `https://<app-origin>/__companion_app_grant?grant=…` as a top-level page (this
  works even when the app forbids framing). The proxy consumes the grant, sets
  `__Host-companion-app` (HttpOnly, Secure, SameSite=Strict, host-only, Path=/,
  8 hours) and continues to `/` with a same-origin refresh. A 3xx redirect is not
  used because Strict cookies are withheld from a redirect chain that started on
  another site.
- **Every request** needs that session for that app, a paired device, phone
  access still on and the same revision. `Sec-Fetch-Site` must be `same-origin`
  or `none` when present, which refuses cross-site and sibling-app (same-site)
  requests even for GET. Unsafe methods and WebSocket handshakes also need the
  exact `Origin`. Only token hashes are kept, in memory; a proxy restart ends all
  phone app sessions.
- **Revocation**: revoking the phone, turning phone access off, changing or
  removing the registration, session expiry or an unreadable registry/device
  store ends sessions and closes their live WebSockets and streaming responses.
- **No replay.** The proxy never retries. If a backend fails after a request body
  was sent, the phone gets "outcome unknown; check the app before trying again".
  Uploads stream through (default limit 64 MiB).

The gateway's device token never reaches an app origin or backend: the phone
panel sends it only to the gateway's own origin. The app session cookie never
reaches the backend and cannot be set by it.

### Honest limits for phones

- **TLS and names.** A phone needs HTTPS for a secure context. `http://*.localhost`
  origins are for local tests only. Whether a given TLS terminator (for example
  Tailscale Serve) preserves the original `Host` header must be verified before
  activation; the proxy routes by it.
- **Sibling domains.** Apps on sibling host names under one registrable domain
  (for example two names in one tailnet) are same-site. The proxy refuses their
  requests, but a malicious app page could still set a `Domain=` cookie for the
  parent domain that other apps' pages then send. Distinct registrable domains
  avoid this. Companion's own cookie uses the `__Host-` prefix, which such cookies
  cannot imitate.
- **Safari.** Tests use headless Chromium. Safari supports Fetch Metadata since
  16.4 and `__Host-` cookies, but ITP, pop-up rules for `window.open` after an
  asynchronous step, back/forward cache and background suspension of WebSockets
  need a real iPhone check. Real iPhone activation is a later, separate step.
- The phone Apps list and the gateway endpoints are not wired yet (see status).

## Tests

```sh
npx tsx --test test/unit/apps-*.test.ts     # registry, lifecycle, desktop command, proxy
npx tsx --test test/apps/browser.test.ts    # real headless Chromium (needs /usr/lib/chromium)
```

The proxy tests use synthetic backends and probe unknown/rebinding hosts,
absolute-form targets, CONNECT, forged and cross-app cookies, cross-site and
sibling-app Fetch Metadata/Origin, header stripping and preservation, redirects
and cookie planting, uncertain POSTs without replay, 5 MiB streaming and oversized
uploads, WebSocket origin/session checks, and device revocation, phone opt-out,
registration changes and storage failure ending live connections.

The browser tests start the synthetic CSV notebook through the real lifecycle
code and check per-app profile separation and persistence, Chromium's sandbox
with the production arguments, CSV import through an intercepted real file
chooser, backend restart with automatic reconnection, and the phone grant flow
on synthetic `*.localhost` origins including grant replay, sibling-app
forgery and revocation.

They do not establish: real Wayland windows or compositor behavior, Safari or a
real phone, TLS termination or Tailscale, or long-running resource use.
Everything uses temporary registries, profiles, data and loopback ports.
