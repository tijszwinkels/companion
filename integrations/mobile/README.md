# Companion phone panel

A phone-first web version of the Companion panel. The app is served by the opt-in
[remote gateway](../../src/remote/README.md) and talks to the listener through it.
Speech, screen context, routing, agents and storage stay on the computer. The app
loads nothing from any other origin.

It is Companion's own panel on the phone: conversations, chat, follow-ups, stop,
choices, model/effort, Previous/reopen/close/reorder, Activity history with labels,
deletion and new sessions, listening/sound/intent switches. When the gateway offers
[local apps](../../docs/local-apps.md), an **Apps** header button lists them and opens
one in a new top-level tab on the app's own origin (`src/components/Apps.tsx`); the
app never runs inside the panel or sees its device token. The
[parity matrix](PARITY.md) lists exactly what matches the desktop panel, what differs,
and what is missing.

## Trial and merge status — 2026-09-28

The supervised trial is running with listener/UI `522b85c` and gateway/app
`166bbb2` in separate worktrees. Tijs reported successful iPhone Safari access,
then confirmed the composer gap was gone and the footer clear after the reviewed
spacing fix. He said he is liking the panel and explicitly approved merging this
phone feature. Final whole-feature integration clearance and the lead's guarded
merge are separate from that approval; this document does not claim the merge
has happened. The separate widget parity work is not included.

Independent Claude Opus 5.5/high reviews cover the full feature at `522b85c`,
the tailnet changes through `a7858f1`, and the combined spacing fix at `166bbb2`.
Automated evidence includes Chromium, isolated real-backend checks and Linux
WebKitGTK. User-reported phone access and layout results do not establish native
keyboard behavior, network handover, screen readers or every live send/reconnect/
revoke path. Those remain explicit trial limits.

The switcher owns the running processes. A Git merge does not restart, redeploy,
re-pair or change Tailscale. Keep worktrees used by live processes until a later
coordinated shutdown; preserve the original dirty frontend worktree. For setting
up supervised phone access over a tailnet, follow
[phone access](../../docs/mobile-startup.md).

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
port. `--apps` also starts the synthetic CSV notebook local app and offers it through
the app proxy on `http://csv-notebook.localhost:N+3` (Chromium resolves `*.localhost`
to this computer).

Against a real listener: run `bin/companion-remote serve` (see the gateway README
for Tailscale/TLS options) with a listener built from this branch. Doing that with
the production listener, pairing a real phone or exposing it on the tailnet is a
separate, explicitly approved step.

Use with live sessions is separate from this synthetic fixture. See
[phone access](../../docs/mobile-startup.md) for its activation, pairing, cleanup
and validation limits.

## Structure

