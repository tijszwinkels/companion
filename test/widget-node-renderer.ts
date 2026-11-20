/**
 * A widget renderer that runs a bundle's own module in Node: describe(),
 * actions and queries are evaluated here instead of in the isolated
 * Chromium renderer, which is not available in every environment. Drawing
 * happens in the browser that shows the widget (host.js and frame.js), so
 * `render` does nothing. Used by the frame fixture (test/frame-fixture.ts)
 * and the browser shell's demo (integrations/shell/demo.ts).
 *
 * Only for code the test or demo wrote itself: the module runs in this Node
 * process without any sandbox.
 */

import type { JsonObject, WidgetBundle, WidgetRecord } from '../src/widgets/types.ts';

/** The bundle's own module, evaluated in Node (test-controlled code only). */
type WidgetModule = {
  describe(props: JsonObject): string;
  actions?: Record<string, (props: JsonObject, args: JsonObject, context: object) => any>;
  queries?: Record<string, (props: JsonObject, args: JsonObject) => any>;
  mount?: unknown;
};

const modules = new Map<string, Promise<WidgetModule>>();

function moduleOf(bundle: WidgetBundle): Promise<WidgetModule> {
  let loaded = modules.get(bundle.hash);
  if (!loaded) {
    const url = 'data:text/javascript;base64,' + Buffer.from(bundle.javascript).toString('base64');
    loaded = import(url) as Promise<WidgetModule>;
    modules.set(bundle.hash, loaded);
  }
  return loaded;
}

/**
 * Replace the methods of a widget renderer object in place (the application
 * host holds the same object) with Node-side equivalents.
 */
export function useNodeRenderer(renderer: object): void {
  Object.assign(renderer, {
    async describe(record: WidgetRecord, bundle: WidgetBundle) {
      return String((await moduleOf(bundle)).describe(structuredClone(record.props)));
    },
    async reduce(
      record: WidgetRecord,
      bundle: WidgetBundle,
      action: string,
      args: JsonObject,
      requestId: string,
    ) {
      const implementation = (await moduleOf(bundle)).actions?.[action];
      if (!implementation) {
        throw Error('Widget action is not implemented');
      }
      const value = implementation(structuredClone(record.props), structuredClone(args), {
        requestId,
      });
      return { props: value.props ?? value.state, result: value.result ?? {} };
    },
    async query(record: WidgetRecord, bundle: WidgetBundle, name: string, args: JsonObject) {
      const implementation = (await moduleOf(bundle)).queries?.[name];
      if (!implementation) {
        throw Error('Application query is not implemented');
      }
      return implementation(structuredClone(record.props), structuredClone(args));
    },
    async inspect(_record: WidgetRecord, bundle: WidgetBundle) {
      const implementation = await moduleOf(bundle);
      return {
        mount: typeof implementation.mount === 'function',
        describe: typeof implementation.describe === 'function',
        actions: Object.keys(implementation.actions ?? {}),
        queries: Object.keys(implementation.queries ?? {}),
      };
    },
    async render() {},
    async discard() {},
    dimensions() {
      return undefined;
    },
    async close() {},
  });
}
