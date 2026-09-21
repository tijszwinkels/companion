import { Chromium, type BrowserPage } from './chromium.ts';
import { defaultViewport, expressionValue, widgetDocument } from './document.ts';
import {
  boundedJson,
  object,
  type JsonObject,
  type WidgetBundle,
  type WidgetRecord,
  type WidgetViewport,
} from './types.ts';

interface Surface {
  page: Promise<BrowserPage>;
  lastUsed: number;
  users: number;
  revision: number;
  viewport: string;
  queue: Promise<unknown>;
}

/**
 * Real browser surfaces presented as frames inside portable QtQuick. Browser
 * input stays inside its page: this never injects desktop keys or pointer input.
 * Idle surfaces can be discarded; durable state lives in WidgetService.
 */
export class WidgetRenderer {
  private readonly browser = new Chromium();
  private readonly surfaces = new Map<string, Surface>();
  private readonly popouts = new Map<string, Chromium>();

  /** Last sidebar layout, not a promise about a resized or unopened view. */
  dimensions(id: string) {
    const encoded = this.surfaces.get(id)?.viewport;
    if (!encoded) {
      return null;
    }
    const viewport = JSON.parse(encoded) as WidgetViewport;
    return {
      widthCssPixels: viewport.width,
      heightCssPixels: viewport.height,
      textScale: viewport.scale,
    };
  }

