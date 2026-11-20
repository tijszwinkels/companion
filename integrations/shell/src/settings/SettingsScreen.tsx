/**
 * The settings screen, shown in place of the chat (the bar above it then
 * says "Settings"). Two sections:
 *
 * - **Display**: this browser's switches for the times the listener
 *   publishes (./display-settings.ts), applied at once and remembered in
 *   this browser only;
 * - **Listening**: the listener's own Sound feedback and intent and
 *   shortcut switches (./listening-switches.ts), shared with the desktop and
 *   other clients, changed through the gateway (`toggle-sounds`,
 *   `set-intent-enabled`).
 *
 * Switches are buttons with the `switch` role. An unavailable one stays
 * focusable and is marked `aria-disabled` (as the Activity column's
 * buttons, ../activity/ActionButton.tsx), so a keyboard press whose request
 * makes it unavailable while the answer is on its way does not lose focus.
 * A press checks the switch again against the Store's current state.
 */

import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { ActivityRequests } from '../activity/requests.ts';
import {
  displaySettingNames,
  type DisplaySettingName,
  type DisplaySettings,
} from './display-settings.ts';
import { listeningView, type ListeningSwitch } from './listening-switches.ts';
import { useDisplaySettings } from './useDisplaySettings.ts';

/** The settings screen's id, named by the gear button (`aria-controls`). */
export const settingsScreenId = 'settings-screen';

/** Each Display switch's title and line of explanation (the agreed design's wording). */
const displayWording: Record<DisplaySettingName, { title: string; description: string }> = {
  turnTimers: {
    title: 'Turn timers',
    description:
      'How long each running turn has been going, in the chat header and on the conversation list.',
  },
  lastTurnDuration: {
    title: 'Last turn duration',
    description: 'After a turn has finished, show how long it took in the chat header.',
  },
  messageTimestamps: {
    title: 'Message timestamps',
    description: 'Show the time on each message.',
  },
};

export function SettingsScreen(props: {
  settings: DisplaySettings;
  /** Whether requests are admitted (`GatewayChatBridge.admitted`). */
  admitted: () => boolean;
  /** Listening requests awaiting their answer (the workspace's, for the pairing). */
  requests: ActivityRequests;
}) {
  const values = useDisplaySettings(props.settings);

  return (
    <div class="settings-screen" id={settingsScreenId}>
      <section class="settings-section" aria-labelledby="settings-display">
        <h2 class="settings-heading" id="settings-display">
          Display
        </h2>
        {displaySettingNames.map((name) => (
          <SettingSwitch
            key={name}
            id={`setting-${name}`}
            title={displayWording[name].title}
            description={displayWording[name].description}
            checked={values[name]}
            available={true}
            onPress={() => props.settings.set(name, !props.settings.values[name])}
          />
        ))}
        <p class="settings-hint">Kept in this browser only.</p>
      </section>
      <ListeningSection admitted={props.admitted} requests={props.requests} />
    </div>
  );
}

/** The listener's own switches (./listening-switches.ts). */
function ListeningSection(props: { admitted: () => boolean; requests: ActivityRequests }) {
  const store = useStore();
  const state = useAppState();
  const view = listeningView(state.engine, props.admitted(), (key) =>
    props.requests.isPending(key),
  );

  /**
   * Ask the listener for the change of one switch, after checking it again
   * against the Store's state now (the switch may have been drawn for an
   * older one). A refusal shows the Store's toast; the switch keeps the
   * listener's value.
   */
  function press(drawn: ListeningSwitch) {
    const current = listeningView(store.state.engine, props.admitted(), (key) =>
      props.requests.isPending(key),
    ).switches.find((candidate) => candidate.key === drawn.key);
    if (!current || !current.available) {
      return;
    }
    if (current.kind === 'sounds') {
      void props.requests.run(current.key, () => store.request('toggle-sounds', {}));
      return;
    }
    const mode = current.kind;
    void props.requests.run(current.key, () =>
      store.request('set-intent-enabled', {
        name: current.intent,
        mode,
        enabled: !current.checked,
      }),
    );
  }

  return (
    <section class="settings-section" aria-labelledby="settings-listening">
      <h2 class="settings-heading" id="settings-listening">
        Listening
      </h2>
      {view.notes.map((note) => (
        <p key={note} class="settings-note">
          {note}
        </p>
      ))}
      {view.switches.map((entry) => (
        <SettingSwitch
          key={entry.key}
          id={`setting-${entry.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
          title={entry.label}
          name={entry.name}
          description={entry.description}
          checked={entry.checked}
          available={entry.available}
          onPress={() => press(entry)}
        />
      ))}
      <p class="settings-hint">Companion's own settings, shared with the computer.</p>
    </section>
  );
}

/**
 * One setting: its title and one line of explanation, and the switch. The
 * whole row is the switch's label; the explanation is its description.
 */
function SettingSwitch(props: {
  id: string;
  title: string;
  /** The switch's accessible name when it is not the title. */
  name?: string;
  description: string;
  checked: boolean;
  available: boolean;
  onPress: () => void;
}) {
  const titleId = `${props.id}-title`;
  const descriptionId = `${props.id}-description`;

  function click() {
    if (!props.available) {
      return;
    }
    props.onPress();
  }

  const classes = ['setting-row'];
  if (!props.available) {
    classes.push('unavailable');
  }

  return (
    <div class={classes.join(' ')} onClick={click}>
      <div class="setting-text">
        <span class="setting-title" id={titleId}>
          {props.title}
        </span>
        <span class="setting-description" id={descriptionId}>
          {props.description}
        </span>
      </div>
      <button
        type="button"
        class="setting-switch"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.name}
        aria-labelledby={props.name ? undefined : titleId}
        aria-describedby={descriptionId}
        aria-disabled={props.available ? undefined : 'true'}
        onClick={(event) => {
          // The row's handler presses it once.
          event.stopPropagation();
          click();
        }}
      />
    </div>
  );
}
