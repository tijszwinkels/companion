# Agent choices and voice shortcuts

Requested by @tijs on 2026-09-19 for the next work session. This is the agreed
feature brief; implementation is deferred until that session.

## User experience

The current coding agent can offer a few choices. The user can select one by
speaking its label, clicking it, or continuing with ordinary freeform text.
Choices must never turn a conversation into a forced-choice form.

- Keep the available choices floating above the conversation's input textbox,
  separate from the scrolling transcript. They belong to that conversation.
- Highlight labels whose voice shortcuts are currently active. The GUI and
  router must agree about which choices are active.
- Support a short voice label with a longer explanation, for example
  `[choice 1] - Do this or that.`
- Also support labels without explanations, for example `["Yes"], ["No"]`.
- Register offered choices as contextual intents and voice shortcuts. An
  utterance matching a label selects that option directly, without an intent
  LLM round trip. Keep freeform speech and typed follow-ups available.
- While the current agent is running, expose **stop** as a voice shortcut that
  cancels that agent. Scope it to the current conversation and its current run;
  it must not stop unrelated agents or quit Companion. Show it even when no
  other choices have been offered.

## Agent-facing tool

Provide the Pi coding agent with a tool to offer, replace, and clear its choices.
An MCP server is one possible transport; decide after checking Pi's available
tool-extension interfaces. The user requested the capability, not a commitment
to MCP specifically.

The tool should carry structured data: stable option IDs, spoken/display labels,
and optional explanatory text. Do not make the GUI or router scrape Markdown
from the agent's response to discover choices. Bind each tool call to its owning
session rather than trusting an arbitrary session ID supplied by the model.

## Design decisions for the next session

- Decide whether the tool waits for the user's response or returns immediately
  and receives the selection as a later turn. Specify how freeform answers work
  in either case, including when the model is already running.
- Define utterance matching: case, terminal punctuation, and transcription
  variants. Prefer whole-utterance matching so an ordinary sentence mentioning
  an option is not silently treated as a selection.
- Define collisions between option labels and existing prefixes, including the
  reserved running-agent shortcut `stop`.
- Define when choices expire: a selection, freeform answer, agent replacement,
  cancellation, closing a tab, or a later tool call replacing the choices.
- Capture the selected session and choice generation at speech end. Recheck
  before dispatch so delayed ASR cannot select a different conversation's
  choices or an option that has since been replaced.
- Specify whether a label-only option's selected value is its label or a
  separate stable value. Keep labels readable without exposing internal IDs.

## Acceptance checks

Exercise both supported display forms; spoken and clicked selection; freeform
typed and spoken responses; option replacement while ASR is pending; tab/focus
changes; expired and duplicate labels; model/tool errors; and stopping the current
run without stopping another session. Verify that the visible highlighted labels
are exactly those the router can invoke, and that the choices remain above the
textbox while the conversation scrolls.

Preserve user-edited prompts, existing prefix behavior, keyboard focus checks,
per-tab drafts, and media auto-pause. Work on the module and Pi tool together so
the complete flow can be demonstrated in an isolated test before installation.
