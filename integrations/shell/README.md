# Companion browser shell

Status: first slice (2026-11). The desktop chat page in an ordinary browser,
against the existing remote gateway. The goal of the larger project is the
whole sidebar in a browser, so the interface can run on another computer
(macOS, Windows) than the listener; this slice covers one conversation at a
time.

A paired browser can:

1. pair with the gateway and reconnect, exactly as the phone panel does;
2. pick one open conversation from a plain list (Back returns to the list);
3. show it with the **desktop chat page** (`../session-apps/chat/Chat.tsx`,
   unchanged): streaming transcript, Markdown, tool-group summary rows and
   origin labels;
4. send a message, queue a follow-up while the agent runs, stop the run,
   answer offered choices and close the conversation;
5. page through older and newer history, as the desktop does;
6. show connection loss and recovery without resending anything.

## How it works

```text
Chat.tsx + ChatStore ──NativeBridge──▶ GatewayChatBridge ──▶ phone Store/Connection ──WSS──▶ gateway ──▶ listener
 (session-apps/chat, unchanged)          (src/bridge.ts)       (mobile/src, imported)
```

In the Qt host the chat page talks to `TrustedChatView.qml` over QWebChannel.
Here `src/bridge.ts` implements the same `NativeBridge` interface
(`../session-apps/chat/protocol.ts`) on top of the phone panel's `Store` and
`Connection` (imported, not copied):

- It sends the page the same `rows` and `status` messages as the Qt host, with
  the same sequence-number rules: every message is numbered, `ready()` resends
  everything in full, rows are diffed with `ChatState.diffRows` and coalesced
  for 30 ms, status is sent whole when it changed. Rows are built with
  `ChatState.chatRow` from a TypeScript port of `SessionView.rowData()`
  (`src/rows.ts`).
- It checks every page request again against the shown conversation, like the
  Qt bridge, and maps it to a gateway action: Send/Queue → `send-agent`,
  choices → `choose-agent`, Stop → `stop-agent-run` or `stop-agent`, Close
  session → `close-agent`, history → `agent-history-page`. These are all in
  the gateway's remote allowlist (`src/remote/protocol.ts`); nothing else
  leaves the page except the phone Store's own `panel-state` selection report.
- Resident history (`src/history.ts`) is a port of `SessionView.qml`'s paging
  on the shared `../panel/HistoryRows.mjs`: contiguous joins only, at most
  three pages resident, rows the reader can see are never trimmed, one request
  at a time with a 10 s deadline, failures only retried by the reader, empty
  pages not requested again. The chat page reports only whether the reader is
  at the end; arriving at the end of a detached snapshot loads the next newer
  page (the Qt host does this from its own scroll handler instead).
- Connection loss: the phone Connection reconnects with backoff and never
  resends a request whose answer did not arrive; such a send keeps its text in
  the editor with an explanation. The page shows a banner and the chat's
  "Disconnected" state; sending, choosing, stopping and closing are refused
  while offline.

### Differences from the desktop chat

Shown as unavailable through the existing `status` fields, not by changing
the chat page:

| Desktop feature                                | In the browser                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Recording into the text box                    | `recording.available: false` (no Record button)                                                        |
| Listener-owned and agent-proposed drafts       | The draft is kept in this page per conversation, as on the phone; `draftUnsaved` is always empty       |
| Classic view, tool details, widgets            | The page's Classic view and tool-group buttons show "not available in the browser yet" in `inputError` |
| Session applications                           | `application: null`                                                                                    |
| Screenshots                                    | Labelled "screenshot unavailable"; no viewer yet                                                       |
| Voice target, voice hints, focus shortcut      | `voiceTarget: false`, `voiceStatus` and `focusShortcut` empty; choices are clicked                     |
| Rail, Activity, settings, model picker, timers | Not in this slice                                                                                      |

The gateway also limits a message to 4,000 characters (the desktop allows
8,000), so `maximumMessageLength` is 4,000. Links in answers open in a new tab
without opener or referrer. Copy uses the browser clipboard.

## Build, demo and tests

```sh
npm ci
npm run shell:build      # → integrations/shell/dist (index.html, app.js, app.css)
npm run shell:demo       # synthetic listener + gateway on http://127.0.0.1:8788
npm run test:shell       # headless Chromium against the real gateway
```

The demo prints a pairing code; open the URL in a desktop browser and enter it.
A scripted backend streams Markdown, tool calls and choices; no model,
microphone, screen capture or personal data is involved. Ctrl+C stops it and
deletes its temporary directory. `--port N` picks another port.

Against a real listener, serve the shell with the gateway's existing option:
`bin/companion-remote serve --app-directory integrations/shell/dist` (see the
[gateway README](../../src/remote/README.md) for origins and TLS). Pairing a
real browser or exposing the gateway beyond loopback is a separate, explicitly
approved step.

`npm run test:shell` (`test/shell/`) runs the built shell in headless Chromium
at desktop sizes, on the phone tests' fixtures (real gateway, real listener
control socket, synthetic agent backend, temporary directories, loopback). It
covers pairing; the list and picking a conversation; a streamed Markdown answer
with agent HTML kept literal; send; a follow-up queued while running; a choice;
stop; close; loading older pages while scrolling up, newer pages below a
detached snapshot and Jump to latest; reconnect after a gateway restart with no
request replayed; that every request and socket goes to the gateway's origin
only; no Content-Security-Policy violation under the gateway's real policy; and
no horizontal overflow at 420 px and 1280 px. With
`COMPANION_SHELL_SCREENSHOTS=<directory>` it also saves screenshots of a
synthetic conversation at both widths (keep them out of Git).

Not tested: Safari, Firefox and Windows browsers, a real network or Tailscale,
and the Qt host itself (`npm run test:window`, `test/session-apps-ui/`).

## Structure

| File             | Responsibility                                                            |
| ---------------- | ------------------------------------------------------------------------- |
| `src/main.tsx`   | Creates the phone Store, the bridge and the chat page's ChatStore         |
| `src/App.tsx`    | Pairing, conversation list, header, connection banner, toasts             |
| `src/bridge.ts`  | `NativeBridge` over the gateway: rows/status messages, request mapping    |
| `src/history.ts` | Resident history pages (port of SessionView's paging on HistoryRows.mjs)  |
| `src/rows.ts`    | Port of `SessionView.rowData()`, through `ChatState.chatRow`              |
| `src/styles.css` | The frame around the chat; the chat keeps its desktop stylesheet          |
| `build.ts`       | esbuild bundle (Preact) plus `public/index.html`; no network dependencies |
| `demo.ts`        | Synthetic end-to-end demo                                                 |
