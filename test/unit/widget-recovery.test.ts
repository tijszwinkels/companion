import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { chatMessage, type AgentBackend, type AgentSession } from '../../src/agents/types.ts';
import { WidgetRenderer } from '../../src/widgets/renderer.ts';
import { WidgetService } from '../../src/widgets/service.ts';
import type { WidgetRecord } from '../../src/widgets/types.ts';

// Exercise real durable widget state and reopening without starting Chromium.
class SummaryRenderer extends WidgetRenderer {
  override async describe(record: WidgetRecord): Promise<string> {
    return String(record.props.title);
  }
}

for (const count of [200, 4000, 4200]) {
  test(`canonical widget recovery is independent of the display window with ${count} saved bubbles`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-widget-recovery-'));
    const widgetsDirectory = join(directory, '.companion-widgets');
    const store = new SessionStore(join(directory, '.companion-sessions'));
    const backend: AgentBackend = {
      id: 'recovery-fixture',
      label: 'Recovery fixture',
      dependencies: {},
      async run() {
        assert.fail('Reopening history must not invoke the model');
      },
    };
    const sessions = new AgentSessions({ pi: backend }, () => {}, directory);
    const saved: AgentSession = {
      id: randomUUID(),
      title: 'Synthetic recovery',
      status: 'completed',
      model: 'fixture',
      error: '',
      updatedAt: 1,
      messages: Array.from({ length: count }, (_, index) =>
        chatMessage(`message-${index}`, index === 0 ? 'user' : 'assistant', 'Saved text'),
      ),
    };

    try {
      await store.save(saved);
      const widgets = new WidgetService(
        widgetsDirectory,
        async () => {},
        undefined,
        new SummaryRenderer(),
      );
      let widgetId: string;
      try {
        // The widget commit survives, while the earlier display snapshot has
        // no corresponding bubble: simulate that interruption using only temp data.
        const lease = await widgets.lease(saved.id, new AbortController().signal);
        const response = await fetch(lease.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lease.token}` },
          body: JSON.stringify({
            method: 'publish',
            widget: 'todo',
            requestId: 'recovery',
            props: { title: 'Recovered widget', items: [] },
            presentation: { placement: 'pinned', heightPercent: 25 },
          }),
        });
        assert.equal(response.status, 200);
        widgetId = ((await response.json()) as { id: string }).id;
        if (count === 4200) {
          const [{ reference }] = await widgets.restored(saved.id);
          saved.messages.unshift({
            ...chatMessage('widget:' + widgetId, 'assistant', 'Stale summary'),
            widget: reference,
          });
          await store.save(saved);
        }
      } finally {
        await widgets.close();
      }

      await sessions.loadPrevious();
      await sessions.reopen(saved.id);
      for (let pass = 0; pass < 2; pass++) {
        const view = sessions.snapshot()[0];
        assert.equal(view.messages.length, 200);
        assert.equal(view.history!.total, count + 1);
        assert.equal(view.pinnedMessage!.widget!.id, widgetId, 'Canonical pin survives eviction');
        const visuals = view.messages.filter((message) => message.widget);
        if (count === 4200) {
          assert.equal(visuals.length, 0);
          const older = sessions.historyPage({
            id: saved.id,
            epoch: view.toolEpoch!,
            direction: 'after',
            index: 0,
            offset: 0,
          });
          assert.equal(
            older.messages[0].text,
            'Recovered widget',
            'Old pages use canonical widget state',
          );
          assert.equal(older.messages[0].widget!.id, widgetId);
        } else {
          assert.deepEqual(view.messages.slice(0, -1), saved.messages.slice(-199));
          assert.equal(visuals.length, 1);
          assert.equal(visuals[0].widget!.id, widgetId);
          assert.equal(visuals[0].text, 'Recovered widget');
        }
        if (pass === 0) {
          await sessions.remove(saved.id);
          await sessions.reopen(saved.id);
        }
      }
      // A full display does not delete the independently committed widget.
      const canonical = await readFile(join(widgetsDirectory, `${saved.id}.json`), 'utf8');
      assert.ok(canonical.includes(widgetId));
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
