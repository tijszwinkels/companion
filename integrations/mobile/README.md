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

## Build and author checks

```sh
npm ci
npm run mobile:build     # → integrations/mobile/dist (static files)
npm run mobile:demo      # synthetic listener + gateway on http://127.0.0.1:8787
```

The demo prints a pairing code. Open the URL in a desktop browser with device
emulation or a narrow window, enter the code, and try the chats, Activity and
the rail, Previous sessions and Phone settings. Everything is synthetic: a scripted backend streams Markdown, tool calls
and choices, and no model, microphone, screen capture or personal data is involved.
Ctrl+C stops the demo and deletes its temporary directory. Use `--port N` for another
port.

Against a real listener: run `bin/companion-remote serve` (see the gateway README
for Tailscale/TLS options) with a listener built from this branch. Doing that with
the production listener, pairing a real phone or exposing it on the tailnet is a
separate, explicitly approved step.

The next user demo is a separately approved **live-session trial**, not this
synthetic fixture. See [the trial plan](../../docs/mobile-live-trial.md) for its
activation, pairing, cleanup and validation limits.

## Structure

| File                           | Responsibility                                                     |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/connection.ts`            | WebSocket, authentication, backoff, request correlation, no resend |
| `src/store.ts`                 | Protocol state: snapshots, incremental messages, Activity paging   |
| `src/markdown.ts`              | The desktop panel's vendored markdown-it, same safety settings     |
| `src/components/*.tsx`         | Screens: pairing, rail, Previous, conversation, Activity, settings |
| `src/styles.css`               | Desktop dark theme, safe areas, touch sizes, keyboard-aware layout |
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
horizontal overflow, accessible names and ≥44 px touch targets, streaming and
escaped Markdown, queued follow-ups, the 8-message queue refusal keeping the
draft, choices, stop, tool pages, Activity labels and pause, reconnect after a
gateway restart without replaying requests, revocation, and that no request goes
to another origin. Additional tests cover draft/send races across navigation,
sign-out/revocation clearing, browser Back, modal focus/Escape, Claude models
with fixed effort, rail reorder/close/reopen and a short 390×400 viewport.

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
network recovery opens a fresh connection and obtains current state. Foregrounding
or Retry now probes an existing OPEN connection first, preserving pending replies
when it is healthy; a failed five-second probe reconnects. Requests awaiting a reply become uncertain and are
never automatically resent. Drafts for open conversations and the new-conversation composer remain on this
browser across ordinary reconnects. Closing a conversation prunes its draft.
Sign-out/revocation clears saved drafts and cached conversation content; late
replies cannot restore them. Pending send state belongs to the shared store, so
changing pages cannot re-enable a second send or let an old acknowledgment clear
newer text. A connection that
fails to authenticate within ten seconds is retried with backoff.
An application heartbeat also detects silently dead OPEN sockets within about
35 seconds while browser timers run, including a final five-second probe. New
mutations are refused while that probe waits for a reply. Background timer suspension is recovered
on foregrounding; this is not a promise of background connectivity on iOS.

For the initial audit and review history, see
[the finish audit](../../docs/mobile-panel-finish.md).

## Navigation and accessibility

The preserved Rail/Previous design follows the desktop panel. The menu button
shows/hides the rail; long press, right click or Shift+F10 opens session actions.
Browser Back returns through pages and dismisses the top sheet/viewer first.
Forward restores pages, not already closed ephemeral dialogs. Dialogs keep focus
inside and make the underlying app inert; closure restores the opener or the
current page heading. Streaming transcripts are readable regions rather than
announcing every partial token. Notifications reserve layout space so they do
not cover navigation or send controls.

The small-height layout keeps the transcript and footer scrollable. Automated
Chromium viewport resizing is not evidence of real iOS keyboard behavior.
