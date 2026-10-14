# Starter kit: requirements and provenance

## Requirements and supported setups

Every part is plain Markdown guidance that Pi and Claude Code load as skills or
instructions (see [Where things go](README.md#where-things-go)). None of it
installs software or changes settings. When a requirement is missing, each skill
tells the agent to explain what is missing and ask, not to install it or fall
back to a broader method.

| Part                          | Needs                                                                                                                                | Supported setups                                                             | When something is missing                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| computer-use                  | Whatever desktop tools the agent already has, such as Companion's own.                                                               | Any desktop.                                                                 | Explains the limitation and offers a manual step.                          |
| companion-widgets             | Companion's widget tools, available in Companion conversations; the widget guide `widget-library/README.md` in a Companion checkout. | Companion conversations on Pi or Claude Code.                                | Can build and test widget files, but does not claim to publish them.       |
| companion-screenshot          | A Hyprland Wayland session with `hyprctl`, `jq`, `grim` and `timeout`; Companion's native UI; a model that can read images.          | Hyprland, e.g. Omarchy. Not other compositors or the older Quickshell panel. | Stops and explains; no other capture method.                               |
| companion-source              | Linux `/proc`, `pgrep` and `git`; systemd user units if Companion starts at login.                                                   | Linux.                                                                       | Asks the user where their Companion checkout is.                           |
| instruction-graph             | The `ig` CLI from the `@instructiongraph/ig` npm package (Node.js 18+); network access to a hub for syncing or sharing.              | Any.                                                                         | Explains, and asks before installing, creating an identity or using a hub. |
| agent instructions            | Pi, or Claude Code with a `CLAUDE.md` that imports `AGENTS.md` (README step 3).                                                      | Companion's agent directory.                                                 | Tool-specific lines apply only when those tools are available.             |
| memory (optional)             | The agent's file tools.                                                                                                              | Any.                                                                         | Not applicable.                                                            |
| task-retrospective (optional) | Nothing beyond the conversation.                                                                                                     | Any.                                                                         | Not applicable.                                                            |

## Origin and license

The kit is part of Companion and is covered by its license, GPL-3.0-only (see
[LICENSING.md](../LICENSING.md)). It contains only Markdown: no scripts, images
or other assets, and no copied third-party text.

- **computer-use**, **companion-widgets**, **companion-screenshot**,
  **companion-source**, **instruction-graph** and the **agent instructions**
  are adapted from instructions written with AI coding agents for the Companion
  author's own setup. The adaptations remove personal paths, identities,
  accounts and workflow rules, and follow the current Companion source and guides.
- **instruction-graph** names the public Dataverse root object. That reference is
  published with the `ig` CLI (`@instructiongraph/ig`, GPL-3.0-only) and at
  <https://dataverse001.net>; no graph content is copied.
- The **memory templates** and **task-retrospective** skill are new for the kit.

Tools the skills mention (`hyprctl`, `jq`, `grim`, `ig`, Pi, Claude Code) are not
included and keep their own licenses.
