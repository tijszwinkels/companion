/** Small display helpers shared by several screens. */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "now", "5 min", "3 h", "Tue", or a date, relative to the phone's clock. */
export function relativeTime(epochMilliseconds: number, now = Date.now()): string {
  const age = now - epochMilliseconds;

  if (age < minute) {
    return 'now';
  }
  if (age < hour) {
    return `${Math.floor(age / minute)} min`;
  }
  if (age < day) {
    return `${Math.floor(age / hour)} h`;
  }
  if (age < 7 * day) {
    return new Date(epochMilliseconds).toLocaleDateString(undefined, { weekday: 'short' });
  }
  return new Date(epochMilliseconds).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function clockTime(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** First visible character of a title (often an emoji), for the avatar tile. */
export function initial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return '•';
  }
  const first = Array.from(trimmed)[0];
  return /\p{Letter}/u.test(first) ? first.toUpperCase() : first;
}

/** Readable form of a registered intent name, e.g. START_CODING_AGENT_SESSION. */
export function intentLabel(name: string | null, labels: Map<string, string>): string {
  if (!name) {
    return 'No intent';
  }
  return labels.get(name) ?? name.toLowerCase().replaceAll('_', ' ');
}

export const statusLabels: Record<string, string> = {
  starting: 'Starting',
  running: 'Working',
  completed: 'Done',
  cancelled: 'Stopped',
  error: 'Error',
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
