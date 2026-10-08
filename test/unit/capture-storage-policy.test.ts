import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CaptureStoragePolicy, notAdmitted } from '../../src/capture-storage/policy.ts';
import { CaptureStoragePreference } from '../../src/capture-storage/preference.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import { deferred, screenshot } from '../helpers.ts';

// Capture-storage preference and policy (docs/capture-storage.md), acceptance
// cases P1–P4, T1 and T2 at the policy boundary. Every test uses a temporary
// directory and a synthetic clock; no personal configuration is read.

async function temporary(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-capture-storage-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A controllable monotonic clock for straddling checks. */
function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

/** A preference whose saves can be paused or made to fail. */
class ScriptedPreference extends CaptureStoragePreference {
  saves: boolean[] = [];
  failNext = false;
  hold?: Promise<void>;

  constructor() {
    super('/nonexistent/capture-storage.json');
  }

  override async load() {
    return { status: 'missing' as const };
  }

  override async save(enabled: boolean): Promise<void> {
    await this.hold;
    if (this.failNext) {
      this.failNext = false;
      throw Error('Synthetic disk failure');
    }
    this.saves.push(enabled);
  }
}

test('P1: a missing preference is off on fresh and upgraded installations, and nothing is written', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'capture-storage.json');

  // An upgraded installation: earlier recordings exist, but no preference.
  const old = join(directory, 'data', '2026-01-01', 'audio');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'legacy.wav'), 'legacy-canary');

  const policy = new CaptureStoragePolicy(new CaptureStoragePreference(path));
  assert.equal(policy.enabled, false, 'Off before loading');
  assert.equal(policy.admit().eligible, false);
  await policy.load();

  assert.deepEqual(policy.state, { enabled: false, pending: '', saved: true, warning: '' });
  assert.equal(policy.admit().eligible, false);
  assert.deepEqual((await readdir(directory)).sort(), ['data']);
  assert.equal(await readFile(join(old, 'legacy.wav'), 'utf8'), 'legacy-canary');
});

test('P2: saved choices survive a restart; invalid files fail closed with a warning and are not rewritten', async (context) => {
  const directory = await temporary(context);
  const path = join(directory, 'capture-storage.json');

  for (const enabled of [true, false]) {
    const writer = new CaptureStoragePolicy(new CaptureStoragePreference(path));
    await writer.load();
    await writer.setEnabled(enabled);
    const restarted = new CaptureStoragePolicy(new CaptureStoragePreference(path));
    await restarted.load();
    assert.equal(restarted.enabled, enabled);
    assert.equal(restarted.state.saved, true);
  }

  const invalid = [
    '{"version":1,"enabled":tru',
    '{"version":2,"enabled":true}',
    '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":true,"extra":1}',
    '[true]',
    'null',
    '',
  ];
  for (const content of invalid) {
    await writeFile(path, content);
    const policy = new CaptureStoragePolicy(new CaptureStoragePreference(path));
    await policy.load();
    assert.equal(policy.enabled, false, content);
    assert.equal(policy.state.saved, false);
    assert.match(policy.state.warning, /could not be read/);
    assert.doesNotMatch(policy.state.warning, /version|enabled|true/, 'No file content echoed');
    assert.equal(await readFile(path, 'utf8'), content, 'No automatic repair');
  }

  // Unreadable: a directory in its place (works even when running as root).
  await rm(path);
  await mkdir(path);
  const unreadable = new CaptureStoragePolicy(new CaptureStoragePreference(path));
  await unreadable.load();
  assert.equal(unreadable.enabled, false);
  assert.equal(unreadable.state.saved, false);

  // A later explicit choice may save again once the path is usable.
  await rm(path, { recursive: true });
  await unreadable.setEnabled(true);
  assert.deepEqual(unreadable.state, { enabled: true, pending: '', saved: true, warning: '' });
});

