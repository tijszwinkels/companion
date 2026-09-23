/** Browser code and capabilities never belong in the agent's tool arguments. */
export type JsonObject = Record<string, unknown>;

export interface WidgetAction {
  description: string;
  parameters: JsonObject;
  returns: JsonObject;
}

export interface WidgetManifest {
  name: string;
  version: number;
  description: string;
  parameters: JsonObject;
  actions: Record<string, WidgetAction>;
  example: JsonObject;
}

export interface WidgetBundle {
  hash: string;
  manifest: WidgetManifest;
  javascript: string;
  css: string;
}

export interface WidgetPresentation {
  placement: 'inline' | 'pinned';
  heightPercent: number;
  replaceActivity: boolean;
}

/** Persisted state references an immutable copy of the library implementation. */
export interface WidgetRecord {
  id: string;
  owner: string;
  bundle: string;
  name: string;
  props: JsonObject;
  revision: number;
  text: string;
  presentation: WidgetPresentation;
  receipts: { id: string; result: JsonObject }[];
}

/** Compact display attachment. The service derives view URLs for this process. */
export interface WidgetAttachment {
  id: string;
  name: string;
  revision: number;
  presentation: WidgetPresentation;
  viewUrl?: string;
}

export interface WidgetLease {
  endpoint: string;
  token: string;
  release(): void;
}

/**
 * Companion's effective text scale is the theme unit (0.5–3) multiplied by the
 * reader zoom (80–200%). Views and viewport reports accept that whole product,
 * so the captured sidebar, native view and pop-out agree at the extremes.
 * `integrations/panel/WidgetSurface.qml` and `integrations/widgets/host.js`
 * repeat these bounds because they cannot import TypeScript.
 */
export const minimumTextScale = 0.4;
export const maximumTextScale = 6;

export interface WidgetViewport {
  width: number;
  height: number;
  scale: number;
  pixelRatio: number;
  foreground: string;
  background: string;
  accent: string;
  muted: string;
}

export const defaultPresentation: WidgetPresentation = {
  placement: 'inline',
  heightPercent: 25,
  replaceActivity: true,
};

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('Expected a JSON object');
  }
  return value as JsonObject;
}

export function boundedJson(value: unknown, maximum = 128 * 1024): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maximum) {
    throw Error('Widget data exceeds the size limit');
  }
  return json;
}

export function presentation(value: unknown): WidgetPresentation {
  const input = object(value);
  const placement = input.placement ?? 'inline';
  const heightPercent = input.heightPercent ?? 25;
  const replaceActivity = input.replaceActivity ?? true;
  if (
    !['inline', 'pinned'].includes(String(placement)) ||
    typeof heightPercent !== 'number' ||
    !Number.isInteger(heightPercent) ||
    heightPercent < 10 ||
    heightPercent > 100 ||
    typeof replaceActivity !== 'boolean' ||
    Object.keys(input).some(
      (key) => !['placement', 'heightPercent', 'replaceActivity'].includes(key),
    )
  ) {
    throw Error(
      'Use inline/pinned placement, an integer heightPercent from 10 to 100, and replaceActivity',
    );
  }
  return {
    placement: placement as WidgetPresentation['placement'],
    heightPercent,
    replaceActivity,
  };
}

export function attachment(value: unknown): WidgetAttachment {
  const input = object(value);
  if (
    typeof input.id !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.id) ||
    typeof input.name !== 'string' ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(input.name) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 1
  ) {
    throw Error('Invalid widget attachment');
  }
  return {
    id: input.id,
    name: input.name,
    revision: Number(input.revision),
    presentation: presentation(input.presentation),
  };
}
