import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readCodingDefaults, saveCodingDefaults } from '../../src/agents/coding-defaults.ts';
import {
  defaultAgentSettings,
  defaultClaudeCodeSettings,
  loadAgentConfiguration,
} from '../../src/agents/settings.ts';
import type { AgentSettings, ClaudeCodeSettings } from '../../src/agents/types.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { frame, signal } from '../helpers.ts';
import { callTool, harnessFixture } from '../harness-fixture.ts';

async function directoryFixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-coding-defaults-'));
  context.after(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path: join(directory, 'companion-agent.json') };
}

/** A hand-written file with every section, an unusual key order and mode. */
const handWritten = {
  thinking: 'low',
  executable: '/opt/custom-pi',
  model: 'configured/one',
  quickQuestion: { model: 'local/qwen', thinking: 'off' },
  claudeCode: { effort: 'max', executable: '/opt/claude' },
  codingDefaultHarness: 'pi',
};

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.tmp'));
}

test('reading defaults never creates the file and reports the built-in defaults', async (context) => {
  const { directory, path } = await directoryFixture(context);

  const defaults = await readCodingDefaults(directory);
  assert.deepEqual(defaults, {
    harness: 'pi',
    piModel: defaultAgentSettings.model,
    claudeModel: defaultClaudeCodeSettings.model,
    revision: 'missing',
  });
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a change rewrites only its own keys and keeps the file mode', async (context) => {
  const { directory, path } = await directoryFixture(context);
  await writeFile(path, JSON.stringify(handWritten));
  await chmod(path, 0o640);

  const before = await readCodingDefaults(directory);
  assert.equal(before.piModel, 'configured/one', 'Without the key, Pi follows the coding model');
  assert.equal(before.claudeModel, defaultClaudeCodeSettings.model);

  const switched = await saveCodingDefaults(directory, {
    harness: 'claude-code',
    model: 'claude-sonnet-5',
    revision: before.revision,
  });
  assert.equal(switched.harness, 'claude-code');
  assert.equal(switched.claudeModel, 'claude-sonnet-5');
  assert.notEqual(switched.revision, before.revision);
  assert.deepEqual(switched, await readCodingDefaults(directory));

  const pinned = await saveCodingDefaults(directory, {
    harness: 'pi',
    model: 'configured/two',
    revision: switched.revision,
  });
  assert.equal(pinned.piModel, 'configured/two');

  // Every unrelated key is unchanged, in its original order; the Pi coding
  // model followed by older conversations is not touched.
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved, {
    ...handWritten,
    claudeCode: { effort: 'max', executable: '/opt/claude', model: 'claude-sonnet-5' },
    codingDefaultHarness: 'pi',
    codingDefaultPiModel: 'configured/two',
  });
  assert.deepEqual(Object.keys(saved), [...Object.keys(handWritten), 'codingDefaultPiModel']);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.deepEqual(await temporaryFiles(directory), []);

  // The loader accepts the result and applies it to new conversations only.
  const configuration = await loadAgentConfiguration(directory, false);
  assert.equal(configuration.coding.model, 'configured/one');
  assert.equal(configuration.codingDefaultPiModel, 'configured/two');
  assert.deepEqual(configuration.claudeCode, {
    executable: '/opt/claude',
    model: 'claude-sonnet-5',
    effort: 'max',
  });

  // Changing only the harness keeps both default models.
  const harnessOnly = await saveCodingDefaults(directory, {
    harness: 'claude-code',
    revision: pinned.revision,
  });
  assert.deepEqual(
    { piModel: harnessOnly.piModel, claudeModel: harnessOnly.claudeModel },
    { piModel: 'configured/two', claudeModel: 'claude-sonnet-5' },
  );
});