test('P3: writes are private, atomic and serialized in request order', async (context) => {
  const directory = await temporary(context);
  const parent = join(directory, 'companion');
  const path = join(parent, 'capture-storage.json');
  const policy = new CaptureStoragePolicy(new CaptureStoragePreference(path));
  await policy.load();

  // Several clients click at once; the backend applies them in arrival order.
  const results = await Promise.allSettled([
    policy.setEnabled(true),
    policy.setEnabled(false),
    policy.setEnabled(true),
    policy.setEnabled(false),
    policy.setEnabled(true),
  ]);
  // The first enable is overtaken by the Off that arrived while it was saving.
  assert.equal(results[0].status, 'rejected');
  assert.equal(results.at(-1)!.status, 'fulfilled');
  assert.equal(policy.enabled, true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).enabled, true);

  assert.deepEqual(await readdir(parent), ['capture-storage.json'], 'No temporary file remains');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal(await readFile(path, 'utf8'), '{"version":1,"enabled":true}\n');
});

test('P4: a failed enable stays off; a failed disable stays off for this run and says it is not saved', async () => {
  const preference = new ScriptedPreference();
  const policy = new CaptureStoragePolicy(preference);
  await policy.load();

  preference.failNext = true;
  await assert.rejects(policy.setEnabled(true), /could not be saved, so it stays off/);
  assert.deepEqual(policy.state, { enabled: false, pending: '', saved: true, warning: '' });
  assert.equal(policy.admit().eligible, false);

  await policy.setEnabled(true);
  const admitted = policy.admit();
  assert.equal(policy.allows(admitted), true);

  preference.failNext = true;
  await assert.rejects(policy.setEnabled(false), /off, but the choice could not be saved/);
  assert.equal(policy.enabled, false, 'Effectively off despite the failed save');
  assert.equal(policy.allows(admitted), false);
  assert.equal(policy.state.saved, false);
  assert.match(policy.state.warning, /could not be saved.*restart/);

  // Nothing silently retries or turns storage back on.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(policy.enabled, false);
  assert.deepEqual(preference.saves, [true]);

  // A fresh explicit Off may save successfully and clears the warning.
  await policy.setEnabled(false);
  assert.deepEqual(policy.state, { enabled: false, pending: '', saved: true, warning: '' });
});

test('P3/P4: overlapping and repeated durable On requests succeed without another fallible save', async () => {
  const saving = deferred<void>();
  const started = deferred<void>();
  class FailSecondSave extends ScriptedPreference {
    calls = 0;
    override async save(enabled: boolean): Promise<void> {
      this.calls++;
      if (this.calls > 1) {
        throw Error('Synthetic redundant save failure');
      }
      started.resolve();
      await saving.promise;
      await super.save(enabled);
    }
  }
  const time = clock();
  const preference = new FailSecondSave();
  const policy = new CaptureStoragePolicy(preference, time.now);
  const first = policy.setEnabled(true);
  const second = policy.setEnabled(true);
  await started.promise;
  assert.equal(policy.admit().eligible, false, 'No admission before the first durable save');
  saving.resolve();
  await Promise.all([first, second]);

  const admission = policy.admit();
  const generation = policy.generation;
  time.advance(200);
  await policy.setEnabled(true);
  assert.equal(preference.calls, 1, 'Satisfied requests do not risk a redundant write');
  assert.deepEqual(policy.state, { enabled: true, pending: '', saved: true, warning: '' });
  assert.equal(policy.generation, generation, 'Repeated On does not revoke admitted work');
  assert.equal(policy.admit(1000).eligible, true, 'Repeated On preserves the acquisition bound');
  assert.equal(await policy.publish(admission, async (current) => current()), true);
});

test('P3/P4: a saved On loaded at startup is also an idempotent request', async () => {
  class SavedOn extends CaptureStoragePreference {
    calls = 0;
    override async load() {
      return { status: 'saved' as const, enabled: true };
    }
    override async save(): Promise<void> {
      this.calls++;
      throw Error('Synthetic redundant save failure');
    }
  }
  const preference = new SavedOn('/nonexistent/capture-storage.json');
  const policy = new CaptureStoragePolicy(preference);
  await policy.load();
  const admission = policy.admit(Number.NEGATIVE_INFINITY);
  await policy.setEnabled(true);
  assert.equal(preference.calls, 0, 'No new persistence attempted');
  assert.equal(policy.allows(admission), true);
  assert.deepEqual(policy.state, { enabled: true, pending: '', saved: true, warning: '' });
});

