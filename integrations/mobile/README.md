# Companion phone panel

A phone-first web version of the Companion panel. The app is served by the opt-in
[remote gateway](../../src/remote/README.md) and talks to the listener through it.
Speech, screen context, routing, agents and storage stay on the computer. The app
loads nothing from any other origin.

It is Companion's own panel on the phone: conversations, chat, follow-ups, stop,
choices, model/effort, Previous/reopen/close/reorder, Activity history with labels,
deletion and new sessions, listening/sound/intent switches. The
[parity matrix](PARITY.md) lists exactly what matches the desktop panel, what differs,
and what is missing.

## Build and try

```sh
npm ci
npm run mobile:build     # → integrations/mobile/dist (static files)
npm run mobile:demo      # synthetic listener + gateway on http://127.0.0.1:8787
```

The demo prints a pairing code. Open the URL in a desktop browser with device
emulation or a narrow window, enter the code, and try the chats, Activity and
Settings. Everything is synthetic: a scripted backend streams Markdown, tool calls
and choices, and no model, microphone, screen capture or personal data is involved.
Ctrl+C stops the demo and deletes its temporary directory. Use `--port N` for another
port.

Against a real listener: run `bin/companion-remote serve` (see the gateway README
for Tailscale/TLS options) with a listener built from this branch. Doing that with
the production listener, pairing a real phone or exposing it on the tailnet is a
separate, explicitly approved step.

## Structure

| File                           | Responsibility                                                     |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/connection.ts`            | WebSocket, authentication, backoff, request correlation, no resend |
| `src/store.ts`                 | Protocol state: snapshots, incremental messages, Activity paging   |
| `src/markdown.ts`              | The desktop panel's vendored markdown-it, same safety settings     |
| `src/components/*.tsx`         | Screens: pairing, chats, conversation, Activity, settings          |
| `src/styles.css`               | Light/dark tokens, safe areas, touch sizes, keyboard-aware layout  |
| `build.ts`                     | esbuild bundle (Preact) plus static files                          |
| `demo.ts`                      | Synthetic end-to-end demo                                          |
| `../../src/remote/protocol.ts` | Typed wire contract shared with the gateway                        |

Stack: Preact (≈10 KB) and esbuild, both pinned dev dependencies; the bundle is
self-contained static files. `npm run check` typechecks the app with its own
`tsconfig.json` (DOM + JSX); the app imports listener types only as types.

## Tests

`npm run test:mobile` runs the built app in headless Chromium with phone emulation
(touch, 320/390/430 px wide, 3× density), against the real gateway and listener
control socket with a synthetic agent backend. It checks pairing, layout without
horizontal overflow, accessible names and ≥32 px touch targets, streaming and
escaped Markdown, queued follow-ups, the 8-message queue refusal keeping the
draft, choices, stop, tool pages, Activity labels and pause, reconnect after a
gateway restart without replaying requests, revocation, and that no request goes
to another origin.

Not tested: real iOS Safari/WebKit, the on-screen keyboard, actual safe-area insets,
a real phone on Tailscale, or long-running battery/network behavior.

## iPhone wrapper (later)

The app is structured for a wrapper such as Capacitor but no wrapper exists yet:

- Static, relative asset paths; `dist/` can be bundled as the wrapper's web assets.
- When loaded from a non-HTTP origin (e.g. `capacitor://localhost`) the pairing
  screen has an address field, but bundled/custom origins are **not supported**
  by the gateway today. A wrapper requires an explicit CORS, transport and secure
  credential design; adding an origin alone does not enable it.
- `viewport-fit=cover` with `env(safe-area-inset-*)` padding and
  `interactive-widget=resizes-content` with dynamic viewport units for the keyboard.
- The device token currently lives in `localStorage`; a wrapper should move it to
  the Keychain.
- Not available to a web app and therefore not implemented: push notifications
  for finished answers (the app shows in-app toasts only while open), background
  connections, Siri/Shortcuts, share sheet, haptics, and on-phone microphone input.
  Phone-side speech would also need its own privacy design, since today all speech
  processing is local to the computer.

Signing, installing on a device and App Store distribution are separate, approved
steps.

## Connection behavior

Sign out and pair again without reloading. Network loss retires the old socket;
network recovery, foregrounding the app, or Retry now opens a fresh connection
and obtains current state. Requests awaiting a reply become uncertain and are
never automatically resent. Drafts remain on this browser. A connection that
fails to authenticate within ten seconds is retried with backoff.

For a safe synthetic walkthrough and the current review/ownership limits, see
[the finish audit](../../docs/mobile-panel-finish.md).
