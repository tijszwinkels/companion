/**
 * Classifier request profiles: how the intent classifier and transcription
 * cleanup requests tell an OpenAI-compatible endpoint to switch reasoning off.
 *
 * Every Companion classifier request runs with thinking off. Providers spell
 * that differently, and a field one provider needs can make another reject the
 * request or silently keep reasoning:
 *
 * - `local-qwen` (default): a local vLLM serving Qwen. Sends
 *   `chat_template_kwargs: {enable_thinking: false, preserve_thinking: true}`,
 *   exactly as before profiles existed.
 * - `groq`: Groq rejects `chat_template_kwargs` with HTTP 400. Sends Groq's own
 *   switch, `reasoning_effort: "none"`, and no chat-template field.
 * - `openrouter`: OpenRouter accepts but ignores `chat_template_kwargs`, so
 *   tested Qwen models kept reasoning and spent the whole output budget.
 *   Sends OpenRouter's own switch, `reasoning: {enabled: false}`, and no
 *   chat-template field.
 *
 * Input: the profile name from `llm.requestProfile`. Output: the model `compat`
 * settings and thinking-level map that make the installed Pi adapter
 * (`@earendil-works/pi-ai`, openai-completions) serialize those fields itself.
 * Nothing rewrites the payload afterwards, so the prepared-payload hook still
 * records exactly the request that is sent.
 *
 * This is a closed list on purpose: no arbitrary extra request JSON and no
 * provider registry. A profile names a reasoning-off dialect; it does not
 * promise that every model behind that provider classifies well.
 */
import type { OpenAICompletionsCompat, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** Accepted values of `llm.requestProfile`, in documentation order. */
export const LLM_REQUEST_PROFILES = ['local-qwen', 'groq', 'openrouter'] as const;

export type LlmRequestProfile = (typeof LLM_REQUEST_PROFILES)[number];

/** Used when `llm.requestProfile` is absent: the original local vLLM request. */
export const DEFAULT_LLM_REQUEST_PROFILE: LlmRequestProfile = 'local-qwen';

export function isLlmRequestProfile(value: unknown): value is LlmRequestProfile {
  return LLM_REQUEST_PROFILES.some((profile) => profile === value);
}

/** The parts of a Pi model description that differ between profiles. */
export interface ReasoningOffSettings {
  compat: OpenAICompletionsCompat;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Compat settings shared by every profile. Together with each profile's
 * `thinkingFormat`, these fields shape the request body, so they are set
 * explicitly instead of letting the adapter guess from the base URL (it
 * would, for example, pick its own OpenRouter dialect for an openrouter.ai URL).
 */
const COMMON_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_tokens',
};

/**
 * Model settings that make the installed adapter emit the profile's
 * reasoning-off field while each request's thinking level is `off`.
 */
export function reasoningOffSettings(profile: LlmRequestProfile): ReasoningOffSettings {
  if (profile === 'groq') {
    // OpenAI-style effort: with thinking off the adapter sends
    // `thinkingLevelMap.off` as `reasoning_effort`.
    return {
      compat: {
        ...COMMON_COMPAT,
        supportsReasoningEffort: true,
        thinkingFormat: 'openai',
      },
      thinkingLevelMap: { off: 'none' },
    };
  }

  if (profile === 'openrouter') {
    // The adapter's `openrouter` format would send `reasoning: {effort:
    // "none"}`, which is not the form that was shown to work. Its `together`
    // format sends exactly `reasoning: {enabled: false}` while thinking is off,
    // and no `reasoning_effort` because reasoning effort stays unsupported.
    return {
      compat: {
        ...COMMON_COMPAT,
        supportsReasoningEffort: false,
        thinkingFormat: 'together',
      },
    };
  }

  // The original local vLLM/Qwen request, unchanged.
  return {
    compat: {
      ...COMMON_COMPAT,
      supportsReasoningEffort: false,
      thinkingFormat: 'qwen-chat-template',
    },
  };
}
