# Companion starter kit

Optional skills and instructions that help a coding agent work well inside
Companion. Nothing here is installed automatically, and adopting it does not
replace your existing agent setup: you pick what you want, and only missing files
are added. A person can follow this guide by hand, or hand it to their agent.

Skills and instructions are guidance for the agent. They do not grant
permissions, configure accounts or tools, or act as a sandbox: the agent's tools
still run with your user's permissions.

## What's in it

| Part                                                                  | What it does                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`skills/computer-use`](skills/computer-use/SKILL.md)                 | Careful desktop inspection and interaction with whatever desktop tools the agent already has.                 |
| [`skills/companion-widgets`](skills/companion-widgets/SKILL.md)       | Building, publishing and updating Companion widgets without losing their data.                                |
| [`skills/companion-screenshot`](skills/companion-screenshot/SKILL.md) | A bounded screenshot of Companion itself on Hyprland, e.g. to check a widget.                                 |
| [`skills/companion-source`](skills/companion-source/SKILL.md)         | Finding the Companion source checkout and which revision is running.                                          |
| [`skills/instruction-graph`](skills/instruction-graph/SKILL.md)       | Using Instruction Graph / Dataverse for shared data and small web apps.                                       |
| [`templates/agent-instructions.md`](templates/agent-instructions.md)  | A short set of instruction sections to merge into your agent instructions.                                    |
| [`optional/memory`](optional/memory/)                                 | Optional: blank templates for organized memory notes, plus matching instructions.                             |
| [`optional/retrospectives`](optional/retrospectives/)                 | Optional: a `task-retrospective` skill for reviewing finished work when you ask. Not part of the base skills. |

[PROVENANCE.md](PROVENANCE.md) lists each part's requirements, supported setups
and origin.

## Where things go

Companion runs its agent conversations in `~/companion/agents`, with Pi or,
optionally, Claude Code. Skills are installed per agent program:

| Agent       | Skills directory                                                                   | Instructions Companion's conversations read                                      |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Pi          | `~/.pi/agent/skills/` (or `$PI_CODING_AGENT_DIR/skills/` if you set that variable) | `~/companion/agents/AGENTS.md`                                                   |
| Claude Code | `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/` if you set that variable)     | `~/companion/agents/AGENTS.md`, imported by a `CLAUDE.md` beside it (see step 3) |

Install into the directory of each agent you use. Other skill locations may also
be configured on your machine; an existing skill with the same name takes
precedence or causes a name conflict, so check first (step 1).

