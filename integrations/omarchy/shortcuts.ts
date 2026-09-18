/** Check compositor bindings before the installer changes any user files. */
export function assertShortcutsAvailable(
  serializedBindings: string,
  alreadyInstalled: boolean,
): void {
  let registered: unknown;

  try {
    registered = JSON.parse(serializedBindings);
  } catch {
    throw Error('Cannot check shortcut conflicts: hyprctl -j binds returned invalid JSON');
  }

  if (!Array.isArray(registered)) {
    throw Error('Cannot check shortcut conflicts: expected a Hyprland binding array');
  }

  // These descriptions identify previously installed Companion bindings. Keep
  // them stable alongside bindings.lua so reinstalling retains our own chords.
  const shortcuts = [
    { key: 'v', description: 'Companion utterance history (hold, select, release to paste)' },
    { key: 'c', description: 'Companion side panel' },
    { key: 'p', description: 'Companion pause/resume listening' },
    { key: 'd', description: 'Companion conversation input focus' },
  ];

  for (const binding of registered) {
    if (!binding || typeof binding.modmask !== 'number' || typeof binding.key !== 'string') {
      throw Error('Cannot check shortcut conflicts: unexpected Hyprland binding format');
    }

    // Lua bindings may include the full display chord, e.g. SUPER + ALT + C.
    // Other versions expose only C; modifiers come from modmask in both cases.
    const key = binding.key
      .split(/\s*\+\s*/)
      .at(-1)
      ?.trim()
      .toLowerCase();
    const shortcut = shortcuts.find((candidate) => candidate.key === key);

    if (binding.modmask !== 72 || !shortcut) {
      continue;
    }

    if (alreadyInstalled && binding.description === shortcut.description) {
      continue;
    }

    throw Error(
      `Super+Alt+${shortcut.key.toUpperCase()} is already bound to ${binding.description || 'another action'}`,
    );
  }
}
