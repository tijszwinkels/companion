# Widget service transport

The widget service ([`service.ts`](service.ts)) owns widget state, retained
bundles and the browser transport for widget and
[session application](../session-apps/README.md) views. How to write widgets is
in the [widget guide](../../widget-library/README.md). This file describes how
views are reached.

## Two routes, one set of capabilities

Every open widget view and application view has a capability: 64 hex
characters, random per view, ended when its conversation closes. Two routes
lead to the same views:

| Route    | Address                                             | Client                       |
| -------- | --------------------------------------------------- | ---------------------------- |
| Loopback | `http://127.0.0.1:<random port>/view/<capability>`  | desktop panel, native views  |
| Socket   | `$XDG_RUNTIME_DIR/companion/widgets.sock` (private) | phone gateway's frame origin |

The loopback route is unchanged: the desktop receives `viewUrl` with that
address, and agents use `/agent` with a turn lease.

The listener starts the socket route after binding its control socket
([`socket.ts`](socket.ts)). If that fails it logs the reason and continues:
the desktop does not need it. The socket is created 0600 in the control
socket's directory, which must be owned by the user and not group or world
accessible (checked, as for the gateway's own socket); a lifetime lock
`widgets.sock.lock` keeps a second listener from taking it over, and a stale
socket from a crash is removed.

## What the socket route checks

Unchanged from loopback, because it is the same code:

- the capability must be live (otherwise 404 `Unknown widget view`); a
  closed conversation is refused;
- each operation's method, `Content-Type: application/json` and body limit;
- viewport bounds, widget revisions, application code versions, the
  application's per-view checks and the desktop's chat read/send grants and
  rate limits.

Different on the socket:

- `Host` must be exactly `companion-widgets.invalid` and there must be no
  `Origin` header (loopback: `Host` must be `127.0.0.1:<port>` and an `Origin`,
  if any, that same origin). Browsers cannot open Unix sockets, so the
  loopback route's DNS-rebinding and cross-origin checks have no browser to
  defend against here; the fixed host and the absent origin keep requests
  that a proxy passed through from a browser out.
- Only the operations in [`frame-operations.ts`](frame-operations.ts) are
  served: the view document, `state`, `action`, `present`, `viewport`,
  `query`, `chat-read`, `chat-send` and `chat-receipt`. `/agent`, `frame`,
  `layout`, `input` and `popout` answer 404 as an unknown view.
- View documents do not contain the view's address. `bootstrap.api` is the
  fixed marker `location`, and the page derives its address from its own
  location (`integrations/widgets/host.js`), which in the phone case is the
  frame address the browser loaded.

The socket gives no process more reach than the loopback port: only this user
(and root) can connect to it, whereas any local process can connect to the
loopback port, and both need the same 256-bit capability. It offers fewer
operations.

See [the gateway's frame rules](../remote/README.md#widget-and-application-frames)
for how the phone gateway uses this route and what a widget page can reach
from a browser.

## Tests

`test/unit/widgets-socket.test.ts` covers the socket route: file mode and
directory checks, host and origin refusals, the served and refused
operations, and documents without the capability. The widget behavior itself
is covered by `test/unit/widgets.test.ts` and the session application tests.
