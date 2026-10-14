---
name: companion-source
description: >-
  Find the source checkout of the Companion desktop voice assistant, and which
  revision is actually running, when answering questions about Companion's
  behavior or locating its implementation. Read-only; works for service,
  terminal and manual launches.
license: GPL-3.0-only
---

# Find Companion source

Companion is built and run from a source checkout. Its agents' working directory
(normally `~/companion/agents`) is not that checkout. This is read-only
investigation: do not start, stop, restart, enable or edit services or processes.

## 1. Find the running checkout

Use the first method that gives a verified answer:

1. **Running listener process.** Companion's listener runs `src/cli.ts` from
   its checkout. List candidates without changing anything:

   ```sh
   pgrep -u "$(id -u)" -af 'src/cli\.ts'
   ```

   For a candidate PID, read its working directory and command line:

   ```sh
   readlink -f "/proc/<pid>/cwd"
   tr '\0' ' ' < "/proc/<pid>/cmdline"; echo
   ```

   Accept the directory only if it contains Companion's `package.json` and
   `src/cli.ts`. A launcher (`npm`/`tsx`) and its `node` child may both match
   with the same directory. Several listeners or checkouts are possible; report
   them all rather than picking one.

2. **Login services.** If Companion was set up to start after login, its user
   units record the checkout. This is metadata only:

   ```sh
   systemctl --user list-units --all --no-pager 'companion*'
   systemctl --user show companion-listener.service \
     -p ActiveState -p WorkingDirectory -p ExecStart
   ```

   Use `WorkingDirectory` of an **active** unit. Other units can exist; inspect
   the active one rather than assuming a name. An inactive unit's directory says
   where Companion was configured, not what runs now.

3. **Native UI.** For questions about the window or sidebar, find which build of
   the UI is running; its path is normally inside a checkout's
   `native/window/build`:

   ```sh
   pgrep -u "$(id -u)" -ax companion-ui
   readlink -f "/proc/<pid>/exe"
   ```

4. **Ask.** If nothing above identifies a checkout, ask the user where their
   Companion source is. Do not guess a path or search their home directory.

A checkout that merely exists, or the current working directory, is not proof of
what is running.

## 2. Distinguish source from the running build

The listener loads its TypeScript at startup, and the native UI runs whatever was
last built. Later edits, branch switches or pulls are not running until the user
restarts or rebuilds. When the difference matters, report:

- `git -C <checkout> rev-parse --short HEAD`, branch and `git status --short`;
- the process start time (`ps -o lstart= -p <pid>`) compared with recent
  changes, when that is relevant to the question.

Say explicitly when you can only describe the checkout, not the running build.

## 3. Read before explaining

Search the checkout with `rg` (or `grep -r`) and read the matching files before
explaining behavior. Start from `docs/development.md`, which maps components to
source directories and guides. Useful entry points (verify in the checkout):

- `src/core/pipeline.ts`: speech capture, transcription and routing order.
- `src/agents/`: agent conversations, harnesses and Companion's agent tools.
- `widget-library/README.md`: the widget guide.