test('P4: an overlapping On retries after an actual failed enable instead of treating Off as satisfied', async () => {
  const preference = new ScriptedPreference();
  preference.failNext = true;
  const policy = new CaptureStoragePolicy(preference);
  const results = await Promise.allSettled([policy.setEnabled(true), policy.setEnabled(true)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(preference.saves, [true]);
  assert.deepEqual(policy.state, { enabled: true, pending: '', saved: true, warning: '' });
  assert.equal(policy.admit().eligible, true);
});

test('P3/T2: Off overtakes both overlapping enables while the first save is held', async () => {
  const saving = deferred<void>();
  const started = deferred<void>();
  class HeldPreference extends ScriptedPreference {
    override async save(enabled: boolean): Promise<void> {
      if (enabled) {
        started.resolve();
        await saving.promise;
      }
      await super.save(enabled);
    }
  }
  const preference = new HeldPreference();
  const policy = new CaptureStoragePolicy(preference);
  const results = Promise.allSettled([policy.setEnabled(true), policy.setEnabled(true)]);
  await started.promise;
  const off = policy.setEnabled(false);
  assert.equal(policy.admit().eligible, false);
  saving.resolve();
  assert.deepEqual(
    (await results).map((result) => result.status),
    ['rejected', 'rejected'],
  );
  await off;
  assert.deepEqual(preference.saves, [true, false]);
  assert.deepEqual(policy.state, { enabled: false, pending: '', saved: true, warning: '' });
});

test('P3/P4/T1: a duplicate On cannot bypass Off publication draining or a failed Off save', async () => {
  const preference = new ScriptedPreference();
  const policy = new CaptureStoragePolicy(preference);
  await policy.setEnabled(true);
  const admission = policy.admit();
  const renaming = deferred<void>();
  const published = policy.publish(admission, async (current) => {
    assert.equal(current(), true);
    await renaming.promise;
    return 'already renamed';
  });
  const duplicate = policy.setEnabled(true);
  preference.failNext = true;
  const off = policy.setEnabled(false);
  const laterOn = policy.setEnabled(true);
  await assert.rejects(duplicate, /turned off again/);
  assert.equal(policy.enabled, false, 'Later On waits for the Off barrier');
  assert.equal(policy.allows(admission), false);
  assert.equal(policy.state.pending, 'disabling');
  assert.deepEqual(preference.saves, [true], 'Off has not saved ahead of the publication');
  renaming.resolve();
  assert.equal(await published, 'already renamed');
  await assert.rejects(off, /off, but the choice could not be saved/);
  await laterOn;
  assert.deepEqual(preference.saves, [true, true], 'Explicit later On repairs the failed Off save');
  assert.deepEqual(policy.state, { enabled: true, pending: '', saved: true, warning: '' });
  assert.equal(policy.allows(admission), false, 'Later On does not revive old work');
});

test('T1: Off closes admission at once and is acknowledged only after in-flight publications settle', async () => {
  const policy = CaptureStoragePolicy.enabledForTesting();
  const admission = policy.admit();

  // A writer that already passed its final check (rename in progress).
  const renaming = deferred<void>();
  const published = policy.publish(admission, async (current) => {
    assert.equal(current(), true);
    await renaming.promise;
    return 'renamed';
  });

  // A writer still writing its temporary file when Off arrives.
  const writing = deferred<void>();
  let lateCheck: boolean | undefined;
  const discarded = policy.publish(admission, async (current) => {
    await writing.promise;
    lateCheck = current();
    return lateCheck ? 'renamed' : undefined;
  });

  let acknowledged = false;
  const off = policy.setEnabled(false).then(() => {
    acknowledged = true;
  });

  assert.equal(policy.enabled, false, 'Admission closed synchronously');
  assert.equal(policy.state.pending, 'disabling');
  assert.equal(await policy.publish(admission, async () => 'never called'), undefined);

  writing.resolve();
  assert.equal(await discarded, undefined);
  assert.equal(lateCheck, false, 'The final check after Off refuses publication');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(acknowledged, false, 'The Off waits for the rename already in progress');

  renaming.resolve();
  assert.equal(await published, 'renamed');
  await off;
  assert.equal(acknowledged, true);
  assert.equal(policy.state.pending, '');

  // Errors are not "off": they propagate to the caller unchanged.
  await policy.setEnabled(true);
  await assert.rejects(
    policy.publish(policy.admit(), async () => {
      throw Error('Synthetic I/O failure');
    }),
    /Synthetic I\/O failure/,
  );
});

test('T2: off→on never revives earlier admissions, straddling captures or an overtaken enable', async () => {
  const time = clock();
  const preference = new ScriptedPreference();
  const policy = new CaptureStoragePolicy(preference, time.now);
  await policy.load();

  const whileOff = policy.admit();
  await policy.setEnabled(true);
  assert.equal(policy.allows(whileOff), false, 'Off-started work stays unsaved');

  // Speech whose first sample may date from before the opt-in straddles it.
  const enabledAt = time.now();
  time.advance(200);
  assert.equal(policy.admit(enabledAt - 300).eligible, false);
  assert.equal(policy.admit(enabledAt).eligible, true);
  assert.equal(policy.admit(enabledAt + 100).eligible, true);
  assert.equal(policy.admit().eligible, true, 'Default: starting now');

  const beforeToggle = policy.admit();
  await policy.setEnabled(false);
  await policy.setEnabled(true);
  assert.equal(policy.allows(beforeToggle), false, 'A quick off→on revokes old tokens');
  assert.equal(policy.allows(policy.admit()), true);
  assert.equal(policy.allows(undefined), false);
  assert.equal(policy.allows(notAdmitted), false);

  // An Off that arrives while an enable is still saving wins.
  await policy.setEnabled(false);
  const saving = deferred<void>();
  preference.hold = saving.promise;
  const enable = policy.setEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(policy.state.pending, 'enabling');
  const off = policy.setEnabled(false);
  saving.resolve();
  await assert.rejects(enable, /turned off again/);
  await off;
  assert.equal(policy.enabled, false);
  assert.deepEqual(preference.saves.slice(-2), [true, false], 'The final saved choice is off');
});

test('W2: a refused conversation screenshot never replaces an existing PNG or borrows it', async (context) => {
  const directory = await temporary(context);
  const store = new SessionStore(directory);
  const id = '11111111-2222-4333-8444-555555555555';
  const old = Buffer.from('old-saved-screenshot-canary');
  await writeFile(join(directory, `${id}.png`), old);

  assert.equal(await store.screenshot(id, screenshot.png, () => false), undefined);
  assert.deepEqual(await readFile(join(directory, `${id}.png`)), old);
  assert.deepEqual((await readdir(directory)).sort(), [`${id}.png`], 'No temporary file');

  await store.save({
    id,
    title: 'Synthetic',
    status: 'completed',
    model: '',
    error: '',
    updatedAt: 1,
    messages: [
      {
        id: 'first',
        kind: 'user',
        text: 'Saved earlier',
        toolName: '',
        input: '',
        state: 'done',
        screenshot: true,
      },
      {
        id: 'second',
        kind: 'user',
        text: 'Not saved',
        toolName: '',
        input: '',
        state: 'done',
        screenshot: true,
        screenshotSaved: false,
      },
    ],
  });
  const restored = await store.read(id);
  assert.ok(restored.messages[0].screenshotUrl, 'The saved capture keeps its image');
  assert.equal(restored.messages[1].screenshotUrl, undefined, 'No stale image for an unsaved one');
  assert.equal(restored.messages[1].screenshotSaved, false);
});

test('preference parent permissions are tightened without touching ancestors', async (context) => {
  const directory = await temporary(context);
  const parent = join(directory, 'companion');
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  await new CaptureStoragePreference(join(parent, 'capture-storage.json')).save(false);
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).mode & 0o777, 0o700, 'mkdtemp parent unchanged');
});
