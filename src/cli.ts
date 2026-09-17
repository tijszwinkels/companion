import { parseArgs, styleText, stripVTControlCharacters } from 'node:util';
import { access } from 'node:fs/promises';

import { loadConfig } from './config.ts';
import { IntentDetector } from './core/intent-detector.ts';
import { UserSensorRouter } from './core/router.ts';
import { Ignore } from './processors/ignore.ts';
import { SendTextToApplication } from './processors/send-text-to-application.ts';
import { captureActiveWindow } from './sensors/screen/capture.ts';
import { Transcriber } from './sensors/audio/transcriber.ts';
import { VoiceActivityDetector } from './sensors/audio/vad.ts';
import { Segmenter } from './sensors/audio/segmenter.ts';
import { audioFrames } from './sensors/audio/capture.ts';
import { SensorPipeline } from './core/pipeline.ts';
import { command } from './system/command.ts';
import type { Log } from './core/frame.ts';

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
      text: { type: 'string' },
      wav: { type: 'string' },
      device: { type: 'string' },
      preview: { type: 'boolean', default: false },
      seconds: { type: 'string' },
    },
  });

  if (values.help) {
    console.log(`Companion — microphone + active-window intent routing

Usage: npm start -- [options]
  --preview          Log text delivery instead of typing it
  --text "utterance" Classify one supplied utterance with a live screenshot
  --wav file.wav     Run an audio file through VAD, ASR, and intent routing
  --device name      PipeWire capture node (default: system microphone)
  --seconds N        Stop microphone capture after N seconds
  --config path      JSON configuration (default: companion.config.json)

Live mode types detected dictation into the same focused window. Ctrl+C stops.
No Enter key is sent. Start inside your Hyprland desktop session.`);
    return;
  }

  // Validate CLI input before opening the microphone or contacting the model.
  if (values.text !== undefined && values.wav) {
    throw Error('Choose --text or --wav');
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
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let vad: VoiceActivityDetector | undefined;
  let pipeline: SensorPipeline | undefined;
  let audioFrameCount = 0;

  try {
    log(
      'start',
      `Companion · ${config.llm.model} · ${values.preview ? 'preview' : 'type into focused application'}`,
    );

    // Subscriptions provide both the detector's prompt entries and its targets.
    const router = new UserSensorRouter(new IntentDetector(config.llm), log);
    new SendTextToApplication(log, values.preview).subscribe(router);
    new Ignore(log).subscribe(router);
    log('registered', 'SEND_TEXT_TO_APPLICATION, IGNORE');

    // Supplied text enters the same routing path but needs no audio resources.
    if (values.text !== undefined) {
      log('capture', 'Capturing active window', 1);
      const screenshot = await captureActiveWindow(controller.signal);
      log('frame', 'Supplied utterance + screenshot', 1);
      await router.route(
        { id: 1, observedAt: Date.now(), utterance: values.text, screenshot },
        controller.signal,
      );

      return;
    }

    // Check local dependencies before announcing that microphone capture is on.
    await access(config.asr.modelDir);
    const version = await command(
      config.asr.binary,
      ['--version'],
      AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    );
    if (!/^voxtype 1\.0\.1\s*$/m.test(version.toString())) {
      throw Error('Expected Voxtype 1.0.1');
    }

    await captureActiveWindow(controller.signal);
    vad = await VoiceActivityDetector.create(config.vadModel);

    const asr = new Transcriber(config.asr);
    pipeline = new SensorPipeline(
      { capture: captureActiveWindow, transcribe: asr.transcribe.bind(asr) },
      router,
      log,
      controller.signal,
    );
    const segmenter = new Segmenter();

    if (seconds !== undefined) {
      timer = setTimeout(stop, seconds * 1000);
    }

    log(
      'listening',
      values.wav ? `Audio file: ${values.wav}` : 'Microphone active · Ctrl+C to stop',
    );

    // The capture loop only waits for VAD. ASR and intent detection run in the
    // pipeline's separate worker, so a model request does not pause listening.
    for await (const frame of audioFrames(controller.signal, {
      file: values.wav,
      device: values.device,
    })) {
      const wasSpeaking = segmenter.speaking;
      const segment = segmenter.push(await vad.probability(frame), frame);

      if (!wasSpeaking && segmenter.speaking) {
        log('speech', 'Speech detected');
      }
      audioFrameCount++;

      if (segment) {
        log('utterance', `Speech ended (${segment.reason})`);
        pipeline.submit(segment.samples);

        // Files can decode much faster than real time. Waiting here prevents
        // offline playback from overflowing the bounded utterance queue.
        if (values.wav) {
          await pipeline.idle();
        }
      }
    }

    // A file can end during speech, without the usual silence that closes it.
    const tail = segmenter.finish();
    if (tail) {
      pipeline.submit(tail.samples);
    }

    await pipeline.idle();
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
    await vad?.close();

    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);

    if (audioFrameCount) {
      log('audio', `${audioFrameCount} frames processed`);
    }
    if (pipeline?.failures) {
      process.exitCode = 1;
    }

    log('stopped', 'Capture and processing stopped');
  }
}

main().catch((error) => {
  log('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
