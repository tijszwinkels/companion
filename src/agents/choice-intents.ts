import type { Activity } from '../core/activity.ts';
import type { IntentContext, Log, UserSensorFrame } from '../core/frame.ts';
import { stripPrefix } from '../core/prefix.ts';
import type { UserSensorRouter } from '../core/router.ts';
import type { ScopedIntent } from '../core/scoped-intent.ts';
import { voiceLabel } from '../core/voice-shortcut.ts';
import type { AgentSessions } from './sessions.ts';

/** Portable composer affordances, derived from the same context as routing. */
export interface AgentChoiceState {
  sessionId: string;
  revision: string;
  index: number;
  label: string;
  description: string;
  available: boolean;
  voiceAvailable: boolean;
  voiceReason: string;
}

function collision(label: string, prefixes: readonly string[]): string {
  if (voiceLabel(label) === 'stop') {
    return '“stop” is reserved for stopping the current agent';
  }
  if (prefixes.some((prefix) => stripPrefix(voiceLabel(label), prefix) !== undefined)) {
    return 'This label overlaps a permanent voice shortcut';
  }
  return '';
}

export function agentChoiceStates(
  context: IntentContext,
  prefixes: readonly string[],
): AgentChoiceState[] {
  const interaction = context.interaction;
  if (!interaction?.agentSessionId || !interaction.agentChoices) {
    return [];
  }
  const revision = interaction.agentChoices.revision;
  return interaction.agentChoices.options.map((option, index) => {
    const available = interaction.agentAcceptsFollowUp === true;
    const voiceReason =
      collision(option.label, prefixes) || (available ? '' : 'Available when the agent finishes');
    return {
      sessionId: interaction.agentSessionId,
      revision,
      index,
      ...option,
      available,
      voiceAvailable: !voiceReason,
      voiceReason,
    };
  });
}

/**
 * Conversation-owned choices participate in inference as well as exact routing.
 * Route closures retain the captured set and run; every action rechecks them
 * after ASR/inference. Hiding, switching, replacing, and stop/start cannot retarget
 * an old utterance, even when the same label appears again.
 */
export class AgentChoiceIntents {
  constructor(
    readonly dependencies: { sessions: AgentSessions },
    private readonly log: Log,
    private readonly preview = false,
    private readonly activity: Activity = {},
  ) {}

  subscribe(router: UserSensorRouter): void {
    router.registerScoped((context, prefixes) => this.routes(context, prefixes));
  }

  private routes(context: IntentContext, prefixes: readonly string[]): ScopedIntent[] {
    const interaction = context.interaction;
    if (!interaction?.agentSessionId) {
      return [];
    }
    const routes: ScopedIntent[] = agentChoiceStates(context, prefixes).map((choice) => ({
      name: `CHOOSE_AGENT_OPTION_${choice.index + 1}`,
      // Only a complete utterance matches locally. Colliding labels remain
      // clickable, while permanent shortcuts (including disabled ones) win.
      exactUtterance: collision(choice.label, prefixes) ? undefined : choice.label,
      instruction:
        choice.available && voiceLabel(choice.label) !== 'stop'
          ? `The user chooses this option offered by the open coding agent: ${JSON.stringify(choice.label)}${choice.description ? ` — ${JSON.stringify(choice.description)}` : ''}. Select only when the utterance expresses this choice; freeform follow-ups remain separate.`
          : undefined,
      process: async (frame, signal) => {
        signal.throwIfAborted();
        const current = this.dependencies.sessions.interaction(interaction.agentSessionId);
        if (
          !this.activity.interactionCurrent?.(interaction) ||
          !choice.available ||
          !current.agentAcceptsFollowUp ||
          current.agentChoices?.revision !== choice.revision
        ) {
          this.skip(frame, 'The selected conversation or its choices changed');
          return;
        }
        if (this.preview) {
          this.activity.outcome?.(frame.id, 'preview');
          return;
        }
        this.dependencies.sessions.selectChoice(
          choice.sessionId,
          choice.revision,
          choice.index,
          signal,
        );
        this.activity.outcome?.(frame.id, 'started');
      },
    }));

    if (interaction.agentRunId) {
      const runId = interaction.agentRunId;
      routes.push({
        name: 'STOP_OPEN_AGENT',
        exactUtterance: 'stop',
        process: async (frame, signal) => {
          signal.throwIfAborted();
          if (
            !this.activity.interactionCurrent?.(interaction) ||
            this.dependencies.sessions.interaction(interaction.agentSessionId).agentRunId !== runId
          ) {
            this.skip(frame, 'The selected agent run changed');
            return;
          }
          if (this.preview) {
            this.activity.outcome?.(frame.id, 'preview');
            return;
          }
          await this.dependencies.sessions.stopRun(interaction.agentSessionId, runId);
          this.activity.outcome?.(frame.id, 'cancelled');
        },
      });
    }
    return routes;
  }

  private skip(frame: UserSensorFrame, reason: string): void {
    this.log('skipped', reason, frame.id);
    this.activity.outcome?.(frame.id, 'skipped');
  }
}
