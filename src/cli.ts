import { parseArgs, styleText, stripVTControlCharacters } from 'node:util';

import { loadConfig } from './config.ts';
import { IntentDetector } from './core/intent-detector.ts';
import { UserSensorRouter } from './core/router.ts';
import { Ignore } from './processors/ignore.ts';
import { EnterTextToApplication } from './processors/enter-text-to-application.ts';
import { SendTextToApplication } from './processors/send-text-to-application.ts';
import { StartCodingAgentSession } from './processors/start-coding-agent-session.ts';
import { QuickQuestion } from './processors/quick-question.ts';
import { StartClaudeCodeSession } from './processors/start-claude-code-session.ts';
import { StartCodexSession } from './processors/start-codex-session.ts';
import { GoToSession } from './processors/go-to-session.ts';
import { ContinueOpenAgentConversation } from './processors/continue-open-agent-conversation.ts';
import { CloseAgentSession } from './processors/close-agent-session.ts';
import { LabelPreviousCorrect } from './processors/label-previous-correct.ts';
import { LabelPreviousIncorrect } from './processors/label-previous-incorrect.ts';
import { ExternalSessionServer } from './agents/external/server.ts';
import { externalSocketPath } from './agents/external/paths.ts';
import { AgentSessions } from './agents/sessions.ts';
import { agentDirectory } from './agents/settings.ts';
import { userWidgetLibrary } from './widgets/library-path.ts';
import { PiBackend } from './agents/pi-backend.ts';
import { AgentChoiceIntents } from './agents/choice-intents.ts';
import { ActiveWindowSensor } from './sensors/screen/sensor.ts';
import { Transcriber } from './sensors/audio/transcriber.ts';
import type { VoiceActivityDetector } from './sensors/audio/vad.ts';
import { listen } from './sensors/audio/listener.ts';
import { SensorPipeline } from './core/pipeline.ts';
import { PauseControl } from './core/pause-control.ts';
import { DeliveryControl } from './core/delivery-control.ts';
import { failureOutcome } from './core/delivery-error.ts';
import { createGraph } from './core/graph.ts';
import { graphToMermaid } from './core/graph-mermaid.ts';
import { DesktopRuntime, desktopPaths } from './desktop/runtime.ts';
import { command } from './system/command.ts';
import type { Log } from './core/frame.ts';
import type { Transcript } from './core/activity.ts';

/** Keep each event on one line, with frame IDs connecting concurrent stages. */
const log: Log = (stage, detail, id) => {
  const timestamp = new Date().toLocaleTimeString('en-GB');
  const frameLabel = id === undefined ? '   ' : `#${id}`;
  const label = `${timestamp} ${frameLabel} ${stage.padEnd(12)}`;
  const prefix = process.stdout.isTTY ? styleText('cyan', label) : label;

  // Transcripts and subprocess errors can contain line breaks or terminal codes.
  const message = stripVTControlCharacters(detail).replace(/[\r\n]/g, ' ');

  console.log(`${prefix} ${message}`);
};

