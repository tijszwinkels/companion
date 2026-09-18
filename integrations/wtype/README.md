# Printable keycodes for literal text

This is a focused patch for **wtype v0.4**, not a change to Companion's delivery
queue, focus checks, pacing, cancellation, clipboard, or explicit Enter behavior.
It is not installed automatically. Companion continues to call `wtype` from
PATH; the running listener and system executable stay unchanged by these files.

## Demonstrated failure

In a nested Hyprland 0.56.2 / native Wayland Chromium 153.0.8010.36 textarea,
`wtype -d 1 -- "let's just keep it open."` produces `let's just keep it ope`.
The period is the 14th distinct character. wtype assigns it Linux evdev code 14,
which is physically Backspace. The browser reports:

```text
keydown:     key=".", code="Backspace", keyCode=8
beforeinput: inputType="deleteContentBackward"
input:       inputType="deleteContentBackward"
```

The `n` was inserted and then deleted. A 50 ms character delay gives the same
result. Companion's shared `typeText` reproduces it with the 1 ms pacing change
from `1570f49`, so neither ASR/history nor the shortcut release guard causes this
particular failure. See [upstream issue #71](https://github.com/atx/wtype/issues/71).

## Patch behavior

For invocations containing only literal text and pacing options, map characters
onto the 48 printable physical key positions. Escape, Backspace, Tab, Return,
modifiers, and navigation keys are never assigned to printable text. For more
than 48 distinct symbols, load another bounded keymap between complete
press/release pairs. This changes physical codes, not the text or its order.

Invocations with explicit `-k`, `-P`, `-p`, `-M`, or `-m` commands retain the
original mapping. That preserves deliberate key chords and avoids changing a
keymap while an explicitly pressed key is held. Companion's optional Return
command remains separate from the literal text command.

Supplementary Unicode remains a separate Chromium limitation: `🙂` still becomes
U+F642 through its UTF-16 `KeyEvent` conversion. This patch does not claim to fix
all browser Unicode input.

## Build and validate without installing

The builder downloads three source files from the pinned v0.4 commit, verifies
their SHA-256 hashes, applies the patch, and builds in an empty private directory.
It requires existing C/Wayland development tools and installs no dependencies.
The upstream MIT license is retained with the build and this patch.

```sh
python integrations/wtype/build.py /tmp/companion-wtype-candidate
```

The following test **opens a disposable nested desktop window**, so coordinate
it with anyone using the desktop first. It uses an existing Playwright install,
local synthetic text fields, and its own compositor; it never reads personal
history or accesses the clipboard. Do not point it at a live application's page.

```sh
COMPANION_TEST_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
COMPANION_TEST_WTYPE=/tmp/companion-wtype-candidate/wtype \
python test/live/nested-hyprland.py test/live/text-delivery.mjs
```

With no `COMPANION_TEST_WTYPE`, the regression uses the installed writer and
fails if the sentence is corrupted. With a candidate, it logs the stock-writer
comparison and asserts correct insertion of punctuation, accented/Greek text,
all printable ASCII characters, repeated keymap transitions, long text, and
sanitized control characters. It also verifies that existing draft text remains
intact, a focus change suppresses delivery/Enter, and cancellation stops typing.
The selected browser/version and separate supplementary-Unicode result are
printed explicitly.

The GTK history test can use the candidate without installing it:

```sh
PATH="/tmp/companion-wtype-candidate:$PATH" npm run test:quick-tap
```

That also exercises the unchanged explicit-key path used for simulated history
chords. The fixture's final database assertion must wait for pending paste
records to finish: seeing the last character alone does not mean wtype has
released its last key and exited. GTK validation used that completion predicate
in a temporary fixture copy; the concurrently maintained `quick-tap.ts` was not
edited here.

A later coordinated installation must ensure the running listener's
PATH resolves the tested binary. Building or checking out this patch alone does
not change the writer used by a running Companion process.