test('a missing file is created privately with the defaults and the change', async (context) => {
  const { directory, path } = await directoryFixture(context);

  const saved = await saveCodingDefaults(directory, {
    harness: 'claude-code',
    revision: 'missing',
  });
  assert.equal(saved.harness, 'claude-code');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const configuration = await loadAgentConfiguration(directory, false);
  assert.equal(configuration.codingDefaultHarness, 'claude-code');
  assert.deepEqual(configuration.coding, defaultAgentSettings);
  assert.equal(configuration.codingDefaultPiModel, undefined);
  assert.deepEqual(await temporaryFiles(directory), []);

  // A second writer using the stale "missing" revision cannot replace it.
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'pi', revision: 'missing' }),
    /changed outside this panel/,
  );
});

test('a hand edit after the panel read the defaults is never overwritten', async (context) => {
  const { directory, path } = await directoryFixture(context);
  await writeFile(path, JSON.stringify(handWritten));
  const shown = await readCodingDefaults(directory);

  const edited = JSON.stringify({ ...handWritten, thinking: 'high' });
  await writeFile(path, edited);
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'claude-code', revision: shown.revision }),
    /changed outside this panel/,
  );
  assert.equal(await readFile(path, 'utf8'), edited);
  assert.deepEqual(await temporaryFiles(directory), []);
});

test('invalid files and values are refused without touching the file', async (context) => {
  const { directory, path } = await directoryFixture(context);

  const broken = JSON.stringify({ ...handWritten, thinking: 'typo' });
  await writeFile(path, broken);
  await assert.rejects(readCodingDefaults(directory), /unsupported thinking level/);
  const brokenRevision = createHash('sha256').update(broken).digest('hex');
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'pi', revision: `sha256:${brokenRevision}` }),
    /unsupported thinking level/,
  );
  assert.equal(await readFile(path, 'utf8'), broken);

  const valid = JSON.stringify(handWritten);
  await writeFile(path, valid);
  const { revision } = await readCodingDefaults(directory);
  for (const [harness, model, error] of [
    ['pi', 'no-provider', /include its provider/],
    ['pi', 'provider/with space', /without spaces/],
    ['pi', `provider/${'x'.repeat(300)}`, /at most 300/],
    ['claude-code', 'openai/not-claude', /Claude model ID/],
    ['claude-code', '-flag', /Claude model ID/],
  ] as const) {
    await assert.rejects(saveCodingDefaults(directory, { harness, model, revision }), error);
  }
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'codex' as 'pi', revision }),
    /codingDefaultHarness/,
  );
  assert.equal(await readFile(path, 'utf8'), valid);

  // Hand-written values get the same checks as panel choices.
  await writeFile(path, JSON.stringify({ ...handWritten, codingDefaultPiModel: 'no-provider' }));
  await assert.rejects(loadAgentConfiguration(directory), /codingDefaultPiModel/);
});

test('write failures are reported and leave the file and directory unchanged', async (context) => {
  const { directory, path } = await directoryFixture(context);
  const valid = JSON.stringify(handWritten);
  await writeFile(path, valid);
  const { revision } = await readCodingDefaults(directory);

  await chmod(directory, 0o500);
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'claude-code', revision }),
    /EACCES/,
  );
  await chmod(directory, 0o700);
  assert.equal(await readFile(path, 'utf8'), valid);
  assert.deepEqual(await temporaryFiles(directory), []);

  // A symbolic link would be replaced by a plain file; refuse instead.
  const target = join(directory, 'real-agent.json');
  await writeFile(target, valid);
  await rm(path);
  await symlink(target, path);
  await assert.rejects(
    saveCodingDefaults(directory, { harness: 'claude-code', revision }),
    /not a regular file/,
  );
  assert.equal(await readFile(target, 'utf8'), valid);
  assert.deepEqual(await temporaryFiles(directory), []);
});

