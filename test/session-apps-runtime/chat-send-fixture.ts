import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AgentHarness } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import { applicationFixture } from './fixture.ts';

/** Test gates must not strand fixture cleanup if an earlier assertion fails. */
export async function waitForRelease(gate: { promise: Promise<void> }, signal: AbortSignal) {
  if (signal.aborted) return;
  let release!: () => void;
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
  });
  signal.addEventListener('abort', release, { once: true });
  try {
    await Promise.race([gate.promise, aborted]);
  } finally {
    signal.removeEventListener('abort', release);
  }
}

export async function sendFixture(context: TestContext, harness: AgentHarness = 'pi') {
  const fixture = await applicationFixture(context);
  // Only the test's freshly copied library changes; no installed bundle is edited.
  const file = join(fixture.library, 'task-list', 'widget.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.application = { ...manifest.application, capabilities: ['chat.read', 'chat.send'] };
  await writeFile(file, JSON.stringify(manifest));
  const { sessions } = fixture;
  const id = sessions.start(frame, signal(), 'coding', harness);
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'task-list',
      expectedVersion: 0,
      eventMode: 'next-input',
      initialState: { title: 'Synthetic', tasks: [] },
    });
  });
  await sessions.idle();
  const application = () => fixture.view(id).application!;
  function permission(allowed: boolean) {
    const app = application();
    return {
      applicationId: app.id,
      version: app.version,
      revision: app.chatAccess!.revision,
      allowed,
    };
  }
  const command = (text = 'Synthetic app message', requestId = randomUUID()) => ({
    version: application().version,
    grantId: application().chatAccess!.send!.grantId,
    requestId,
    text,
  });
  const post = (operation: string, body: unknown, url = application().viewUrl!) =>
    fetch(url + '/' + operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    ...fixture,
    id,
    application,
    permission,
    command,
    post,
    grant: (allowed = true) => sessions.setApplicationChatSend(id, permission(allowed)),
  };
}
