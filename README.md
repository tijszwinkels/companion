# Companion

**Talk to your Linux desktop.** No hotkeys, no wake word: Companion listens while
you work and works out what you mean. Say what you want typed and it appears in
the app you are using; ask a question and an AI agent that can see your screen
answers in a side panel.

<!-- Demo recording goes here. -->

## What it is

Companion is two things that share one microphone:

1. **A transcription tool.** Speak, and your words are typed into the
   application that has focus: an editor, a chat box, a terminal. Speech
   recognition runs locally on your machine.
2. **An AI agent.** Ask a question out loud and Companion starts an agent
   conversation, together with a screenshot of the window you were looking at.
   The agent answers in Companion's panel, can use tools, and can start or
   message other agent conversations, for example to hand a larger task to a
   coding session.

You don't need to switch modes. When you stop speaking, Companion takes a
screenshot of the active window, transcribes what you said and lets a vision
model decide what you meant: dictation, a question for the assistant, a
follow-up to the conversation you have open, or nothing at all. If you want to
be explicit, start your sentence with a command word instead.

## What you can do with it

- **Dictate anywhere.** Just talk to fill in a text field, or say
  **“insert …”** to type exactly what follows. **“enter …”** types it and
  presses Enter, which is handy for chat boxes and terminals.
- **Ask about what is on your screen.** “What does this error mean?” or
  **“quick question, …”** sends your question and the window you are looking at
  to an agent, and the answer opens in a new tab in the panel.
- **Start real agent work.** **“new session …”** starts a full agent
  conversation in Companion's agent directory, on [Pi](https://pi.dev) by default
  or on Claude Code (**“new claude session …”**). Agents have tools and run as
  your user.
- **Keep the conversation going.** With a conversation open in the panel, just
  keep talking, or say **“continue session …”**. You can also type: every
  conversation has a text box, and follow-ups queue while the agent works.
- **Run a team of agents.** Keep one conversation as your manager and let it
  delegate: it can start other Companion sessions, send them follow-ups and get
  their reports back, so it stays free to talk with you while they work. Up to
  four agents run at the same time.
- **Get visual answers.** Agents can show interactive widgets in the panel,
  such as diagrams, comparisons, charts and to-do lists.
- **Recover recent transcriptions.** Companion keeps what it transcribed in a
  local history. With the Omarchy integration, hold **Super+Alt+V** to pick a
  recent utterance and paste it again.

The panel can be a normal window, a sidebar or a dock. Its Activity tab shows
what Companion heard and what it decided, and lets you switch individual
intents and command words on or off. With the Omarchy integration, Companion
pauses itself while music or video is playing, and **Super+Alt+P** pauses or
resumes listening.

## Try it

Companion is built from source and is currently made for
[Omarchy](https://omarchy.org) (Arch Linux with the Hyprland desktop). The
**[installation guide](docs/installation.md)** walks you through everything,
and is written so that the Pi coding agent can do most of the work with you:
you install Pi, then Pi follows the remaining steps and asks you whenever it
needs your password or your eyes on the screen.

Companion is an early project, so expect some rough edges.

You will need:

- an Omarchy / Hyprland desktop with Node.js, Rust and the packages the guide
  lists;
- a speech model (downloaded during installation, runs locally);
- an image-capable model endpoint for understanding your intent and for
  agents. This can run on the same machine, on a server on your own network,
  or, for agents, at a hosted provider you choose.

## Privacy

Speech recognition is local: your audio is not sent to any model. The
screenshot, the transcript and the window title do go to the model endpoint you
configure, so where that model runs decides what leaves your computer. Agents
have tools and act with your user's permissions, and a hosted agent provider
receives your prompts, screenshots and tool results.

Companion also keeps a local history: transcripts, screenshots, audio
recordings and saved conversations, under `~/companion`. Nothing is deleted
automatically. The installation guide's
[storage, deletion and egress](docs/installation.md#storage-deletion-and-egress)
section lists every store and what leaves the machine.

## Learn more

- [Installation guide](docs/installation.md): setup, first launch, starting at
  login, troubleshooting and uninstalling.
- [Using Companion](docs/using-companion.md): command words, shortcuts, the
  panel and settings.
- [Development guide](docs/development.md): source map, configuration, tests
  and how to update a running installation.
- [Widget authoring](widget-library/README.md) and
  [local web apps](docs/local-apps.md) for building your own views and tools.
- An experimental [phone panel](docs/mobile-startup.md) lets you follow
  conversations, and start new ones, from your phone over your own private
  network.
