/**
 * The Claude models that an existing Claude Code conversation may switch to
 * for its next turn, from the footer model picker.
 *
 * Claude Code resumes the same native session with a different `--model`
 * (verified with CLI 2.1.280: `get_settings`, `system/init` and the transcript
 * all report the new model, and the history is kept). It does not check that
 * a model exists: `get_settings` echoes any name, and an unknown model fails
 * only at the API. Companion therefore offers a small, explicit allowlist of
 * exact model IDs instead of accepting arbitrary text, aliases or Pi IDs.
 *
 * Effort is fixed per conversation (there is no Claude effort picker). Every
 * listed model therefore either accepts all five `--effort` levels or none at
 * all (it then reports `null`, which the backend accepts with a notice).
 * Claude Code would silently lower an unsupported level instead, which the
 * backend's startup check reports as drift. Keep this invariant when adding
 * a model; for example, Opus 4.6 lacks `xhigh` and must not be listed.
 */

/** Exact model IDs, most capable first. Aliases such as `opus` are not listed. */
export const claudeCodeModelChoices: readonly string[] = Object.freeze([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]);

/**
 * The picker's rows: the allowlist, followed by the configured default model
 * when that is not already listed. The configured model is the user's own
 * explicit choice in `companion-agent.json` and has passed its form check.
 */
export function claudeCodeModelCatalog(configuredModel: string): string[] {
  const models = [...claudeCodeModelChoices];
  if (!models.includes(configuredModel)) {
    models.push(configuredModel);
  }
  return models;
}
