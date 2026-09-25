/**
 * Cleanup-only model call for explicit voice shortcuts ("insert …", "enter …",
 * "quick question …", "new session …", "continue session …").
 *
 * Input: the shortcut's fixed text route, the text after the spoken prefix and
 * the captured frame. Output: either cleaned text, or the reason why the raw
 * text must be used. The route never changes: this module returns text only,
 * and a response naming any other route is refused (`route-changed`).
 *
 * Only SEND_TEXT_TO_APPLICATION sends the screenshot and application metadata,
 * for application-aware formatting; every other route sends only the text.
 *
 * Timing: one request, bounded by SHORTCUT_CLEANUP_TIMEOUT_MS from the moment
 * `clean` is called. A timeout or any failure of this call returns the raw
 * text (`raw-text`), so the user's shortcut still acts, just uncleaned. Only
 * the caller's own cancellation (shutdown, pause, disabling the route) throws,
 * because then nothing may be delivered at all.
 */
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, UserMessage } from '@earendil-works/pi-ai';

import type { UserSensorFrame } from '../frame.ts';
import type { LlmConfig } from '../intent-detector.ts';
import { CLEANUP_OUTPUT_TOKENS, localModel, localStream } from '../intent-detector.ts';
import type { TextCleaner, FixedRouteCleanup } from '../router.ts';
import type { TextRoute } from './contract.ts';
import { fixedRouteSystemPrompt } from './prompt.ts';
import { interpretFixedRouteResponse } from './response.ts';

/**
 * Upper bound for one explicit-shortcut cleanup call, in milliseconds.
 *
 * The json-cleanup-v1 measurement on the local Qwen took about 2.8 s per call
 * (classification plus cleanup, with a screenshot). Eight seconds leaves room
 * for long dictation (up to the 512-token output budget) while keeping the
 * worst case, a timeout followed by raw-text delivery, short enough to notice
 * and judge. Later utterances wait behind this call, as they do for detection.
 */
export const SHORTCUT_CLEANUP_TIMEOUT_MS = 8000;

export class FixedRouteCleaner implements TextCleaner {
  readonly label = 'Transcription cleanup';
  readonly dependencies = {};

  private readonly model: Model<'openai-completions'>;
  private readonly stream: StreamFn;

  constructor(
    config: LlmConfig,
    stream?: StreamFn,
    readonly id = 'transcription-cleanup',
    private readonly timeoutMs = SHORTCUT_CLEANUP_TIMEOUT_MS,
  ) {
    this.model = localModel(config, CLEANUP_OUTPUT_TOKENS);

    // An injected stream makes transport tests possible without a live model.
    this.stream = stream ?? localStream;
  }

  async clean(
    route: TextRoute,
    text: string,
    frame: UserSensorFrame,
    signal: AbortSignal,
  ): Promise<FixedRouteCleanup> {
    signal.throwIfAborted();

    // The time limit belongs to this call only. Keep it separate from the
    // caller's signal so the two outcomes stay distinguishable below.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const deadline = AbortSignal.any([signal, timeout]);

    // A fresh Pi agent per call, like the intent detector: no history.
    const agent = new Agent({
      initialState: {
        model: this.model,
        systemPrompt: fixedRouteSystemPrompt(route),
        thinkingLevel: 'off',
        tools: [],
      },
      streamFn: this.stream,
      shouldStopAfterTurn: () => true,
    });

    const abort = () => agent.abort();
    deadline.addEventListener('abort', abort, { once: true });

    try {
      await agent.prompt(cleanupMessage(route, text, frame));

      // The caller's cancellation wins over everything: deliver nothing.
      signal.throwIfAborted();
      if (timeout.aborted) {
        return { kind: 'raw-text', reason: 'timeout' };
      }

      // Never use partial output, reasoning or tool calls.
      const reply = agent.state.messages.at(-1);
      if (
        reply?.role !== 'assistant' ||
        reply.stopReason !== 'stop' ||
        reply.content.some((part) => part.type !== 'text')
      ) {
        return { kind: 'raw-text', reason: 'request-failed' };
      }

      // Validate the reply exactly as received, without trimming.
      const responseText = reply.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
      const decision = interpretFixedRouteResponse(responseText, route);

      if (decision.kind === 'raw-text') {
        return { kind: 'raw-text', reason: decision.reason };
      }
      return { kind: 'cleaned', text: decision.text };
    } catch {
      // Cancellation by the caller is not a cleanup failure: rethrow it.
      signal.throwIfAborted();
      if (timeout.aborted) {
        return { kind: 'raw-text', reason: 'timeout' };
      }
      return { kind: 'raw-text', reason: 'request-failed' };
    } finally {
      deadline.removeEventListener('abort', abort);

      // Release the transcript, including any base64 screenshot.
      agent.reset();
    }
  }
}

/**
 * The user message of a fixed-route cleanup request, in the experiment's
 * shape: `{"utterance": …}` as JSON text, plus for SEND_TEXT_TO_APPLICATION
 * only the captured application metadata and the screenshot.
 */
function cleanupMessage(route: TextRoute, text: string, frame: UserSensorFrame): UserMessage {
  const withContext = route === 'SEND_TEXT_TO_APPLICATION';

  const userData: Record<string, unknown> = { utterance: text };
  if (withContext) {
    userData.application = frame.screenshot.window;
  }

  const content: UserMessage['content'] = [{ type: 'text', text: JSON.stringify(userData) }];
  if (withContext) {
    content.push({
      type: 'image',
      mimeType: 'image/png',
      data: frame.screenshot.png.toString('base64'),
    });
  }

  return { role: 'user', timestamp: frame.observedAt, content };
}
