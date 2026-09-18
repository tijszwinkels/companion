import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_RESPONSE_BYTES = 32 * 1024;

type ResponseType = 'ready' | 'result';

interface PendingResponse {
  type: ResponseType;
  resolve(text: string): void;
  reject(error: unknown): void;
}

/**
 * Pipe transport for one owned native ASR process. There is no request queue:
 * the audio pipeline serializes utterances, and Transcriber guards its caller.
 * Protocol errors and cancellation destroy this instance. A failed operation
 * settles only after close, so recovery cannot overlap two native models.
 */
export class AsrWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;

  private pending?: PendingResponse;
  private buffered = Buffer.alloc(0);
  private failure?: Error;

  constructor(binary: string, modelDir: string) {
    this.child = spawn(binary, ['--model', modelDir], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.closed = new Promise((resolve) => {
      this.child.once('close', () => {
        this.failure ??= Error('ASR worker exited');
        this.buffered.fill(0);
        this.buffered = Buffer.alloc(0);
        this.pending?.reject(this.failure);
        this.pending = undefined;
        resolve();
      });
    });

    this.child.once('error', () => {
      this.stop(Error('Cannot start ASR worker; run npm run asr:build and check asr.workerBinary'));
    });
    this.child.once('exit', () => this.stop(Error('ASR worker exited')));
    this.child.stdin.on('error', () => this.stop(Error('ASR worker input closed')));
    this.child.stdout.on('error', () => this.stop(Error('ASR worker output failed')));
    this.child.stdout.on('end', () => this.stop(Error('ASR worker output ended')));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));

    // Drain native diagnostics without retaining or forwarding them. Library
    // error strings can contain input paths or transcription fragments.
    this.child.stderr.resume();
    this.child.stderr.on('error', () => this.stop(Error('ASR worker diagnostics failed')));
  }

  get usable(): boolean {
    return this.failure === undefined;
  }

  async ready(signal: AbortSignal): Promise<void> {
    await this.exchange('ready', signal);
  }

  transcribe(packet: Buffer, signal: AbortSignal): Promise<string> {
    return this.exchange('result', signal, packet);
  }

  /** SIGKILL also interrupts synchronous native inference or model loading. */
  stop(error: Error): void {
    if (this.failure) {
      return;
    }

    this.failure = error;
    this.child.kill('SIGKILL');
    this.child.stdin.destroy();
  }

  private async exchange(
    type: ResponseType,
    signal: AbortSignal,
    packet?: Buffer,
  ): Promise<string> {
    const abort = () => {
      const reason =
        signal.reason instanceof Error ? signal.reason : Error('ASR operation cancelled');
      this.stop(reason);
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      if (signal.aborted) {
        abort();
      }
      if (this.failure) {
        await this.closed;
        throw this.failure;
      }
      if (this.pending) {
        throw Error('ASR worker already has a request');
      }

      return await new Promise<string>((resolve, reject) => {
        this.pending = { type, resolve, reject };

        if (packet) {
          // A single bounded write applies pipe backpressure without another
          // application queue. The caller owns the packet until this settles.
          this.child.stdin.write(packet, (error) => {
            if (error) {
              this.stop(Error('ASR worker input failed'));
            }
          });
        }
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) {
      return;
    }
    if (!this.pending) {
      this.stop(Error('ASR worker sent an unsolicited response'));
      return;
    }
    if (this.buffered.length + chunk.length > MAX_RESPONSE_BYTES) {
      this.stop(Error('ASR worker response exceeds 32768 bytes'));
      return;
    }

    this.buffered = Buffer.concat([this.buffered, chunk]);
    const newline = this.buffered.indexOf(10);
    if (newline < 0) {
      return;
    }

    try {
      // No extra lines or partial messages may follow a response. Strict UTF-8
      // avoids silently repairing a damaged transcript before delivery.
      if (newline !== this.buffered.length - 1) {
        throw Error('ASR worker sent extra response data');
      }
      let message: Record<string, unknown> | null;
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(this.buffered);
        message = JSON.parse(json);
      } catch {
        // Parser errors may quote speech. Only our fixed diagnostics leave this module.
        throw Error('ASR worker sent malformed JSON or UTF-8');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw Error('ASR worker sent an invalid response');
      }
      if (message.type === 'error') {
        if (message.code === 'model') {
          throw Error('ASR model could not load; check asr.modelDir and the TDT model files');
        }
        if (message.code === 'transcript_limit') {
          throw Error('Transcript exceeds 4000 characters');
        }
        throw Error('ASR worker could not transcribe this utterance');
      }

      let text = '';
      if (this.pending.type === 'ready') {
        if (
          message.type !== 'ready' ||
          message.protocol !== 1 ||
          message.engine !== 'parakeet-tdt' ||
          message.decoder !== 'parakeet-rs/0.3.5'
        ) {
          throw Error('Incompatible ASR worker; run npm run asr:build');
        }
      } else {
        if (message.type !== 'result' || typeof message.text !== 'string') {
          throw Error('ASR worker sent an invalid transcript');
        }
        if (message.text.length > 4000) {
          throw Error('Transcript exceeds 4000 characters');
        }
        text = message.text;
      }

      const response = this.pending;
      this.pending = undefined;
      this.buffered.fill(0);
      this.buffered = Buffer.alloc(0);
      response.resolve(text);
    } catch (error) {
      this.stop(error as Error);
    }
  }
}
