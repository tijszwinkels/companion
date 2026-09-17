import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, UserMessage } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Intent, UserSensorFrame } from './frame.ts';
import type { Detector } from './router.ts';

export interface LlmConfig { baseUrl: string; model: string; timeoutMs: number }
export const MAX_OUTPUT_TOKENS = 32;

export function buildPrompt(intents: readonly Intent[]): string {
  return `You are an AI system that processes user utterances together with screenshots of the application that the user is currently using, and determines what the user wants to happen based on this input. You are an expert in understanding user intent. You answer with ONLY the intent name.
It is possible that the user didn't intent to use any of the available systems. In that case, you return the intent name IGNORE.

Possible intents:

${intents.map(i => `Name: ${i.name}\nInstruction: ${i.instruction}`).join('\n\n')}
`;
}

export function frameMessage(frame: UserSensorFrame): UserMessage {
  return {
    role: 'user', timestamp: frame.observedAt,
    content: [
      { type: 'text', text: JSON.stringify({ utterance: frame.utterance, application: frame.screenshot.window }) },
      { type: 'image', mimeType: 'image/png', data: frame.screenshot.png.toString('base64') },
    ],
  };
}

export class IntentDetector implements Detector {
  private readonly model: Model<'openai-completions'>;
  private readonly stream: StreamFn;

  constructor(private readonly config: LlmConfig, stream?: StreamFn) {
    this.model = {
      id: config.model, name: config.model, provider: 'companion', api: 'openai-completions',
      baseUrl: config.baseUrl, reasoning: true, input: ['text', 'image'],
      contextWindow: 131072, maxTokens: MAX_OUTPUT_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        supportsUsageInStreaming: false, maxTokensField: 'max_tokens', thinkingFormat: 'qwen-chat-template',
      },
    };
    this.stream = stream ?? ((_model, context, options) => streamSimple(this.model, context, {
      ...options, apiKey: process.env.COMPANION_LLM_API_KEY || 'local',
      temperature: 0, maxTokens: MAX_OUTPUT_TOKENS, maxRetries: 0,
    }));
  }

  async detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    deadline.throwIfAborted();
    // A fresh Pi agent keeps each request to one frame, with no growing history.
    const agent = new Agent({
      initialState: { model: this.model, systemPrompt: buildPrompt(intents), thinkingLevel: 'off', tools: [] },
      streamFn: this.stream, shouldStopAfterTurn: () => true,
    });
    const abort = () => agent.abort();
    deadline.addEventListener('abort', abort, { once: true });
    try {
      await agent.prompt(frameMessage(frame));
      deadline.throwIfAborted();
      const reply = agent.state.messages.at(-1);
      if (reply?.role !== 'assistant') throw Error(agent.state.errorMessage || 'No intent response');
      if (reply.stopReason !== 'stop') throw Error(reply.errorMessage || `Intent response ended: ${reply.stopReason}`);
      if (reply.content.some(part => part.type !== 'text')) throw Error('Expected only an intent name');
      const name = reply.content.map(part => part.type === 'text' ? part.text : '').join('').trim();
      if (!intents.some(intent => intent.name === name)) throw Error(`Invalid intent response: ${JSON.stringify(name)}`);
      return name;
    } finally {
      deadline.removeEventListener('abort', abort);
      agent.reset();
    }
  }
}
