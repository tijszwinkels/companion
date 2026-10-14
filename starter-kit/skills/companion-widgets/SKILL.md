---
name: companion-widgets
description: >-
  Build, style, test, publish or update interactive HTML/CSS/JavaScript widgets
  and small apps shown in Companion, including revisions that must preserve
  existing widget data. Use for dashboards, checklists, charts and canvas/WebGL
  widgets. Not for ordinary websites or Companion renderer/backend development.
license: GPL-3.0-only
---

# Companion widget authoring

Create reusable library widgets, not one-off HTML pasted into chat. Ordinary
Markdown and freeform replies remain available. This skill does not grant
permission to change desktop settings, restart services, merge code, copy private
data between apps or publish anything outside Companion.

## 1. Discover the live library, guide and scope

1. If Companion's widget tools are available, call `companion_widgets({})`. Its
   `directory` is the library the running Companion uses; do not assume the
   working directory or a source checkout. Search the listed widgets before
   creating another one. Inspect a widget with `companion_widgets({name})` and
   an existing instance with `companion_widgets({id})`.
2. Read the current widget guide completely: `widget-library/README.md` in the
   Companion source checkout. Use the `companion-source` skill to find that
   checkout if needed, and prefer the one the running Companion was started from.
   Also read `README.md` or `design.md` in the discovered library if present.
   The guide is authoritative for file layout, schemas, limits and sandbox
   rules; follow it rather than remembered or copied numbers.
3. Identify whether the user wants a new independent app, an update preserving
   current data, a visual mockup, or a real integration. Do not invent
   integration or synchronization. Label mock data and keep it out of real lists.
4. Preserve unrelated work and the user's own development workflow.

If Companion's widget tools are unavailable, you can still build and test files
in the library, but do not claim to have published or pinned anything. Do not
work around missing tools by editing Companion's state files or extracting
browser or service credentials.

## 2. Build on the library contract

Start from the closest inspected library example and follow its contract. Each
widget directory holds three regular entry files (no symlinks):

- `widget.json`: name, positive version, description, bounded props schema,
  declared action argument/result schemas, and example props.
- `widget.js`: self-contained browser ES module exporting `describe`, `actions`
  and `mount`.
- `style.css`: local responsive styles using the guide's theme variables.

Supporting source, build and test files are allowed. Runtime code and assets must
be bundled into the entry files or `data:` URLs. The sandbox blocks network and
CDN content (including localhost), remote fonts, browser storage, workers and
nested frames. Check the guide's current size and schema limits.

## 3. Preserve the app contract

- `describe(props)` supplies a useful, bounded, truthful plain-text fallback.
- Reducers receive cloned props/args and `{requestId}`; return `{props, result}`
  with a result matching the action schema. Use the request ID for replay-safe
  generated IDs. Keep DOM/time-dependent side effects out of reducers; pass dates
  explicitly. Validate cross-field constraints before accepting a change.
- `mount(root, api)` returns `{update, dispose}`. Keep durable app data in props.
  Use `api.call` for declared actions and await its result before claiming a save.
- Reconcile stable DOM nodes in `update`. Preserve focus, input drafts, selection
  and sensible scroll position.
- Gate duplicate submissions. On save failure keep drafts, restore controls and
  show a visible error. A reported failure may follow a committed write: inspect
  current state before issuing a fresh mutation.
- Use `textContent` for data, native controls, accessible labels, visible focus
  and non-color-only state. Confirm destructive removal where appropriate.
- `dispose` cleans up timers, animation frames, observers, event listeners and
  GPU resources. Late async results must not mutate disposed UI.

## 4. Design for the actual viewport

Use fluid wrapping layouts, `rem` typography, `min-width: 0` and scalable SVG.
Inspect an instance's `lastViewport` when available; the initial preview is not
the sidebar size. Account for host padding, text zoom, short pinned areas and
pop-outs. Let content scroll rather than shrinking controls into illegibility.

Use readable contrast and restrained surfaces unless the user asks otherwise.
For effects, honor reduced motion, avoid flashes, keep actionable text readable,
and provide a real plain mode when requested, not merely a frozen animation.
Canvas/WebGL: size from the root's bounding box, observe resizing, cap pixel
density and work, pause hidden rendering, and keep a functional fallback when
WebGL is unavailable or loses context.

## 5. Validate before publication

Use [the validation checklist](references/validation.md). Test behavior and data
integrity, not just syntax or a pretty screenshot. Use synthetic state and an
isolated browser profile; never attach automation to the user's personal browser.
Follow the user's own review preferences. Disclose known defects, and distinguish
author-tested, shown to the user and accepted by the user. Silence is not
acceptance.

## 6. Publish or replace safely

1. Inspect the finished widget's schema with `companion_widgets({name})` before
   calling `companion_widget({widget, props})`. Use real, validated props.
2. Existing instances keep the exact bundle they were published with. Editing
   library files or replacing props does not update their code.
3. For a code/style replacement, freshly inspect the source instance's props,
   revision and presentation, then publish a new instance with those props.
   Preserve IDs, completion, dates and other metadata. Recheck the old instance
   afterwards; do not silently discard changes made during the migration. Leave
   the original intact and explain that the two copies are not synchronized.
4. For data-only changes use declared actions with `companion_widget_call`. To
   replace all props, use `companion_widget_update` with a freshly inspected
   revision. On a conflict, inspect and reconcile; never blindly retry an
   uncertain mutation.
5. Pin with `companion_widget_present` only when requested or useful for ongoing
   work, normally around 25–35% height, and ask before replacing an unrelated
   pinned widget. Avoid 100% unless intended: it hides the transcript and input.
6. To check live appearance, use the `companion-screenshot` skill if installed
   and the user agrees to a capture. Otherwise say live appearance is unverified.
7. Summarize what changed, what data was preserved, checks performed and any
   limitations.

Publishing a widget, restarting Companion, installing UI changes, merging code
and public release are different operations. Perform only those the user
authorized.
