import { parseArgs, styleText, stripVTControlCharacters } from 'node:util';
import { access } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { IntentDetector } from './intent-detector.ts';
import { UserSensorRouter } from './router.ts';
import { Ignore, SendTextToApplication } from './processors.ts';
import { captureActiveWindow } from './screen.ts';
import { Transcriber } from './asr.ts';
import { VoiceActivityDetector } from './vad.ts';
import { Segmenter } from './segmenter.ts';
import { audioFrames } from './audio.ts';
import { SensorPipeline } from './pipeline.ts';
import { command } from './command.ts';
import type { Log } from './frame.ts';

const log: Log = (stage, detail, id) => {
  const label = `${new Date().toLocaleTimeString('en-GB')} ${id === undefined ? '   ' : `#${id}`} ${stage.padEnd(10)}`;
  console.log(`${process.stdout.isTTY ? styleText('cyan', label) : label} ${stripVTControlCharacters(detail).replace(/[\r\n]/g, ' ')}`);
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, config: { type: 'string' },
    text: { type: 'string' }, wav: { type: 'string' }, device: { type: 'string' },
    preview: { type: 'boolean', default: false }, seconds: { type: 'string' },
  } });
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
  if (values.text !== undefined && values.wav) throw Error('Choose --text or --wav');
  if (values.text !== undefined && (!values.text.trim() || values.text.length > 4000)) throw Error('--text requires 1–4000 characters');
  const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw Error('--seconds must be positive');
  const config = await loadConfig(values.config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let vad: VoiceActivityDetector | undefined, pipeline: SensorPipeline | undefined;
  let audioFrameCount = 0;
  try {
    log('start', `Companion · ${config.llm.model} · ${values.preview ? 'preview' : 'type into focused application'}`);
    const router = new UserSensorRouter(new IntentDetector(config.llm), log);
    new SendTextToApplication(log, values.preview).subscribe(router);
    new Ignore(log).subscribe(router);
    log('registered', 'SEND_TEXT_TO_APPLICATION, IGNORE');
    if (values.text !== undefined) {
      log('capture', 'Capturing active window', 1);
      const screenshot = await captureActiveWindow(controller.signal);
      log('frame', 'Supplied utterance + screenshot', 1);
      await router.route({ id: 1, observedAt: Date.now(), utterance: values.text, screenshot }, controller.signal);
      return;
    }
    await access(config.asr.modelDir);
    const version = await command(config.asr.binary, ['--version'], AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
    if (!/^voxtype 1\.0\.1\s*$/m.test(version.toString())) throw Error('Expected Voxtype 1.0.1');
    await captureActiveWindow(controller.signal);
    vad = await VoiceActivityDetector.create(config.vadModel);
    const asr = new Transcriber(config.asr);
    pipeline = new SensorPipeline({ capture: captureActiveWindow, transcribe: asr.transcribe.bind(asr) }, router, log, controller.signal);
    const segmenter = new Segmenter();
    if (seconds !== undefined) timer = setTimeout(stop, seconds * 1000);
    log('listening', values.wav ? `Audio file: ${values.wav}` : 'Microphone active · Ctrl+C to stop');
    for await (const frame of audioFrames(controller.signal, { file: values.wav, device: values.device })) {
      const wasSpeaking = segmenter.speaking;
      const segment = segmenter.push(await vad.probability(frame), frame);
      if (!wasSpeaking && segmenter.speaking) log('speech', 'Speech detected');
      audioFrameCount++;
      if (segment) {
        log('utterance', `Speech ended (${segment.reason})`);
        pipeline.submit(segment.samples);
        if (values.wav) await pipeline.idle(); // Offline files need no realtime backpressure.
      }
    }
    const tail = segmenter.finish();
    if (tail) pipeline.submit(tail.samples);
    await pipeline.idle();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort(); clearTimeout(timer);
    await pipeline?.idle(); await vad?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (audioFrameCount) log('audio', `${audioFrameCount} frames processed`);
    if (pipeline?.failures) process.exitCode = 1;
    log('stopped', 'Capture and processing stopped');
  }
}

main().catch(error => { log('error', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
