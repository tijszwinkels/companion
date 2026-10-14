# Widget validation checklist

Use the applicable checks and record what was actually exercised. Passing syntax
or formatting checks does not cover the other items.

## Contract and data

- Manifest name matches its directory; schemas, example and actions are valid
  under the current guide's JSON Schema subset and size limits.
- The text fallback is meaningful, bounded and truthful.
- Reducers preserve IDs and unrelated fields and reject malformed state.
- Replay-safe creation, stale revisions, duplicate submits, capacity limits and
  error handling behave as intended.
- Real lists never receive synthetic test data. A migration preserves complete
  props, including completed or hidden items, not just visible text.

## Interaction

- Keyboard and pointer paths work; focus is visible and controls are labeled.
- Drafts, focus and selection survive updates, failed saves and cancellation.
- Controls recover after failures; errors never claim success.
- Destructive actions are confirmed; cancelling changes nothing.
- No pending callback changes the DOM after disposal.

## Responsive and visual

- Try narrow, medium and wide widths (for example 240, 320, 480 and 800 CSS
  pixels) and larger root text. These do not replace the actual viewport.
- Check short heights, long unbroken text, empty states, maximum data and errors.
- No horizontal overflow or unreachable controls; long content scrolls.
- Judge contrast from rendered output, not token names.
- Inspect screenshots after transitions settle, in normal and reduced-motion
  modes. Fades must not hide essential text.
- Headless screenshots do not prove live appearance in the sidebar or pop-out.

## Graphics and lifecycle

- Missing WebGL is a supported fallback, not a broken app.
- Context loss and restoration cannot break data controls.
- Hidden documents pause rendering; resizing uses the actual geometry and a
  bounded pixel density.
- Disposal cancels timers and frames and disconnects observers and listeners.

## Before publication and handoff

- Run the relevant focused tests and formatting checks. Do not reformat unrelated
  files or install dependencies without the user's agreement.
- Bundled output matches its source, and contains no runtime imports, remote
  assets, symlinked entries or browser storage.
- Inspect the schema with `companion_widgets({name})` and the current instance
  state immediately before copying or replacing it. Flag concurrent changes
  rather than overwriting newer work.
- Report source paths, checks and their limits, preserved data, the published
  version and review status. Mention that copies do not synchronize.
