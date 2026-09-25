import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Chromium } from '../../src/widgets/chromium.ts';
import type { WidgetRenderer } from '../../src/widgets/renderer.ts';

/** Read geometry from the actual isolated widget iframe. Input still travels
 * through CDP mouse events or Qt -> WidgetSurface -> the real input transport. */
export async function control(browser: Chromium, selector: string) {
  const targets = (await browser.call('Target.getTargets')).targetInfos as {
    type: string;
    targetId: string;
  }[];
  const frames = targets.filter((target) => target.type === 'iframe');
  assert.equal(frames.length, 1, 'This fixture must own exactly one widget iframe');
  const session = String(
    (await browser.call('Target.attachToTarget', { targetId: frames[0].targetId, flatten: true }))
      .sessionId,
  );
  try {
    const reply = await browser.call(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw Error('Missing control');
          const box = element.getBoundingClientRect();
          return {x:box.x+box.width/2, y:box.y+box.height/2,
            visible:box.width>0 && box.height>0, value:element.value ?? '',
            focused:element === document.activeElement};
        })()`,
        returnByValue: true,
      },
      session,
    );
    assert.equal(reply.exceptionDetails, undefined);
    return (reply.result as any).value as {
      x: number;
      y: number;
      visible: boolean;
      value: string;
      focused: boolean;
    };
  } finally {
    await browser.call('Target.detachFromTarget', { sessionId: session });
  }
}

// Test-only inspection of the capture browser avoids a production DOM/debug API.
export function captureBrowser(renderer: WidgetRenderer): Chromium {
  return (renderer as unknown as { browser: Chromium }).browser;
}

/** The portable QML fixture cannot inspect Chromium itself. This disposable
 * loopback endpoint supplies read-only geometry from that same capture page. */
export async function controlProbe(renderer: WidgetRenderer) {
  const server = createServer((request, response) => {
    const selector = new URL(request.url!, 'http://localhost').searchParams.get('selector');
    void control(captureBrowser(renderer), selector ?? 'input[type=checkbox]')
      .then((value) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(value));
      })
      .catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
