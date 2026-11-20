/**
 * The page's Display settings in a component: the current values, drawn
 * again whenever a switch changes here or in another tab
 * (./display-settings.ts).
 */

import { useEffect, useState } from 'preact/hooks';

import type { DisplaySettings, DisplaySettingsValues } from './display-settings.ts';

export function useDisplaySettings(settings: DisplaySettings): DisplaySettingsValues {
  const [values, setValues] = useState(settings.values);

  useEffect(() => {
    const unsubscribe = settings.subscribe(() => {
      setValues(settings.values);
    });
    // A change can arrive between the first render and this subscription.
    setValues(settings.values);
    return unsubscribe;
  }, [settings]);

  return values;
}