The [installation guide](../docs/installation.md#5-configure-companions-pi-profile)
creates `~/companion/agents/AGENTS.md`. The template is named
`agent-instructions.md`, not `AGENTS.md`, so that agents working on this
repository don't load it as their own instructions.

## Adopt it

The commands below use two variables. Set `kit` to this directory in your
Companion checkout, and `dest` to one skills directory from the table:

```bash
kit=/absolute/path/to/companion/starter-kit
dest="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills"   # Pi
# dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"     # Claude Code
test -f "$kit/templates/agent-instructions.md" || echo 'kit is not the starter-kit directory'
```

### 1. Look before adding

Check for skills that already use these names, in every skill directory on the
machine that you know of:

```bash
names='computer-use companion-widgets companion-screenshot companion-source instruction-graph task-retrospective'
for dir in "$dest" "$HOME/.agents/skills"; do
  for name in $names; do
    if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then echo "exists: $dir/$name"; fi
  done
done
```

For anything that exists, compare it with `diff -ru "$dir/$name" "$kit/skills/$name"`
(`$kit/optional/retrospectives/$name` for `task-retrospective`) and keep the
existing skill unless the user decides otherwise. Never replace a
skill, `AGENTS.md` or `CLAUDE.md` wholesale, and don't copy someone else's
settings, memory or credentials.

### 2. Add the chosen skills that are missing

Ask which of the five base skills the user wants (all five are a good default),
and put them in `chosen`. This copies a skill only when nothing of that name
exists yet:

```bash
chosen='computer-use companion-widgets companion-screenshot companion-source instruction-graph'
mkdir -p "$dest"
for name in $chosen; do
  if [ -e "$dest/$name" ] || [ -L "$dest/$name" ]; then
    echo "skipped, already exists: $dest/$name"
  else
    cp -R "$kit/skills/$name" "$dest/$name" && echo "added: $dest/$name"
  fi
done
```

Repeat with the other `dest` if you use both Pi and Claude Code.

### 3. Merge the instructions

Show the user [`templates/agent-instructions.md`](templates/agent-instructions.md)
and ask which sections they want. Then add those sections to the end of
`~/companion/agents/AGENTS.md`, keeping the `companion-starter-kit:begin`/`end`
marker lines so the block is easy to find later. Leave out sections the user's
file already covers, keep their wording where it differs, and show them the
result. If the file does not exist yet, do step 5 of the installation guide
first.

**If you use Claude Code**, make sure it reads that `AGENTS.md`. Claude Code
reads `AGENTS.md` only as a fallback: not when a `CLAUDE.md`, `.claude/CLAUDE.md`
or `CLAUDE.local.md` exists in `~/companion/agents` or a folder above it (such as
`~/companion` or the home folder), not when the fallback is turned off in its
settings, and not before version 2.1.277. A `CLAUDE.md` beside `AGENTS.md` that
imports it with the line `@AGENTS.md` works in all of these cases. Pi keeps
reading `AGENTS.md` itself.

- If `~/companion/agents/CLAUDE.md` does not exist, add one containing only that
  import:

  ```bash
  claude_md="$HOME/companion/agents/CLAUDE.md"
  if [ -e "$claude_md" ] || [ -L "$claude_md" ]; then
    echo "exists, not changed: $claude_md"
  else
    cp "$kit/templates/claude-import.md" "$claude_md" && echo "added: $claude_md"
  fi
  ```

- If it exists and does not already import `AGENTS.md` or contain the same
  sections, show it to the user and, with their agreement, add the line
  `@AGENTS.md` to it. Keep its other content, and don't remove or rename the
  user's other instruction files.

### 4. Two optional choices

Ask the user about each; both default to off.

**Memory notes.** "Would you like blank templates for organized memory notes?"
Offer: keep an existing memory system / add blank templates / skip. Notes help
the agent remember stated preferences and project facts across conversations.
They change only when an agent or the user edits them, and any note an agent
reads is sent to its model provider; nothing is exported or synced
automatically. To add them, agree on a folder (for example
`~/companion/agents/memory`). If it doesn't exist, copy the templates; if it
does, copy only files that are missing and leave existing notes untouched:

```bash
memory="$HOME/companion/agents/memory"   # the folder the user chose
if [ -e "$memory" ]; then
  echo "exists: $memory - add only missing files, by hand"
else
  cp -R "$kit/optional/memory/template" "$memory" && echo "added: $memory"
fi
```

Then merge [`optional/memory/instructions.md`](optional/memory/instructions.md)
into the instructions as in step 3, replacing `MEMORY_DIR` with that folder
(`memory` works when it is beside the instructions file).

**Task retrospectives.** "Would you like the agent to be able to run a
retrospective on finished work when you ask?" Offer: keep an existing approach /
add the `task-retrospective` skill / skip. To add it, use step 2 with
`kit/optional/retrospectives` instead of `kit/skills`:

```bash
name=task-retrospective
if [ -e "$dest/$name" ] || [ -L "$dest/$name" ]; then
  echo "skipped, already exists: $dest/$name"
else
  cp -R "$kit/optional/retrospectives/$name" "$dest/$name" && echo "added: $dest/$name"
fi
```

It proposes changes to instructions or skills and applies them only with the
user's approval. It never runs on a schedule.

### 5. Check that the agent sees them

- **Pi:** run `pi` in `~/companion/agents`. Its startup output lists loaded
  context files and skills; typing `/skill:` offers the installed skills.
- **Claude Code:** run `claude` in `~/companion/agents` and use `/skills` to see
  the installed skills, and `/context` to check that the loaded instruction
  files include `~/companion/agents/AGENTS.md`. Installed skills alone don't
  show that the instruction block is loaded.

That the files load does not show that a model will use them well; try a real
task, such as asking for a small widget. Pi and Claude Code read skills and
instructions when a conversation starts, so start a new conversation in
Companion after changing them.

## Update

A newer Companion checkout may bring a newer kit. Compare each installed skill
with the kit before changing anything:

```bash
diff -ru "$dest/$name" "$kit/skills/$name"
```

Show the user the differences. Where they have not edited a file, the new
version can be copied over that one file with their agreement; where they have,
merge by hand and keep their edits. If you want a backup first, store it outside
every skills directory (for example `~/companion/starter-kit-backup/`), because a
copy inside one would be loaded as a duplicate skill. Update the marked
instruction blocks the same way: compare, then edit, never overwrite the file.

## Remove

- **A skill:** check with `diff -ru` that the installed copy is unchanged or that
  the user no longer wants their edits, then remove only that directory, for
  example `rm -r -- "$dest/computer-use"`.
- **Instructions:** delete the block between the `companion-starter-kit` marker
  lines; leave the rest of the file as it is. A `CLAUDE.md` added in step 3
  that still contains only `@AGENTS.md` can stay, or be removed if the user
  prefers.
- **Memory notes** are the user's data. Removing the kit never deletes them;
  delete them only if the user asks.
