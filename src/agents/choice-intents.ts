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

export interface AgentActions {
  sessionId: string;
  choices: AgentChoiceState[];
  stopRunId: string;
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
      collision(option.label, prefixes) ||
      (available
        ? ''
        : interaction.agentFollowUpUnavailableReason || 'Available when the agent finishes');
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
      // Unavailable labels are ordinary speech. Only choices that were active
      // at capture can reserve a label; those still recheck identity at dispatch.
      exactUtterance: choice.voiceAvailable ? choice.label : undefined,
      instruction:
        choice.available && voiceLabel(choice.label) !== 'stop'
          ? this.instruction(choice)
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

  private instruction(choice: AgentChoiceState): string {
    // The full description remains visible and is submitted unchanged. Routing
    // only needs a short preview; eight long payloads should not dominate every
    // detection request for this conversation.
    const description = choice.description.replace(/\s+/gu, ' ');
    const preview = description.length > 160 ? description.slice(0, 160) + '…' : description;
    return `Choose the open agent's option ${JSON.stringify(choice.label)}${preview ? `: ${JSON.stringify(preview)}` : ''}. Select only if the utterance expresses this choice; otherwise keep it as a freeform follow-up.`;
  }

  private skip(frame: UserSensorFrame, reason: string): void {
    this.log('skipped', reason, frame.id);
    this.activity.outcome?.(frame.id, 'skipped');
  }
}