/** Compose the modules, run the chosen input mode, and own their shared lifetime. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      graph: { type: 'string' },
      text: { type: 'string' },
      wav: { type: 'string' },
      device: { type: 'string' },
      preview: { type: 'boolean', default: false },
      seconds: { type: 'string' },
      'no-sounds': { type: 'boolean', default: false },
      'no-desktop': { type: 'boolean', default: false },
      'external-sessions': { type: 'boolean', default: false },
      'external-socket': { type: 'string' },
      'widget-library': { type: 'string' },
      paused: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Companion — microphone + active-window intent routing

Usage: npm start -- [options]
  --preview          Log actions instead of typing or starting agents
  --text "utterance" Route one supplied utterance with a live screenshot
  --wav file.wav     Run an audio file through VAD, ASR, and intent routing
  --device name      PipeWire capture node (default: system microphone)
  --seconds N        Stop microphone capture after N seconds
  --config path      JSON configuration (default: companion.config.json)
  --graph format     Print pipeline connections as json or mermaid, then exit
  --no-sounds        Start with audible feedback muted
  --no-desktop       Disable history, sounds, and desktop control
  --external-sessions Enable the same-user Unix session API (off by default)
  --external-socket PATH Override its private socket path; requires --external-sessions
  --widget-library PATH  Widget source directory (default: COMPANION_WIDGET_LIBRARY,
                     else ~/companion/widget-library)
  --paused           Start paused; resume through the desktop control

Live mode types detected dictation into the same focused window. Ctrl+C stops.
"insert …" types directly; "enter …" types and presses Enter. Both bypass the LLM.
"new session …" asks the coding harness (codingDefaultHarness, Pi by default);
"new claude session …" uses Claude Code; "new codex session …" uses Pi's coding model.
"quick question …" uses local Qwen.
"continue session …" continues the currently open agent conversation.
"close session" closes the selected conversation, keeping it in Previous sessions.
"label previous correct" / "label previous incorrect" records intent feedback.
Other dictation never presses Enter. Start inside your Hyprland desktop session.`);
    return;
  }

  // Validate CLI input before opening the microphone or contacting the model.
  if (values.graph !== undefined && !['json', 'mermaid'].includes(values.graph)) {
    throw Error('--graph requires json or mermaid');
  }
  if (values.text !== undefined && values.wav) {
    throw Error('Choose --text or --wav');
  }
  if (values.paused && (values.text !== undefined || values.wav || values['no-desktop'])) {
    throw Error('--paused requires microphone mode with desktop control');
  }
  if (values.text !== undefined && (!values.text.trim() || values.text.length > 4000)) {
    throw Error('--text requires 1–4000 characters');
  }

  if (values['external-socket'] && !values['external-sessions']) {
    throw Error('--external-socket requires --external-sessions');
  }
  if (
    values['external-sessions'] &&
    (values.preview || values.graph || values.text !== undefined || values.wav)
  ) {
    throw Error('--external-sessions requires ordinary listener mode');
  }

  const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw Error('--seconds must be positive');
  }

  // Resolved once here so every widget discovery and publication in this
  // listener uses the same directory. It may not exist yet; that is not fatal.
  const widgetLibrary = userWidgetLibrary(values['widget-library']);

  const config = await loadConfig(values.config);

  // Every asynchronous stage observes this signal, so Ctrl+C cancels the whole
  // session, including an in-flight transcription or intent request.
  const controller = new AbortController();
  // Claude Code conversations fail visibly until its backend is wired here.
  const agents = new AgentSessions({ pi: new PiBackend() }, log, agentDirectory(), widgetLibrary);
  const stop = () => {
    controller.abort();
    void agents.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let vad: VoiceActivityDetector | undefined;
  let transcriber: Transcriber | undefined;
  let pipeline: SensorPipeline | undefined;
  let desktop: DesktopRuntime | undefined;
  let external: ExternalSessionServer | undefined;
  const pause = new PauseControl();

  if (values.paused) {
    pause.toggle();
  }

  try {
    if (!values.graph) {
      log(
        'start',
        `Companion · ${config.llm.model} · ${values.preview ? 'preview' : 'type into focused application'}`,
      );
      log('widgets', `Library ${widgetLibrary}`);
    }

    if (!values['no-desktop'] && !values.graph) {
      await agents.loadPrevious();
      desktop = new DesktopRuntime(pause, log, controller.signal, {
        ...desktopPaths(),
        preview: values.preview,
        sounds: !values['no-sounds'] && !values.preview,
        mediaPause: values.text === undefined && !values.wav,
        agents,
      });
      await desktop.start();
    }

    if (values['external-sessions']) {
      if (!desktop) {
        await agents.loadPrevious();
      }
      external = new ExternalSessionServer(
        agents.sessionTools,
        externalSocketPath(values['external-socket']),
      );
      await external.start();
      log('external', 'Same-user session API enabled');
    }

    const activity = desktop?.activity ?? { delivery: new DeliveryControl() };

    // Subscriptions provide prefix shortcuts and/or the detector's prompt entries.
    const detector = new IntentDetector(config.llm, undefined, 'detector', activity);
    const router = new UserSensorRouter({ detector }, log, activity);
    new SendTextToApplication(log, values.preview, command, activity).subscribe(router);
    new EnterTextToApplication(log, values.preview, command, activity).subscribe(router);
    new Ignore(log, activity).subscribe(router);
    new StartCodingAgentSession({ sessions: agents }, log, values.preview, activity).subscribe(
      router,
    );
    new QuickQuestion({ sessions: agents }, log, values.preview, activity).subscribe(router);
    new StartClaudeCodeSession({ sessions: agents }, log, values.preview, activity).subscribe(
      router,
    );
    new StartCodexSession({ sessions: agents }, log, values.preview, activity).subscribe(router);
    new GoToSession(log, values.preview, activity).subscribe(router);
    new ContinueOpenAgentConversation(
      { sessions: agents },
      log,
      values.preview,
      activity,
    ).subscribe(router);

    new CloseAgentSession({ sessions: agents }, log, values.preview, activity).subscribe(router);

    new LabelPreviousCorrect(log, values.preview, activity).subscribe(router);
    new LabelPreviousIncorrect(log, values.preview, activity).subscribe(router);
    new AgentChoiceIntents({ sessions: agents }, log, values.preview, activity).subscribe(router);

    await desktop?.connectRouter(router);

    // These constructors are inert. Named dependencies are both the actual
    // objects used for processing and the connections visible to inspection.
    const screen = new ActiveWindowSensor(command);
    transcriber = new Transcriber(config.asr);
    pipeline = new SensorPipeline(
      { screen, transcriber, router },
      log,
      controller.signal,
      activity,
    );

    if (values.text === undefined) {
      desktop?.connectPipeline(pipeline);
    }

    // Export the same wiring as normal execution, before acquiring any audio,
    // screen, native VAD, or desktop resources. stdout contains only the graph.
    if (values.graph) {
      const graph = createGraph(pipeline);
      const output =
        values.graph === 'json' ? JSON.stringify(graph, null, 2) + '\n' : graphToMermaid(graph);
      process.stdout.write(output);
      return;
    }

    log(
      'registered',
      'SEND_TEXT_TO_APPLICATION (insert), ENTER_TEXT_TO_APPLICATION (enter), IGNORE, START_CODING_AGENT_SESSION (new session), QUICK_QUESTION (quick question), START_CLAUDE_CODE_SESSION (new claude session), START_CODEX_SESSION (new codex session), CONTINUE_OPEN_AGENT_CONVERSATION (continue session / visible conversation), CLOSE_AGENT_SESSION (close session), LABEL_PREVIOUS_CORRECT, LABEL_PREVIOUS_INCORRECT',
    );

    // Supplied text enters the same routing path but needs no audio resources.
    if (values.text !== undefined) {
      const transcript: Transcript = { id: 1, observedAt: Date.now(), utterance: values.text };
      activity.processing?.(1);
      const interaction = activity.interactionContext?.();

      try {
        log('capture', 'Capturing active window', 1);
        const screenshot = await screen.capture(controller.signal, (application) => {
          transcript.application = application;
        });
        activity.transcribed?.(transcript);
        await activity.screenshotCaptured?.(1, screenshot);
        log('frame', 'Supplied utterance + screenshot', 1);
        await router.route({ ...transcript, screenshot, interaction }, controller.signal);
      } catch (error) {
        // Like audio input, supplied text is retained even if capture fails.
        activity.transcribed?.(transcript);
        activity.outcome?.(1, failureOutcome(error, controller.signal));
        throw error;
      } finally {
        activity.finished?.(1);
      }

      await agents.idle();
      return;
    }

    // Only audio mode owns a native ASR worker. Finish model loading before
    // capture starts; successful utterances then reuse this session's model.
    log('asr-start', 'Loading Parakeet transcription worker');
    await transcriber.start(controller.signal);

    await screen.capture(controller.signal);

    // Load the native runtime only when audio processing actually needs it.
    // Help, graph export, and supplied-text mode need no ONNX installation.
    const { VoiceActivityDetector } = await import('./sensors/audio/vad.ts');
    vad = await VoiceActivityDetector.create(config.vadModel);

    if (seconds !== undefined) {
      timer = setTimeout(stop, seconds * 1000);
    }

    log(
      'listening',
      values.wav ? `Audio file: ${values.wav}` : 'Desktop control ready · Ctrl+C to stop',
    );

    do {
      await pause.waitUntilResumed(controller.signal);
      const listeningSignal = AbortSignal.any([controller.signal, pause.signal]);

      try {
        await listen(
          vad,
          pipeline,
          log,
          listeningSignal,
          {
            file: values.wav,
            device: values.device,
          },
          activity,
        );
        break;
      } catch (error) {
        if (!listeningSignal.aborted || controller.signal.aborted) {
          throw error;
        }

        // Pause killed the recorder and pending work. Wait for cancellation to
        // settle before a new period reuses VAD or accepts more microphone audio.
        await pipeline.idle();
      }
    } while (!values.wav);

    await pipeline.idle();
    await agents.idle();
  } catch (error) {
    // A requested stop is normal. Other failures reach the top-level error log.
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    // Stop producers and pending work before releasing VAD's native resources.
    controller.abort();
    clearTimeout(timer);

    await pipeline?.idle();
    await transcriber?.close();
    await external?.close();
    await agents.close();
    await vad?.close();
    await desktop?.close();

    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);

    if (pipeline?.failures) {
      process.exitCode = 1;
    }

    if (!values.graph) {
      log('stopped', 'Capture and processing stopped');
    }
  }
}

main().catch((error) => {
  log('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
