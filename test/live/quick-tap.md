# Quick-tap insertion regression

`npm run test:quick-tap` starts a disposable nested Hyprland and runs the real
adapter and desktop recovery code. The adapter copy uses a separate shortcut
identity, Super+Alt+F12, and private socket/database. All transcripts are synthetic.
No clipboard command, microphone, LLM request, or live conversation is involved.
The compositor process owns all fixture bindings and is discarded afterward.

The default editor is GTK 4. To run the same cases in native Wayland Chromium,
point at an existing Playwright installation (no project dependency is added):

```sh
COMPANION_TEST_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs npm run test:quick-tap
```

The runner prints the selected editor. Chromium supplies a startup record with
its browser version; the runner requires that record before testing. The original
runner in `03e2065` ignored `COMPANION_TEST_PLAYWRIGHT`, so runs previously
reported as full Chromium validation actually used GTK. That validation claim
was incorrect. The corrected browser fixture exposes additional `wtype`/Chromium
failures, independently of the shortcut-release fix.

In Chromium 153, plain `wtype` with no shortcut or held modifiers changed
`-k Return; café — naïve! Ελληνικά 🙂 Next field` into
`k Return; ca — naïve! Ελληνικά  Next field`. This browser baseline is a known
delivery limitation, not a passing shortcut regression. The release guard does
not change the text transport or claim to fix this separate failure.

The browser uses a temporary profile and local textarea pages. Set
`COMPANION_TEST_CHROMIUM` if Chromium is not `/usr/bin/chromium`. This exercises a
browser editor, not the actual Mattermost editor. On 2026-09-18, the user confirmed
that the shortcut fix worked after installing adapter revision
`code-1400c6af3168`. This physical test confirms the reported modifier-release
symptom; it does not establish correctness for every browser/Unicode combination.

For an A/B comparison, `COMPANION_TEST_ADAPTER=/absolute/path/to/adapter` selects
another adapter source directory containing `bindings.lua` and `plugin/`.

## Evidence on Hyprland 0.56.2

The original adapter at `d2fad18` sends recovery on V-up even if Super/Alt remain
down. With a zero-duration V hold and modifiers released 350/430 ms afterward,
the original fixture inserted ` Return; café — naïve! Ελληνικά 🙂 Next field`
instead of `-k Return; café — naïve! Ελληνικά 🙂 Next field`. Its existing 150 ms
backend delay had elapsed before those modifiers were released.

Independent GTK and Chromium probes also lost letters when modifier releases
overlapped `wtype`; the same text was exact when modifiers were already released.
Hyprland's `CInputManager::onKeyboardMod` merges keyboard modifier states, and
`onKeyboardKey` runs binding matching before forwarding virtual keys. This
explains why a transcript can lose letters to shortcut handling.

The fix waits for V and both sides of Super/Alt to be up before sending `finish`,
and removes the QML delivery handler for the premature `history` release.
`hl.is_key_down` still includes the current released key inside a release
callback, so the callback explicitly excludes that key. No delay is increased.

The Lua unit fixture checks all six release orders with left/right modifiers
and both sides held together. The compositor fixture checks immediate and
500 ms holds, separated modifier releases, literal dashes/punctuation/Unicode,
no Enter, held selection, Escape cancellation, focus changes, exactly-once
delivery, and preservation of the original recognized intent/outcome. Synthetic
modifier tests emit key events as well as masks: `wtype -M/-m` alone does not model
physical modifier key-down/up events.

## Fixture isolation

An early test against the user's compositor crashed Hyprland during cleanup:
the picker had already unbound navigation handles, and unbinding those expired
handles again hit a null dereference in Hyprland 0.56.2. The final fixture does
not enumerate or unbind stale handles. It requires the nested launcher and
discards the entire test compositor instead. No production adapter was installed
when that crash occurred.