test('the listener validates default models against the pickers and refuses stale views', async (context) => {
  const { sessions, configurationPath, directory } = await harnessFixture(context, {
    configuration: { ...defaultAgentSettings, claudeCode: { effort: 'max' } },
  });
  const original = await readFile(configurationPath, 'utf8');
  const shown = await sessions.codingDefaults();

  // Only Pi's discovered catalogue and the Claude allowlist are accepted.
  await assert.rejects(
    sessions.setCodingDefaults(
      { harness: 'pi', model: 'unlisted/model', revision: shown.revision },
      signal(),
    ),
    /unlisted\/model is not an available Pi model/,
  );
  await assert.rejects(
    sessions.setCodingDefaults(
      { harness: 'claude-code', model: 'claude-imaginary', revision: shown.revision },
      signal(),
    ),
    /not an available Claude model/,
  );
  assert.equal(await readFile(configurationPath, 'utf8'), original);

  // Two changes made from the same view cannot both apply.
  const first = sessions.setCodingDefaults(
    { harness: 'pi', model: 'configured/two', revision: shown.revision },
    signal(),
  );
  await assert.rejects(
    sessions.setCodingDefaults({ harness: 'claude-code', revision: shown.revision }, signal()),
    /already being saved/,
  );
  const saved = await first;
  assert.equal(saved.piModel, 'configured/two');
  await assert.rejects(
    sessions.setCodingDefaults({ harness: 'claude-code', revision: shown.revision }, signal()),
    /changed outside this panel/,
  );

  const claude = await sessions.setCodingDefaults(
    { harness: 'claude-code', model: 'claude-sonnet-5', revision: saved.revision },
    signal(),
  );
  assert.deepEqual(
    { harness: claude.harness, piModel: claude.piModel, claudeModel: claude.claudeModel },
    { harness: 'claude-code', piModel: 'configured/two', claudeModel: 'claude-sonnet-5' },
  );
  const configuration = await loadAgentConfiguration(directory, false);
  assert.equal(configuration.claudeCode.effort, 'max', 'Claude effort is not a panel setting');
});