| File                           | Responsibility                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/connection.ts`            | WebSocket, authentication, backoff, request correlation, no resend; limit refusals                    |
| `src/store.ts`                 | Protocol state: snapshots, incremental messages, Activity paging; unread marks and the visible report |
| `src/markdown.ts`              | The desktop panel's vendored markdown-it, same safety settings                                        |
| `src/components/*.tsx`         | Screens: pairing, rail, Previous, conversation, Activity, settings                                    |
| `src/styles.css`               | Desktop dark theme, safe areas, touch sizes, keyboard-aware layout                                    |
| `../chat-ui/`                  | Conversation styles and icons, in a page-neutral place                                                |
| `build.ts`                     | esbuild bundle (Preact) plus static files                                                             |
| `demo.ts`                      | Synthetic end-to-end demo                                                                             |
| `../../src/remote/protocol.ts` | Typed wire contract shared with the gateway                                                           |

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
`test/mobile/apps.test.ts` pairs, lists a synthetic local app and opens it in a new
tab on its own origin without opener access or the panel's storage.
`test/mobile/limit-and-unread.test.ts` checks the listener's unread mark on
the phone (kept after a reload, cleared by another tab showing it) and the
limit page (the fifth tab, Retry after a tab closed, the ninth connection);
the rule tables are played in Node in `test/shell/markers.test.ts` and
`test/shell/limit-page.test.ts`.

Not tested by this suite: physical iOS Safari, the on-screen keyboard, actual safe-area insets,
a real phone on Tailscale, or long-running battery/network behavior.

## iPhone wrapper (later)

The app is structured for a wrapper such as Capacitor but no wrapper exists yet:

- Static, relative asset paths; `dist/` can be bundled as the wrapper's web assets.
- When loaded from a non-HTTP origin (e.g. `capacitor://localhost`) the pairing
  screen has an address field, but bundled/custom origins are **not supported**
  by the gateway today. A wrapper requires an explicit CORS, transport and secure
  credential design; adding an origin alone does not enable it.
- `viewport-fit=cover` with `env(safe-area-inset-*)` padding. Dynamic viewport units
  track the browser's available layout height. `interactive-widget=resizes-content`
  requests keyboard resizing where supported; it does not guarantee it on Safari.
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

## Unread marks and the visible report

The rail's unread markers (the dot and the menu button's count) are the
listener's shared unread mark, the same on every device: set when a turn
completes successfully while no device shows that conversation on a visible
page, cleared when one does, saved with the conversation, so they survive a
reload and a reconnect. The rules are the browser shell's, because the two
share the Store (`src/store.ts`): see
[marker source and visible report](../shell/README.md#marker-source). In
short:

- A conversation's marker is its `unread` field whenever the conversation
  as last received carries it; without it (an older listener) the Store's
  own rule marks it, as before (completed turns this page has not seen since
  it loaded).
- The phone reports `panel-state` `{id, visible}`: `visible` is true while
  the page is visible and a conversation page is the one on screen (the
  selected conversation, with no sheet, menu or screenshot viewer over
  it). Activity and Previous sessions report no conversation. The report
  is sent after each connection's first snapshot and again whenever the
  selection or `visible` changes, never twice the same.
- The "… — answer ready" toast stays the phone's own, as before.

What changed for the phone: before, every finished conversation showed as
unread after a reload, and reading one on the computer or another device
did not clear it here; now the mark follows the listener. A conversation
started elsewhere is no longer marked when it arrives, only when a turn
completes unseen. A page in a background tab no longer reports its
conversation as shown.

## The limit page

The gateway admits at most 4 connections per paired device and 8 in all.
Refused over one of them (close code 4429 with the reason `device` or
`total`), the phone shows the limit page instead of retrying: "This browser
already has four Companion tabs connected. Close one you do not need, then
Retry." or "Companion already has eight browsers and phones connected. Close
one you do not need, then Retry.", with a Retry button. Nothing reconnects
by itself while it is shown (no timer, not when the app is foregrounded or
the network returns); no other tab or phone is closed. An open sheet or
menu closes when the limit page appears (none holds typed text). A refusal without one
of these reasons (an older gateway) keeps the earlier behaviour, a retry
with backoff. The full rule and its table are the browser shell's
([the limit page](../shell/README.md#the-limit-page)); the code is shared
(`src/connection.ts`, `src/components/LimitPage.tsx`).

## Navigation and accessibility

The preserved Rail/Previous design follows the desktop panel. The menu button
shows/hides the rail; long press, right click or Shift+F10 opens session actions.
Browser Back returns through pages and dismisses the top sheet/viewer first.
Forward restores pages, not already closed ephemeral dialogs. Dialogs keep focus
inside and make the underlying app inert; closure restores the opener or the
current page heading. Streaming transcripts are readable regions rather than
announcing every partial token. Notifications reserve layout space so they do
not cover navigation or send controls.

Long conversations show a bounded recent window. **Load older**, **Newer**,
**Refresh** and **Latest** navigate older history without changing the draft or
starting a turn. A history page stays still while new answers arrive; Refresh
reads its current version. Very large messages show labelled text fragments.

The small-height layout keeps the transcript and footer scrollable. Automated
Chromium viewport resizing is not evidence of real iOS keyboard behavior.

## Composer spacing on short browser viewports

At heights of 700 CSS pixels or less, the transcript starts at 40dvh (at least
140px) and grows into spare space. Keeping it fixed at 40dvh left a 144px blank
tail below the conversation controls at 390×664, reproduced in both Chromium
and Linux WebKitGTK. Safari's browser chrome can put a tall iPhone inside this
short-height layout even while its keyboard is closed. The regression checks the
700/701px boundary, resize/rotation, draft retention, expanded model controls and
simulated 0/21/34px bottom insets. The footer owns the bottom safe-area padding,
so the collapsed summary stays above the home indicator too; expanding the
picker does not add the inset a second time. Tests check the actual control
position, not just the CSS inset value.

This fixes unused flex-layout space; it does not infer keyboard height from a
safe-area inset or subtract a second viewport offset. Safari can resize/pan its
visual viewport when the keyboard opens without resizing the layout viewport;
see [WebKit's interactive-widget issue](https://bugs.webkit.org/show_bug.cgi?id=259770).
Real toolbar, keyboard-open/close and home-indicator behavior still need a
supervised iPhone check after an approved reload. No live gateway or Tailscale
change is part of the isolated regression tests.