  private async use<T>(
    record: WidgetRecord,
    bundle: WidgetBundle,
    task: (page: BrowserPage, surface: Surface) => Promise<T>,
  ): Promise<T> {
    let surface = this.surfaces.get(record.id);
    if (!surface) {
      if (this.surfaces.size >= 8) {
        const oldest = [...this.surfaces.entries()]
          .filter(([, entry]) => entry.users === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) {
          throw Error('All widget renderers are busy; try again shortly');
        }
        this.surfaces.delete(oldest[0]);
        await oldest[1].page.then((page) => page.close()).catch(() => {});
      }
      const page = this.browser.page().then(async (page) => {
        try {
          await page.call('Emulation.setDeviceMetricsOverride', {
            width: 480,
            height: 280,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await page.document(await widgetDocument(bundle, record, defaultViewport));
          await page.evaluate(
            'window.widgetHost.command({kind:"describe",props:window.widgetBootstrap.props})',
          );
          return page;
        } catch (error) {
          await page.close();
          throw error;
        }
      });
      surface = {
        page,
        lastUsed: Date.now(),
        users: 0,
        revision: 0,
        viewport: '',
        queue: Promise.resolve(),
      };
      this.surfaces.set(record.id, surface);
    }
    if (surface.users >= 16) {
      throw Error('Widget renderer is busy');
    }
    surface.users++;
    surface.lastUsed = Date.now();
    const current = surface;
    const work = current.queue.catch(() => {}).then(async () => task(await current.page, current));
    current.queue = work;
    try {
      return await work;
    } catch (error) {
      // A timed-out action or crashed renderer must not poison future calls.
      if (this.surfaces.get(record.id) === surface) {
        this.surfaces.delete(record.id);
        void surface.page.then((page) => page.close()).catch(() => {});
      }
      throw error;
    } finally {
      surface.users--;
    }
  }

  async describe(record: WidgetRecord, bundle: WidgetBundle): Promise<string> {
    return this.use(record, bundle, async (page) => {
      const text = await page.evaluate(
        `window.widgetHost.command(${expressionValue({ kind: 'describe', props: record.props })})`,
      );
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
        throw Error('Widget must supply a text description of 1–4000 characters');
      }
      return text;
    });
  }

  async reduce(
    record: WidgetRecord,
    bundle: WidgetBundle,
    action: string,
    args: JsonObject,
    requestId: string,
  ): Promise<{ props: JsonObject; result: JsonObject }> {
    return this.use(record, bundle, async (page) => {
      const value = object(
        await page.evaluate(
          `window.widgetHost.command(${expressionValue({ kind: 'reduce', props: record.props, action, args, requestId })})`,
        ),
      );
      boundedJson(value);
      return { props: object(value.props), result: object(value.result ?? {}) };
    });
  }

  private async configure(
    page: BrowserPage,
    surface: Surface,
    record: WidgetRecord,
    viewport: WidgetViewport,
  ): Promise<void> {
    const configuration = JSON.stringify(viewport);
    if (surface.viewport !== configuration) {
      // Qt sizes and input coordinates stay in logical/CSS pixels. Capture at
      // the display's density to avoid enlarging a low-resolution bitmap, but
      // bound the backing buffer even for a large full-height pinned widget.
      const pixelRatio = Math.min(
        viewport.pixelRatio,
        // Reserve one pixel per axis for Chromium's integer-size rounding.
        Math.sqrt(8_000_000 / ((viewport.width + 1) * (viewport.height + 1))),
      );
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: pixelRatio,
        mobile: false,
      });
    }
    if (surface.revision !== record.revision || surface.viewport !== configuration) {
      await page.evaluate(
        `window.widgetHost.update(${expressionValue(record.props)},${expressionValue(viewport)},${record.revision})`,
      );
      surface.revision = record.revision;
      surface.viewport = configuration;
    }
  }

  async layout(
    record: WidgetRecord,
    bundle: WidgetBundle,
    viewport: WidgetViewport,
  ): Promise<number> {
    return this.use(record, bundle, async (page, surface) => {
      await this.configure(page, surface, record, viewport);
      const height = await page.evaluate('window.widgetHost.command({kind:"measure"})');
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) {
        throw Error('Invalid widget layout');
      }
      return Math.min(2200, height);
    });
  }

  async frame(
    record: WidgetRecord,
    bundle: WidgetBundle,
    viewport: WidgetViewport,
  ): Promise<Buffer> {
    return this.use(record, bundle, async (page, surface) => {
      await this.configure(page, surface, record, viewport);
      const shot = await page.call(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        3000,
      );
      if (typeof shot.data !== 'string' || shot.data.length > 8 * 1024 * 1024) {
        throw Error('Widget frame exceeds the image limit');
      }
      return Buffer.from(shot.data, 'base64');
    });
  }

  async requests(record: WidgetRecord, bundle: WidgetBundle): Promise<JsonObject[]> {
    return this.use(record, bundle, async (page) => {
      const requests = await page.evaluate('window.widgetHost.takeRequests()');
      if (!Array.isArray(requests) || requests.length > 8) {
        throw Error('Invalid widget action queue');
      }
      boundedJson(requests);
      return requests.map(object);
    });
  }

  async reply(
    record: WidgetRecord,
    bundle: WidgetBundle,
    id: string,
    result: unknown,
    error?: string,
  ): Promise<void> {
    await this.use(record, bundle, (page) =>
      page
        .evaluate(
          `window.widgetHost.reply(${expressionValue(id)},${expressionValue(result)},${expressionValue(error ?? '')})`,
        )
        .then(() => {}),
    );
  }

  async input(record: WidgetRecord, bundle: WidgetBundle, event: JsonObject): Promise<unknown> {
    return this.use(record, bundle, async (page) => {
      if (event.type === 'text') {
        if (typeof event.text !== 'string' || event.text.length > 4000) {
          throw Error('Invalid widget text input');
        }
        return page.call('Input.insertText', { text: event.text });
      }
      if (event.type === 'copy') {
        return page.evaluate('window.widgetHost.command({kind:"selection"})');
      }
      if (event.type === 'key') {
        if (
          !['keyDown', 'keyUp'].includes(String(event.phase)) ||
          ![
            'Enter',
            'Tab',
            'Backspace',
            'Delete',
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End',
            'Escape',
            'a',
          ].includes(String(event.key)) ||
          !Number.isInteger(event.modifiers) ||
          Number(event.modifiers) < 0 ||
          Number(event.modifiers) > 15
        ) {
          throw Error('Invalid widget key input');
        }
        const virtualKeys: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Backspace: 8,
          Delete: 46,
          ArrowLeft: 37,
          ArrowRight: 39,
          ArrowUp: 38,
          ArrowDown: 40,
          Home: 36,
          End: 35,
          Escape: 27,
          a: 65,
        };
        return page.call('Input.dispatchKeyEvent', {
          type: event.phase,
          key: event.key,
          windowsVirtualKeyCode: virtualKeys[String(event.key)],
          text: event.phase === 'keyDown' && event.key === 'Enter' ? '\r' : undefined,
          modifiers: event.modifiers,
        });
      }
      if (
        !['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(
          String(event.type),
        ) ||
        typeof event.x !== 'number' ||
        typeof event.y !== 'number' ||
        !Number.isFinite(event.x) ||
        !Number.isFinite(event.y) ||
        event.x < 0 ||
        event.x > 1600 ||
        event.y < 0 ||
        event.y > 2200 ||
        !['none', 'left', 'middle', 'right'].includes(String(event.button ?? 'none'))
      ) {
        throw Error('Invalid widget pointer input');
      }
      const args: JsonObject = {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? 'none',
        clickCount: event.type === 'mouseMoved' ? 0 : 1,
      };
      if (event.buttons !== undefined) {
        if (
          !Number.isInteger(event.buttons) ||
          Number(event.buttons) < 0 ||
          Number(event.buttons) > 7
        ) {
          throw Error('Invalid widget pointer buttons');
        }
        args.buttons = event.buttons;
      }
      if (event.type === 'mouseWheel') {
        if (
          typeof event.deltaY !== 'number' ||
          !Number.isFinite(event.deltaY) ||
          Math.abs(event.deltaY) > 2000
        ) {
          throw Error('Invalid widget wheel input');
        }
        args.deltaX = 0;
        args.deltaY = event.deltaY;
      }
      return page.call('Input.dispatchMouseEvent', args);
    });
  }

  async popout(id: string, url: string, validate: () => void = () => {}): Promise<void> {
    // Reuse one external window per widget. Both views address the same saved
    // state through the trusted viewer host; no user browsing profile is used.
    await this.popouts.get(id)?.close();
    validate();
    const browser = new Chromium(true);
    this.popouts.set(id, browser);
    try {
      const page = await browser.page(
        (candidate) => candidate === url || candidate.startsWith(url + '/'),
      );
      // The service owns this whole operation until shutdown drains it. Check
      // again after startup so revocation cannot navigate a newly ready page.
      validate();
      await page.call('Page.navigate', { url });
    } catch (error) {
      if (this.popouts.get(id) === browser) {
        this.popouts.delete(id);
      }
      await browser.close();
      throw error;
    }
  }

  async discard(ids: string[]): Promise<void> {
    for (const id of ids) {
      const surface = this.surfaces.get(id);
      this.surfaces.delete(id);
      if (surface) {
        await surface.queue.catch(() => {});
        await surface.page.then((page) => page.close()).catch(() => {});
      }
      const popout = this.popouts.get(id);
      this.popouts.delete(id);
      await popout?.close();
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      this.browser.close(),
      ...[...this.popouts.values()].map((browser) => browser.close()),
    ]);
    this.surfaces.clear();
    this.popouts.clear();
  }
}
