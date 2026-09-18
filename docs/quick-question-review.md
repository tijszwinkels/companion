# Quick Question merge review

The independent Claude Opus review covered the combined feature through
`b4832ed`, including Pi RPC, storage, routing, focus, Markdown, and installation.
Its findings and evidence are in Mattermost's `companion-opus-adversarial-review`
channel (`qcfp5cm3hjdrjng7gf34sp9acw`).
The merge also includes the subsequent reviewed/tested copy and local tab
shortcuts, compact Activity view, and MPRIS media pause through `9aeb9d5`.

## Findings addressed

- **Pi cleanup hang:** a separately detached descendant retaining stdout/stderr
  could prevent Node's `close` event indefinitely. Companion now destroys its
  local pipe handles after termination escalation and reaps Pi. Real subprocess
  regressions fail before the fix for both successful completion and cancellation,
  then pass with the fix. Deliberately detached descendants remain outside the
  owned process group; the regression cleans up its own holder process.
- **Copying answers:** selection Ctrl+C and hover whole-message Copy are present.
- **Invisible focus-shortcut feedback:** requesting composer focus without a
  selected conversation now opens the panel so its existing error is visible.
- **Repeated installer backups:** configuration files are backed up only when
  they change. Staged installation checks preserve first-install backups and
  verify that reinstall changes neither config mtimes nor backup count.
- **Composer delivery wording:** logs identify the composer, and documentation
  distinguishes keyboard delivery from a Pi submission acknowledgement. `sent`
  records keyboard delivery; Enter during an existing answer leaves a draft.

The Command/Option glyphs and selected-tab hover styling are the user's explicit
preferences and are retained. The deliberately strong focused-conversation intent
instruction and other user-authored prompts are unchanged.

Final combined checks passed: 134 Node tests, 72 offscreen QML results, TypeScript,
formatting, adapter QML parsing, and whitespace checks. The Node suite includes
staged installation with inert desktop commands and temporary configuration.

## Follow-ups and validation limits

- The history `application` field identifies the ordinary window captured with
  speech, not a separate delivery destination. Composer-specific destination and
  Pi submission acknowledgement should be modelled explicitly with the evals
  work; current documentation does not claim those records exist.
- Saved conversations have no UI deletion or retention policy. Startup reads
  full transcript files to build its history summaries. Neither deletes user
  data; retention controls and a summary index are follow-ups.
- Shortcut conflict detection does not yet interpret physical keycode bindings
  across keyboard layouts or distinguish scoped submaps. Named chords on this
  installation were checked; that is not a guarantee for every desktop layout.
- No additional native input test was run for the Alt+0/compact-header increment.
  Its offscreen checks pass. The prior native copy/tab/focus fixture passed, but
  outside-click/monitor-specific behavior and full live dictation coverage remain
  limited as documented in [panel checks](../test/panel/README.md).
- The vendored Markdown parser's provenance/hash is documented, but a dedicated
  automated integrity check remains a follow-up. The legacy composer-focus
  socket message remains intentionally compatible with older clients.

This merge is source integration. It does not restart the user's running listener
or replace the installed plugin. A later activation must select the merged code
to pick up the final review fixes.
