import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessage, type AgentSession } from '../../src/agents/types.ts';
import {
  closedModelName,
  modelChoice,
  type ModelCatalogs,
  type PickerState,
} from '../../integrations/shell/src/models/model-choice.ts';

/**
 * The model picker's rule (integrations/shell/README.md, "Model picker") as
 * one table: what the picker shows and offers for each kind of conversation
 * and state. The cases that need the page (a refusal shown, no
 * conversation, the settings screen, a change reaching the listener and
 * one made elsewhere) are rows of the same table in model-picker.test.ts,
 * against the real gateway and listener.
 */

const piCatalog: ModelCatalogs = {
  models: {
    models: ['local/qwen', 'cloud/large'],
    pinned: ['local/qwen'],
    thinkingLevels: {},
    coding: 'cloud/large',
    quickQuestion: 'local/qwen',
    codingThinking: 'medium',
    quickQuestionThinking: 'off',
  },
  modelsError: '',
  modelsLoading: false,
  claudeModelsError: '',
  claudeModelsLoading: false,
};

const claudeCatalog: ModelCatalogs = {
  modelsError: '',
  modelsLoading: false,
  claudeModels: { models: ['claude-a', 'claude-b'], model: 'claude-a' },
  claudeModelsError: '',
  claudeModelsLoading: false,
};

const idle: PickerState = { admitted: true, changing: false, showAll: false };

function pi(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'pi',
    title: 'Pi',
    status: 'completed',
    model: 'cloud/large',
    error: '',
    messages: [chatMessage('q', 'user', 'Hello')],
    updatedAt: 1,
    ...overrides,
  };
}

function claude(overrides: Partial<AgentSession> = {}): AgentSession {
  return pi({
    id: 'claude',
    harness: 'claude-code',
    model: 'claude-b',
    claudeCode: { model: 'claude-b', effort: 'high' },
    ...overrides,
  });
}

interface Case {
  name: string;
  session: AgentSession;
  catalogs: ModelCatalogs;
  picker?: Partial<PickerState>;
  expect: {
    current: string;
    options: string[];
    selected: string;
    enabled: boolean;
    status?: string;
    note?: string;
    showAllLabel?: string;
  };
}

const cases: Case[] = [
  {
    name: 'Pi, idle, its profile default: the default first, then the pinned models',
    session: pi(),
    catalogs: piCatalog,
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · cloud/large', 'local/qwen'],
      selected: '',
      enabled: true,
      showAllLabel: 'Show all models',
    },
  },
  {
    name: 'Pi, Show all models: every model',
    session: pi(),
    catalogs: piCatalog,
    picker: { showAll: true },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · cloud/large', 'local/qwen', 'cloud/large'],
      selected: '',
      enabled: true,
      showAllLabel: 'Pinned models only',
    },
  },
  {
    name: 'Pi, running: the choice is for the next turn and may be made',
    session: pi({ status: 'running', modelOverride: 'local/qwen' }),
    catalogs: piCatalog,
    expect: {
      current: 'local/qwen',
      options: ['Use coding default · cloud/large', 'local/qwen'],
      selected: 'local/qwen',
      enabled: true,
    },
  },
  {
    name: 'Pi quick question: its own profile default',
    session: pi({ profile: 'quickQuestion' }),
    catalogs: piCatalog,
    expect: {
      current: 'local/qwen',
      options: ['Use quick-question default · local/qwen', 'local/qwen'],
      selected: '',
      enabled: true,
    },
  },
  {
    name: 'Pi, a choice the catalogue no longer lists: shown, marked unavailable',
    session: pi({ modelOverride: 'gone/model' }),
    catalogs: piCatalog,
    expect: {
      current: 'gone/model',
      options: ['Use coding default · cloud/large', 'local/qwen', 'gone/model (unavailable)'],
      selected: 'gone/model',
      enabled: true,
    },
  },
  {
    name: 'Pi, changed elsewhere: the conversation’s new choice is shown',
    session: pi({ modelOverride: 'cloud/large' }),
    catalogs: piCatalog,
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · cloud/large', 'local/qwen', 'cloud/large'],
      selected: 'cloud/large',
      enabled: true,
    },
  },
  {
    name: 'Pi, the list is loading for the first time: waits for it',
    session: pi(),
    catalogs: { ...piCatalog, models: undefined, modelsLoading: true },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · profile settings'],
      selected: '',
      enabled: false,
      status: 'Loading models…',
    },
  },
  {
    name: 'Pi, the list not read yet: waits for it',
    session: pi(),
    catalogs: { ...piCatalog, models: undefined },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · profile settings'],
      selected: '',
      enabled: false,
    },
  },
  {
    name: 'Pi, the list failed to load: its failure; the default stays choosable',
    session: pi(),
    catalogs: { ...piCatalog, models: undefined, modelsError: 'Pi is not configured' },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · profile settings'],
      selected: '',
      enabled: true,
      status: 'Pi is not configured',
    },
  },
  {
    name: 'Pi, a change on its way: no second one',
    session: pi(),
    catalogs: piCatalog,
    picker: { changing: true },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · cloud/large', 'local/qwen'],
      selected: '',
      enabled: false,
    },
  },
  {
    name: 'Pi, not connected: nothing can be chosen',
    session: pi(),
    catalogs: piCatalog,
    picker: { admitted: false },
    expect: {
      current: 'cloud/large',
      options: ['Use coding default · cloud/large', 'local/qwen'],
      selected: '',
      enabled: false,
    },
  },
  {
    name: 'Claude Code, idle: its Claude models, the default marked, the effort fixed',
    session: claude(),
    catalogs: claudeCatalog,
    expect: {
      current: 'claude-b',
      options: ['claude-a · configured default', 'claude-b'],
      selected: 'claude-b',
      enabled: true,
      note: 'Effort · high · fixed. Same Claude history; effort stays as it started.',
    },
  },
  {
    name: 'Claude Code, running: the next turn’s model may be chosen',
    session: claude({ status: 'running' }),
    catalogs: claudeCatalog,
    expect: {
      current: 'claude-b',
      options: ['claude-a · configured default', 'claude-b'],
      selected: 'claude-b',
      enabled: true,
    },
  },
  {
    name: 'Claude Code, a model the list does not have: still shown',
    session: claude({ claudeCode: { model: 'claude-x', effort: 'low' } }),
    catalogs: claudeCatalog,
    expect: {
      current: 'claude-x',
      options: ['claude-a · configured default', 'claude-b', 'claude-x'],
      selected: 'claude-x',
      enabled: true,
    },
  },
  {
    name: 'Claude Code, the list failed to load: its failure; its own model is shown',
    session: claude(),
    catalogs: { ...claudeCatalog, claudeModels: undefined, claudeModelsError: 'Refused' },
    expect: {
      current: 'claude-b',
      options: ['claude-b'],
      selected: 'claude-b',
      enabled: true,
      status: 'Refused',
    },
  },
];