test('changed defaults apply to new coding conversations only', async (context) => {
  const { sessions, runs, view, open, script, directory } = await harnessFixture(context);

  // Created before any panel change: follows the configured Pi coding model.
  const legacy = sessions.start(frame, signal());
  // A Claude Code conversation captures its own model when it starts.
  const claudeBefore = sessions.start(frame, signal(), 'coding', 'claude-code');
  await sessions.idle();
  assert.equal(view(legacy).modelOverride, undefined, 'No pin without the setting');

  const shown = await sessions.codingDefaults();
  const piChanged = await sessions.setCodingDefaults(
    { harness: 'pi', model: 'configured/two', revision: shown.revision },
    signal(),
  );

  const pinned = sessions.start(frame, signal());
  const explicitPi = sessions.start(frame, signal(), 'coding', 'pi');
  const quick = sessions.start(frame, signal(), 'quickQuestion');
  await sessions.idle();
  assert.equal(view(pinned).modelOverride, 'configured/two');
  assert.equal(view(explicitPi).modelOverride, 'configured/two');
  const firstTurn = runs.find((run) => run.id === pinned);
  assert.equal((firstTurn?.settings as AgentSettings).model, 'configured/two');
  assert.equal(view(quick).modelOverride, undefined, 'Quick questions keep their own profile');

  // Switch the backend and both models; nothing existing moves.
  const claudeChanged = await sessions.setCodingDefaults(
    { harness: 'claude-code', model: 'claude-sonnet-5', revision: piChanged.revision },
    signal(),
  );
  const piAgain = await sessions.setCodingDefaults(
    { harness: 'pi', model: 'configured/one', revision: claudeChanged.revision },
    signal(),
  );
  await sessions.setCodingDefaults(
    { harness: 'claude-code', revision: piAgain.revision },
    signal(),
  );

  const newest = sessions.start(frame, signal());
  await sessions.idle();
  assert.equal(view(newest).harness, 'claude-code');
  assert.deepEqual(view(newest).claudeCode, {
    model: 'claude-sonnet-5',
    effort: defaultClaudeCodeSettings.effort,
  });

  const turns = runs.length;
  for (const id of [legacy, pinned, explicitPi, claudeBefore]) {
    sessions.followUp(id, 'Later turn', signal());
  }
  await sessions.idle();
  const later = new Map(runs.slice(turns).map((run) => [run.id, run]));
  assert.equal(later.get(legacy)?.harness, 'pi');
  assert.equal((later.get(legacy)?.settings as AgentSettings).model, defaultAgentSettings.model);
  assert.equal(later.get(pinned)?.harness, 'pi');
  assert.equal((later.get(pinned)?.settings as AgentSettings).model, 'configured/two');
  assert.equal((later.get(explicitPi)?.settings as AgentSettings).model, 'configured/two');
  assert.equal(later.get(claudeBefore)?.harness, 'claude-code');
  assert.equal(
    (later.get(claudeBefore)?.settings as ClaudeCodeSettings).model,
    defaultClaudeCodeSettings.model,
  );

  // An agent's explicit model choice is kept rather than replaced by the default.
  let explicitModel = '';
  script(newest, async (run) => {
    const started = await callTool(run, 'companion_session_start', {
      text: 'Use the other model',
      harness: 'pi',
      model: 'configured/two',
    });
    explicitModel = (started.session as { id: string }).id;
  });
  sessions.followUp(newest, 'Start a helper', signal());
  await sessions.idle();
  assert.equal(view(explicitModel).modelOverride, 'configured/two');

  // The pin is saved, so it survives closing and a listener restart.
  await sessions.remove(pinned);
  await sessions.close();
  const restarted = open();
  await restarted.loadPrevious();
  await restarted.reopen(pinned);
  restarted.followUp(pinned, 'After restart', signal());
  await restarted.idle();
  assert.equal((runs.at(-1)?.settings as AgentSettings).model, 'configured/two');
  const archive = JSON.parse(
    await readFile(join(directory, '.companion-sessions', `${legacy}.json`), 'utf8'),
  );
  assert.equal('modelOverride' in archive, false, 'Older conversations stay unpinned');
});

test('the desktop panel reads and changes the defaults through validated actions', async (context) => {
  const { sessions, configurationPath } = await harnessFixture(context);
  const desktop = await desktopFixture(async () => Buffer.alloc(0), sessions);
  context.after(() => desktop.close());

  desktop.send({ action: 'coding-defaults' });
  const shown = (await desktop.reply('coding-defaults')).result as unknown as {
    harness: string;
    revision: string;
  };
  assert.equal(shown.harness, 'pi');

  const original = await readFile(configurationPath, 'utf8');
  for (const request of [
    { harness: 'codex', revision: shown.revision },
    { harness: 'pi', model: '', revision: shown.revision },
    { harness: 'pi', model: 7, revision: shown.revision },
    { harness: 'pi' },
  ]) {
    desktop.send({ action: 'set-coding-defaults', ...request });
    assert.match(
      String((await desktop.reply('set-coding-defaults')).message),
      /Expected a harness/,
    );
  }
  desktop.send({
    action: 'set-coding-defaults',
    harness: 'pi',
    model: 'unlisted/model',
    revision: shown.revision,
  });
  assert.match(
    String((await desktop.reply('set-coding-defaults')).message),
    /not an available Pi model/,
  );
  assert.equal(await readFile(configurationPath, 'utf8'), original);

  desktop.send({ action: 'set-coding-defaults', harness: 'claude-code', revision: shown.revision });
  const saved = (await desktop.reply('set-coding-defaults')).result as unknown as {
    harness: string;
  };
  assert.equal(saved.harness, 'claude-code');
  assert.equal(
    JSON.parse(await readFile(configurationPath, 'utf8')).codingDefaultHarness,
    'claude-code',
  );
});
