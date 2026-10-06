# Using Companion

A practical guide to Companion once it is installed: how to start it, what you
can say, how the panel works and which settings you can change. For setup, see
the [installation guide](installation.md); for a short overview, the
[README](../README.md).

## Start and stop

From a terminal on your Hyprland desktop:

```sh
cd ~/Work/companion
npm start -- --paused
```

`--paused` starts with the microphone off; without it Companion starts
listening and typing straight away, so put the cursor somewhere harmless first.
**Ctrl+C** in that terminal stops Companion and any agent work it started.
To start Companion automatically when you log in, see
[start Companion after login](installation.md#8-start-companion-after-login-optional).

Useful options:

- `--preview` shows what Companion would do without typing or starting agents.
  It still listens, takes screenshots and keeps history.
- `--no-sounds` starts with the sound cues muted.
- `npm start -- --help` lists every option.

**Super+Alt+P** (or the microphone icon in the top bar) pauses and resumes
listening. With the Omarchy integration, Companion also pauses by itself while a music or video player is
playing, and resumes when it stops, unless you paused it yourself. Agent
conversations keep running while the microphone is paused.

## Talking to Companion

Just talk. When you stop speaking, Companion looks at what you said and at the
window you are in, and decides whether you are dictating, asking the assistant
something, continuing an open conversation, or not talking to it at all.

To skip the guessing, start with a command word:

| Say                                         | What happens                                                         |
| ------------------------------------------- | -------------------------------------------------------------------- |
| “insert …”                                  | Types the rest into the focused app.                                 |
| “enter …”                                   | Types the rest and presses Enter.                                    |
| “quick question …”                          | Asks the faster quick-question model; the answer opens in a new tab. |
| “new session …”                             | Starts a full agent conversation (Pi by default).                    |
| “new pi session …” / “new claude session …” | Starts the conversation on Pi or on Claude Code specifically.        |
| “continue session …”                        | Sends a follow-up to the conversation that is open in the panel.     |
| “close session”                             | Stops and closes the open conversation.                              |
| “go to session three”                       | Switches to that conversation tab (one to sixteen).                  |
| “stop”                                      | Stops the open conversation's agent while it is answering.           |
| “label previous correct” / “… incorrect”    | Tells Companion whether it understood your last sentence right.      |

Matching ignores capitals and a comma after the command word (“Insert, hello”).
Every question or new session includes a screenshot of the window you were
looking at. When an agent offers buttons such as **Yes** or **More detail**,
you can also say the button's label.

Companion only types into the window you were in when you finished speaking.
If you switch windows before it types, it skips the text rather than typing in
the wrong place; you can paste it later from history.

## The panel

The panel holds the **Activity** tab and one tab per agent conversation
(Q1, Q2, …). Use the **Window**, **Sidebar** and **Dock** buttons at the top to
choose how it sits on your screen.

**Activity** shows what Companion heard and what it did with it. Its
**Intentions** section lets you switch each route on or off separately for
automatic recognition (blue) and for its command word (amber). **Clean up
transcriptions** (off by default) sends a tidied version of your speech instead
of the raw transcript; see [transcription cleanup](transcription-cleanup.md).
The text box at the bottom lets you type instead of speak; typed text is
handled exactly like speech.

**Conversation tabs** show the agent's answer, its tool use (click a tool bubble
to see details) and any widgets it shows. In a conversation you can:

- type a follow-up and press **Enter** (**Shift+Enter** for a new line). While
  the agent is still working, follow-ups queue up (up to eight) and run in order;
- press **Stop** to interrupt, or **Close session** to stop it and move it to
  **Previous sessions** at the bottom of the tab rail, where you can reopen it later;
- pick a different **Model** and **Effort** for the next turn at the bottom;
- click the attached screenshot to view it full size;
- hover a message for its **Copy** button.

Up to sixteen conversations can be open at once. Drag a tab to reorder it.

## Keyboard shortcuts

These need the Omarchy integration from the installation guide.

| Shortcut                 | Action                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| Super+Alt+C              | Show or hide the panel.                                                  |
| Super+Alt+D              | Jump to the panel's text box, and back to your previous app.             |
| Super+Alt+P              | Pause or resume listening.                                               |
| Super+Alt+V              | Hold to pick a recent sentence, release to paste it; tap for the latest. |
| Alt+1 … Alt+9            | Open conversation Q1–Q9 (while the panel has focus).                     |
| Super+Alt+0 / Alt+0      | Open Activity (while the panel has focus).                               |
| Super+Alt+Tab            | Cycle Activity and conversations (while the panel has focus).            |
| Alt+Shift+Up/Down        | Move the selected conversation tab.                                      |
| Ctrl++ / Ctrl+- / Ctrl+0 | Zoom a conversation in, out, or back to 100%.                            |

## Sounds

A short cue confirms that Companion heard you, and a different one tells you
where it went: typed into an app, sent to an open conversation, or started a
new one. A soft chime plays when an agent finishes answering. Mute the cues
from the microphone menu in the top bar, or start with `--no-sounds`.

## History and privacy

Companion keeps what you said, together with the screenshot and audio of each
sentence, in `~/companion`; conversations are saved under
`~/companion/agents`. Nothing is deleted automatically. You can delete
individual entries from Activity. The installation guide's
[storage, deletion and egress](installation.md#storage-deletion-and-egress)
section lists every store, how to remove it and what is sent where.

## Settings

| What                                                   | Where                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Agent models and the default agent (Pi or Claude Code) | `~/companion/agents/companion-agent.json`, read again before every turn.                               |
| Speech model and the model that interprets your intent | `companion.config.json` in the folder you start Companion from (copy `companion.config.example.json`). |
| Which intents and command words are on                 | The Intentions switches in Activity.                                                                   |

The [installation guide](installation.md) explains each of these files. The
complete reference, including every field, lives in the
[development documentation](development.md).

## Optional extras

- **Phone panel** (experimental): follow and start conversations from your
  phone over your own private network. See [phone access](mobile-startup.md).
- **Local web apps**: open your own local web apps next to Companion. See
  [local apps](local-apps.md).
- **Built-in browser**: view a web page inside the panel with the **Browser**
  button (standalone window only). See [panel browser](panel-browser.md).
- **Other coding agents**: local tools can start and message Companion
  conversations once you enable it. See the
  [external session guide](../src/agents/external/README.md).