for (const testCase of cases) {
  test(`model picker: ${testCase.name}`, () => {
    const choice = modelChoice(testCase.session, testCase.catalogs, {
      ...idle,
      ...testCase.picker,
    });
    assert.equal(choice.current, testCase.expect.current);
    assert.deepEqual(
      choice.options.map((option) => option.label),
      testCase.expect.options,
    );
    assert.equal(choice.selected, testCase.expect.selected);
    assert.equal(choice.enabled, testCase.expect.enabled);
    assert.equal(choice.status, testCase.expect.status ?? '');
    if (testCase.expect.note !== undefined) {
      assert.equal(choice.note, testCase.expect.note);
    }
    if (testCase.expect.showAllLabel !== undefined) {
      assert.equal(choice.showAllLabel, testCase.expect.showAllLabel);
    }
  });
}

// ---- The closed picker's text (README "Model picker", rule 9) ---------------------

test('closed picker: the part of the name that tells the model apart', () => {
  const cases: { name: string; known: string[]; lead: string; distinct: string }[] = [
    {
      name: 'claude-sonnet-5',
      known: ['claude-sonnet-5', 'claude-a'],
      lead: '',
      distinct: 'claude-sonnet-5',
    },
    {
      name: 'openai-codex/gpt-5.1-codex-max',
      known: ['local/qwen3-coder-30b', 'openai-codex/gpt-5.1-codex-max'],
      lead: '',
      distinct: 'gpt-5.1-codex-max',
    },
    { name: 'local/qwen', known: ['local/qwen', 'cloud/large'], lead: '', distinct: 'qwen' },
    { name: 'local/qwen', known: ['cloud/qwen'], lead: 'local/', distinct: 'qwen' },
    // A known name equal to the shorter ending also makes it ambiguous.
    {
      name: 'openrouter/openai/gpt-5',
      known: ['openai/gpt-5'],
      lead: 'openrouter/openai/',
      distinct: 'gpt-5',
    },
    { name: 'openrouter/openai/gpt-5', known: ['azure/gpt-5'], lead: 'openai/', distinct: 'gpt-5' },
    { name: 'ghost/model/', known: [], lead: '', distinct: 'ghost/model/' },
    { name: 'gone/model', known: [], lead: '', distinct: 'model' },
    {
      name: 'synthetic/model',
      known: ['synthetic/model', 'ghost/model'],
      lead: 'synthetic/',
      distinct: 'model',
    },
  ];
  for (const testCase of cases) {
    assert.deepEqual(
      closedModelName(testCase.name, testCase.known),
      { lead: testCase.lead, distinct: testCase.distinct },
      `${testCase.name} among ${testCase.known.join(', ')}`,
    );
  }
});

test("closed picker: the choice names the next turn's model by its distinct part", () => {
  // Pi, the profile default, the catalogue read.
  assert.deepEqual(modelChoice(pi(), piCatalog, idle).closedName, { lead: '', distinct: 'large' });
  // Pi before the catalogue is read: only the conversation's own model is known.
  const unread: ModelCatalogs = { ...piCatalog, models: undefined };
  assert.deepEqual(modelChoice(pi({ model: 'cloud/qwen' }), unread, idle).closedName, {
    lead: '',
    distinct: 'qwen',
  });
  // Pi, an own choice whose last part another known model shares.
  const shared: ModelCatalogs = {
    ...piCatalog,
    models: { ...piCatalog.models!, models: ['local/qwen', 'cloud/qwen'] },
  };
  assert.deepEqual(modelChoice(pi({ modelOverride: 'cloud/qwen' }), shared, idle).closedName, {
    lead: 'cloud/',
    distinct: 'qwen',
  });
  // Claude Code: the name whole.
  assert.deepEqual(modelChoice(claude(), claudeCatalog, idle).closedName, {
    lead: '',
    distinct: 'claude-b',
  });
});
