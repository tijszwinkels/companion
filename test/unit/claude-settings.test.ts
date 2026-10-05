import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultAgentSettings,
  defaultClaudeCodeSettings,
  defaultQuickQuestionSettings,
  loadAgentConfiguration,
  loadAgentSettings,
  loadClaudeCodeSettings,
} from '../../src/agents/settings.ts';

async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'companion-agent.json') };
}

test('a new configuration file contains the harness default and Claude Code defaults', async (context) => {
  const { directory, path } = await fixture(context);

  const configuration = await loadAgentConfiguration(directory);

  assert.equal(configuration.codingDefaultHarness, 'pi');
  assert.deepEqual(configuration.claudeCode, defaultClaudeCodeSettings);
  assert.deepEqual(configuration.coding, defaultAgentSettings);
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(written.codingDefaultHarness, 'pi');
  assert.deepEqual(written.claudeCode, {
    executable: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
  });
});

test('old Pi-only files stay valid, unchanged, and default to Pi', async (context) => {
  const { directory, path } = await fixture(context);
  const legacy = JSON.stringify({ ...defaultAgentSettings, thinking: 'low' });
  await writeFile(path, legacy);

  const configuration = await loadAgentConfiguration(directory);

  assert.equal(configuration.codingDefaultHarness, 'pi');
  assert.deepEqual(configuration.claudeCode, defaultClaudeCodeSettings);
  assert.equal(configuration.coding.thinking, 'low');
  assert.equal(await readFile(path, 'utf8'), legacy, 'Loading never rewrites existing files');
});

test('a partial claudeCode object fills omitted fields from the defaults', async (context) => {
  const { directory, path } = await fixture(context);
  await writeFile(
    path,
    JSON.stringify({
      ...defaultAgentSettings,
      codingDefaultHarness: 'claude-code',
      claudeCode: { effort: 'max' },
    }),
  );

  const configuration = await loadAgentConfiguration(directory);

  assert.equal(configuration.codingDefaultHarness, 'claude-code');
  assert.deepEqual(await loadClaudeCodeSettings(directory), {
    executable: 'claude',
    model: 'claude-opus-5-5',
    effort: 'max',
  });
  assert.deepEqual(await loadAgentSettings(directory, 'quickQuestion'), {
    ...defaultAgentSettings,
    ...defaultQuickQuestionSettings,
  });
});

test('invalid Claude settings are rejected and also block Pi turns', async (context) => {
  const { directory, path } = await fixture(context);
  const invalidSections: unknown[] = [
    null,
    [],
    'claude',
    { executable: '' },
    { model: '' },
    { model: 'anthropic/claude-opus-5-5' },
    { model: '--dangerous-flag' },
    { model: 'claude opus' },
    // The session store refuses archives with a longer captured model, so an
    // over-long configured model must already fail whole-file validation.
    { model: 'c'.repeat(301) },
    { effort: 'off' },
    { effort: 'minimal' },
    { thinking: 'high' },
    { fallbackModel: 'claude-haiku-4-5' },
  ];

  for (const claudeCode of invalidSections) {
    await writeFile(path, JSON.stringify({ ...defaultAgentSettings, claudeCode }));
    await assert.rejects(loadClaudeCodeSettings(directory), /claudeCode/);
    await assert.rejects(loadAgentSettings(directory), /claudeCode/);
  }
});

test('an unknown harness or top-level key is rejected', async (context) => {
  const { directory, path } = await fixture(context);

  for (const codingDefaultHarness of ['codex', 'claude', '', null, 1]) {
    await writeFile(path, JSON.stringify({ ...defaultAgentSettings, codingDefaultHarness }));
    await assert.rejects(loadAgentConfiguration(directory), /codingDefaultHarness/);
  }

  await writeFile(path, JSON.stringify({ ...defaultAgentSettings, claude: {} }));
  await assert.rejects(loadAgentConfiguration(directory), /expected only/);
});

test('reading without initialization neither creates the file nor fails when it is missing', async (context) => {
  const { directory, path } = await fixture(context);

  const configuration = await loadAgentConfiguration(directory, false);

  assert.equal(configuration.codingDefaultHarness, 'pi');
  assert.deepEqual(configuration.claudeCode, defaultClaudeCodeSettings);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
