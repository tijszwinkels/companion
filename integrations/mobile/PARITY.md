# Phone panel parity with the desktop panel

Source basis: `integrations/panel/*.qml`, `integrations/window/*.qml` and the
desktop protocol in `src/desktop/README.md` at base `757ac7e`. Status meanings:

- **Implemented**: works in the phone app, covered by the named automated check
  where noted (browser = `test/mobile/app.test.ts`, gateway =
  `test/unit/remote-gateway.test.ts`, role = `test/unit/remote-panel-role.test.ts`).
- **Different**: same engine behavior with a phone-appropriate interaction.
- **Desktop-only**: acts on the computer's windows, keyboard, focus or audio;
  intentionally not exposed (refused by gateway and listener).
- **Gap**: not implemented yet.

Nothing here has been validated on a real iPhone, in Safari, or over Tailscale.

## Activity

| Desktop capability                                  | Phone        | Notes                                                                         |
| --------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Listening state, pause reason, speaking, processing | Implemented  | Status card; speaking ring. Browser: pause toggle.                            |
| Pause / resume listening                            | Implemented  | Mic button and Settings switch. Receipts prevent a replayed toggle (gateway). |
| Sound feedback toggle                               | Implemented  | Settings; sounds play on the computer.                                        |
| Current-run history, paged, live updates, removals  | Implemented  | Revision-guarded like the desktop. Browser: Activity.                         |
| Recent history snapshot (latest 100, earlier runs)  | Gap          | Only this run's history is shown.                                             |
| Card: Copy                                          | Implemented  | Phone clipboard.                                                              |
| Card: Insert into application                       | Desktop-only | Pastes into a desktop window.                                                 |
| Card: New coding session from utterance             | Implemented  | Uses the saved screenshot on the computer; opens in the desktop background.   |
| Card: Label correct / incorrect / actual intent     | Implemented  | Browser: label correct.                                                       |
| Card: Delete utterance and recordings               | Implemented  | Only when the listener advertises deletion.                                   |
| Type an utterance to the focused application        | Desktop-only | Needs a compositor window target. Phone substitute: start a conversation.     |
| Intent and shortcut switches (independent)          | Implemented  | Settings; older listeners shown as read-only with a restart note.             |
| Keyboard shortcut help, phrase animation            | Different    | Not applicable on a phone; simple speaking indicator.                         |

## Conversations

| Desktop capability                                                                                   | Phone        | Notes                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open conversation rail in authoritative order                                                        | Implemented  | Chats list with status, model, preview.                                                                                                                               |
| Reorder by dragging a tab                                                                            | Different    | "Move earlier/later" in the conversation menu (same `move-agent` + order revision).                                                                                   |
| Close conversation (saved to Previous)                                                               | Implemented  | Menu.                                                                                                                                                                 |
| Previous sessions and reopen                                                                         | Implemented  | Opens the reopened conversation on the phone.                                                                                                                         |
| Start a conversation                                                                                 | Different    | Desktop starts by voice/typed Activity; phone has "New" (coding or quick question), text-only, no screenshot, opens in the background on the desktop. Role + gateway. |
| User, assistant, tool, notice messages; Markdown                                                     | Implemented  | Same vendored markdown-it, HTML escaped, http(s) links only. Browser: escaping.                                                                                       |
| Agent/external message origin labels                                                                 | Implemented  | "From title" / "external (unverified)".                                                                                                                               |
| Queued follow-ups shown as queued                                                                    | Implemented  | Browser.                                                                                                                                                              |
| Screenshot attachment and viewer                                                                     | Implemented  | Authenticated fetch; viewer uses native pinch zoom rather than custom zoom/pan controls.                                                                              |
| Copy message                                                                                         | Implemented  | Assistant messages.                                                                                                                                                   |
| Tool groups: lazy pages, next, from start, refresh, copy, stale marker                               | Implemented  | Browser: expansion. Uses the phone's 20 s request timeout instead of 10 s.                                                                                            |
| Composer: send, queue while running (max 8), keep draft on failure, clear only what was sent         | Implemented  | Browser: queue and refusal. Drafts persist per conversation on the phone.                                                                                             |
| Stop current run / stop agent                                                                        | Implemented  | Stop button while running; menu "Stop working". Browser.                                                                                                              |
| Choices                                                                                              | Implemented  | Scoped to the phone's own selection (role test). Browser.                                                                                                             |
| Model and effort per conversation, pinned/show all, refresh, catalogue warning, unavailable override | Implemented  | Gateway: catalogue.                                                                                                                                                   |
| Turn-completed chime                                                                                 | Different    | Chime stays on the computer; the phone shows an in-app toast.                                                                                                         |
| Agent-proposed composer drafts (`agent-draft`)                                                       | Desktop-only | The listener drafts into desktop panels only; the phone is never a draft host.                                                                                        |
| Interactive widgets                                                                                  | Gap          | Placeholder card with the widget name; widgets open on the computer.                                                                                                  |
| Reader zoom 80–200 %                                                                                 | Gap          | Uses the phone's default text size.                                                                                                                                   |
| Voice navigation "go to session N", composer dictation focus                                         | Desktop-only | Would otherwise redirect desktop dictation; role test proves the phone cannot.                                                                                        |
| Media-playback auto-pause reports                                                                    | Desktop-only | Desktop media state.                                                                                                                                                  |

## Phone-only

| Capability                                                                           | Status                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Pairing with one-time code; sign out; revocation handling                            | Implemented (browser, gateway)                                |
| Connection, reconnecting, listener unavailable, offline states with retry            | Implemented (browser reconnect/offline/re-pair, gateway 4503) |
| No automatic resend of unconfirmed requests; server receipts                         | Implemented (gateway)                                         |
| Light/dark themes, safe areas, keyboard-aware layout                                 | Implemented; safe area and keyboard not verifiable headless   |
| Push notifications, background connection, share sheet, haptics, on-phone microphone | Gap (need a native wrapper and design)                        |
