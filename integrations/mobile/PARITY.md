# Phone panel parity with the desktop panel

Source basis: `integrations/panel/*.qml`, `integrations/window/*.qml` and the
desktop protocol in `src/desktop/README.md` at live baseline `3fdc5d0`, with the authorized Rail/Previous draft integrated from `5afab73`. Status meanings:

- **Implemented**: works in the phone app, covered by the named automated check
  where noted (browser = `test/mobile/app.test.ts`, gateway =
  `test/unit/remote-gateway.test.ts`, role = `test/unit/remote-panel-role.test.ts`).
- **Different**: same engine behavior with a phone-appropriate interaction.
- **Desktop-only**: acts on the computer's windows, keyboard, focus or audio;
  intentionally not exposed (refused by gateway and listener).
- **Gap**: not implemented yet.

Initial iPhone Safari access over Tailscale and the composer gap and footer fixes
were user-confirmed on 2026-09-28. The rows below have not each been validated on
a physical device.

## Activity

| Desktop capability                                  | Phone        | Notes                                                                                                         |
| --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| Listening state, pause reason, speaking, processing | Implemented  | Status card; speaking ring. Browser: pause toggle.                                                            |
| Pause / resume listening                            | Implemented  | Mic button and Settings switch. Receipts prevent a replayed toggle (gateway).                                 |
| Sound feedback toggle                               | Implemented  | Settings; sounds play on the computer.                                                                        |
| Current-run history, paged, live updates, removals  | Implemented  | Revision-guarded like the desktop. Browser: Activity, including audio-only/recovered transcript explanations. |
| Recent history snapshot (latest 100, earlier runs)  | Gap          | Only this run's history is shown.                                                                             |
| Card: Copy                                          | Implemented  | Phone clipboard.                                                                                              |
| Card: Insert into application                       | Desktop-only | Pastes into a desktop window.                                                                                 |
| Card: New coding session from utterance             | Implemented  | Uses the saved screenshot on the computer; opens in the desktop background.                                   |
| Card: Label correct / incorrect / actual intent     | Implemented  | Browser: label correct.                                                                                       |
| Card: Delete utterance and recordings               | Implemented  | Confirmation required; only when the listener advertises deletion.                                            |
| Type an utterance to the focused application        | Desktop-only | Needs a compositor window target. Phone substitute: start a conversation.                                     |
| Intent and shortcut switches (independent)          | Implemented  | Activity; older listeners shown as read-only with a restart note.                                             |
| Keyboard shortcut help, phrase animation            | Different    | Not applicable on a phone; simple speaking indicator.                                                         |

## Conversations

| Desktop capability                                                                                   | Phone        | Notes                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open conversation rail in authoritative order                                                        | Implemented  | Collapsible rail, working indicators and unread markers; desktop arrivals never change the phone page.                                                                                            |
| Reorder by dragging a tab                                                                            | Different    | "Move up/down" in the conversation menu (same `move-agent` + order revision).                                                                                                                     |
| Close conversation (saved to Previous)                                                               | Implemented  | Menu.                                                                                                                                                                                             |
| Previous sessions and reopen                                                                         | Implemented  | Opens the reopened conversation on the phone.                                                                                                                                                     |
| Start a conversation                                                                                 | Different    | Desktop starts by voice/typed Activity; phone has Activity’s "Start a conversation" (coding or quick question), text-only, no screenshot, opens in the background on the desktop. Role + gateway. |
| User, assistant, tool, notice messages; Markdown                                                     | Implemented  | Same vendored markdown-it, HTML escaped, http(s) links only. Browser: escaping.                                                                                                                   |
| Agent/external message origin labels                                                                 | Implemented  | "From title" / "external (unverified)".                                                                                                                                                           |
| Queued follow-ups shown as queued                                                                    | Implemented  | Browser.                                                                                                                                                                                          |
| Screenshot attachment and viewer                                                                     | Implemented  | Authenticated fetch; viewer uses native pinch zoom rather than custom zoom/pan controls.                                                                                                          |
| Copy message                                                                                         | Implemented  | Assistant messages.                                                                                                                                                                               |
| Tool groups: lazy pages, next, from start, refresh, copy, stale marker                               | Implemented  | Browser: expansion. Uses the phone's 20 s request timeout instead of 10 s.                                                                                                                        |
| Composer: send, queue while running (max 8), keep draft on failure, clear only what was sent         | Implemented  | Browser: queue/refusal and delayed acknowledgments across navigation. Drafts persist for open conversations; sign-out/revoke clears them.                                                         |
| Stop current run / stop agent                                                                        | Implemented  | Stop button while running. Browser.                                                                                                                                                               |
| Choices                                                                                              | Implemented  | Scoped to the phone's own selection (role test). Browser.                                                                                                                                         |
| Model and effort per conversation, pinned/show all, refresh, catalogue warning, unavailable override | Implemented  | Expandable controls: Pi has pinned/show-all and effort; Claude has its own catalogue and fixed creation-time effort. Browser: Claude selection.                                                   |
| Turn-completed chime                                                                                 | Different    | Chime stays on the computer; the phone shows an in-app toast.                                                                                                                                     |
| Agent-proposed composer drafts (`agent-draft`)                                                       | Desktop-only | The listener drafts into desktop panels only; the phone is never a draft host.                                                                                                                    |
| Interactive widgets                                                                                  | Gap          | Placeholder card with the widget name; widgets open on the computer.                                                                                                                              |
| Reader zoom 80–200 %                                                                                 | Gap          | Uses the phone's default text size.                                                                                                                                                               |
| Voice navigation "go to session N", composer dictation focus                                         | Desktop-only | Would otherwise redirect desktop dictation; role test proves the phone cannot.                                                                                                                    |
| Media-playback auto-pause reports                                                                    | Desktop-only | Desktop media state.                                                                                                                                                                              |

## Phone-only

| Capability                                                                           | Status                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Pairing with one-time code; sign out; revocation handling                            | Implemented (browser, gateway)                                |
| Connection, reconnecting, listener unavailable, offline states with retry            | Implemented (browser reconnect/offline/re-pair, gateway 4503) |
| No automatic resend of unconfirmed requests; server receipts                         | Implemented (gateway)                                         |
| Desktop dark theme, safe areas, keyboard-aware layout                                | Implemented; safe area and keyboard not verifiable headless   |
| Push notifications, background connection, share sheet, haptics, on-phone microphone | Gap (need a native wrapper and design)                        |

Browser Back/modal focus, 44 px targets and short-viewport controls have Chromium
automated coverage. Tijs reported initial iPhone Safari access and confirmed the
composer gap/home-indicator spacing fix on 2026-09-28. Physical keyboard states,
screen-reader behavior, network handover and the complete live interaction matrix
remain unvalidated; initial phone use is not blanket parity acceptance.
