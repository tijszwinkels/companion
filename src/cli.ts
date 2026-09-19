import { parseArgs, styleText, stripVTControlCharacters } from 'node:util';

import { loadConfig } from './config.ts';
import { IntentDetector } from './core/intent-detector.ts';
import { UserSensorRouter } from './core/router.ts';
import { Ignore } from './processors/ignore.ts';
import { EnterTextToApplication } from './processors/enter-text-to-application.ts';
import { SendTextToApplication } from './processors/send-text-to-application.ts';
import { StartCodingAgentSession } from './processors/start-coding-agent-session.ts';
import { ContinueOpenAgentConversation } from './processors/continue-open-agent-conversation.ts';
import { LabelPreviousCorrect } from './processors/label-previous-correct.ts';
import { LabelPreviousIncorrect } from './processors/label-previous-incorrect.ts';
import { AgentSessions } from './agents/sessions.ts';
import { PiBackend } from './agents/pi-backend.ts';
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
  const label = `${timestamp} ${frameLabel} ${stage.padEnd(10)}`;
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
  --paused           Start paused; resume through the desktop control

Live mode types detected dictation into the same focused window. Ctrl+C stops.
"insert …" types directly; "enter …" types and presses Enter. Both bypass the LLM.
"new coding agent …" or "quick question …" asks Pi and opens a session tab.
"message coding agent …" continues the currently open agent conversation.
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

  const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw Error('--seconds must be positive');
  }

  const config = await loadConfig(values.config);

  // Every asynchronous stage observes this signal, so Ctrl+C cancels the whole
  // session, including an in-flight transcription or intent request.
  const controller = new AbortController();
  const agents = new AgentSessions({ backend: new PiBackend() }, log);
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

    const activity = desktop?.activity ?? { delivery: new DeliveryControl() };

    // Subscriptions provide prefix shortcuts and/or the detector's prompt entries.
    const detector = new IntentDetector(config.llm);
    const router = new UserSensorRouter({ detector }, log, activity);
    new SendTextToApplication(log, values.preview, command, activity).subscribe(router);
    new EnterTextToApplication(log, values.preview, command, activity).subscribe(router);
    new Ignore(log, activity).subscribe(router);
    new StartCodingAgentSession({ sessions: agents }, log, values.preview, activity).subscribe(
      router,
    );
    new ContinueOpenAgentConversation(
      { sessions: agents },
      log,
      values.preview,
      activity,
    ).subscribe(router);

    new LabelPreviousCorrect(log, values.preview, activity).subscribe(router);
    new LabelPreviousIncorrect(log, values.preview, activity).subscribe(router);

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
      'SEND_TEXT_TO_APPLICATION (insert), ENTER_TEXT_TO_APPLICATION (enter), IGNORE, START_CODING_AGENT_SESSION (new coding agent / quick question), CONTINUE_OPEN_AGENT_CONVERSATION (message coding agent / focused composer), LABEL_PREVIOUS_CORRECT, LABEL_PREVIOUS_INCORRECT',
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
    log('asr', 'Loading Parakeet transcription worker');
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
