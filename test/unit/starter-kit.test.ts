/**
 * Static and fixture checks for the optional starter kit in `starter-kit/`.
 *
 * The kit is Markdown only: skills, an instruction template and optional
 * templates that users adopt by following `starter-kit/README.md`. These tests
 * check what can go wrong without a model: skill frontmatter, the intended
 * inventory, relative links, private or excluded material, the exact purpose
 * line, and that the README's adoption commands add only missing files.
 *
 * The adoption commands run in a temporary HOME. They never touch the real
 * user's skills or instructions. Whether Pi or Claude Code actually loads the
 * installed skills is a separate check that needs those programs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const kitRoot = join(repositoryRoot, 'starter-kit');

const baseSkillNames = [
  'companion-screenshot',
  'companion-source',
  'companion-widgets',
  'computer-use',
  'instruction-graph',
];
const optionalSkillNames = ['task-retrospective'];

const purposeLine =
  'Help humanity, the user, the people and communities around them, and the natural world thrive by making beautiful, useful things that promote diversity, freedom and meaningful choice.';

/** Every file below a directory, as absolute paths. */
function listFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }

  return files.sort();
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Reads the simple YAML frontmatter used by the kit's skills: plain
 * `key: value` lines and folded `key: >-` blocks with indented continuation
 * lines. Anything else is reported as malformed rather than guessed.
 */
function parseFrontmatter(text: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'SKILL.md must start with a --- frontmatter block');

  const fields = new Map<string, string>();
  let foldedKey: string | undefined;

  for (const line of match[1].split('\n')) {
    if (foldedKey !== undefined && line.startsWith('  ')) {
      const previous = fields.get(foldedKey) ?? '';
      const joined = previous === '' ? line.trim() : `${previous} ${line.trim()}`;
      fields.set(foldedKey, joined);
      continue;
    }

    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    assert.ok(field, `malformed frontmatter line: ${line}`);

    const [, key, value] = field;
    assert.ok(!fields.has(key), `duplicate frontmatter key: ${key}`);

    if (value === '>-') {
      foldedKey = key;
      fields.set(key, '');
    } else {
      foldedKey = undefined;
      fields.set(key, value);
    }
  }

  return fields;
}

/** GitHub's heading anchor: lowercase, punctuation removed, spaces to hyphens. */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();

  for (const match of markdown.matchAll(/^#{1,6} (.+)$/gm)) {
    const anchor = match[1]
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/ /g, '-');
    anchors.add(anchor);
  }

  return anchors;
}

/** Contents of fenced code blocks with the given info strings. */
function codeBlocks(markdown: string, languages: string[]): string[] {
  const blocks: string[] = [];

  for (const match of markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)) {
    if (languages.includes(match[1])) {
      blocks.push(match[2]);
    }
  }

  return blocks;
}

function skillDirectories(): Map<string, string> {
  const directories = new Map<string, string>();

  for (const name of readdirSync(join(kitRoot, 'skills'))) {
    directories.set(name, join(kitRoot, 'skills', name));
  }

  for (const name of readdirSync(join(kitRoot, 'optional', 'retrospectives'))) {
    directories.set(name, join(kitRoot, 'optional', 'retrospectives', name));
  }

  return directories;
}

test('the kit contains the five base skills, one optional skill and Markdown only', () => {
  assert.deepEqual(readdirSync(join(kitRoot, 'skills')).sort(), baseSkillNames);
  assert.deepEqual(
    readdirSync(join(kitRoot, 'optional', 'retrospectives')).sort(),
    optionalSkillNames,
  );

  for (const file of listFiles(kitRoot)) {
    const path = relative(kitRoot, file);
    assert.match(path, /\.md$/, `${path}: the kit ships Markdown only`);

    // A file with these names would be loaded as instructions by agents
    // working in this repository, instead of serving as a template.
    assert.doesNotMatch(path, /(^|\/)(AGENTS|CLAUDE)\.md$/i, `${path}: template name`);
  }
});

test('every skill has portable frontmatter matching its directory', () => {
  for (const [directoryName, directory] of skillDirectories()) {
    const fields = parseFrontmatter(readText(join(directory, 'SKILL.md')));
    const name = fields.get('name') ?? '';
    const description = fields.get('description') ?? '';

    // Agent Skills specification limits, also applied by Pi.
    assert.equal(name, directoryName);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64, `${name}: name too long`);
    assert.ok(description.length >= 40, `${name}: description too short to route`);
    assert.ok(description.length <= 1024, `${name}: description over 1024 characters`);
    assert.equal(fields.get('license'), 'GPL-3.0-only');
  }
});

test('relative links in the kit and the installation guide resolve', () => {
  const documents = [...listFiles(kitRoot), join(repositoryRoot, 'docs', 'installation.md')];

  for (const document of documents) {
    const markdown = readText(document);

    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const link = match[1];

      if (/^(https?:|mailto:)/.test(link)) {
        continue;
      }

      const [target, anchor] = link.split('#');
      const targetPath = target === '' ? document : resolve(dirname(document), target);
      const where = `${relative(repositoryRoot, document)} -> ${link}`;

      assert.ok(statSync(targetPath, { throwIfNoEntry: false }), `${where}: missing target`);

      if (anchor !== undefined && targetPath.endsWith('.md')) {
        const anchors = headingAnchors(readText(targetPath));
        assert.ok(anchors.has(anchor), `${where}: missing heading anchor`);
      }
    }
  }
});

test('the installation guide offers the kit as an opt-in step', () => {
  const guide = readText(join(repositoryRoot, 'docs', 'installation.md'));

  assert.match(guide, /\]\(\.\.\/starter-kit\/README\.md\)/);
  assert.match(guide, /Ask the user whether they want it/);
});

test('the kit contains no personal, private or excluded material', () => {
  // Personal paths, identities, hosts and coordination tools of the machine
  // the kit was adapted on; private graph objects; model-role assignments.
  const privatePatterns = [
    /\/home\//,
    /tijs/i,
    /perplexarchy|mattermost|mm-bridge|tinkertank/i,
    /pillar/i,
    /\.worktrees/,
    /b646c84a|e88b5e62/,
    /gpt-\d|astra|opus|sonnet|haiku/i,
    /companion-preview/,
    /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ];

  // Skills deliberately left out of the distributed kit.
  const excludedPatterns = [
    /motion-graphics|hyperframes/i,
    /screen-recording/i,
    /diagnose-crash/i,
    /playwright/i,
    /converseai/i,
    /drone/i,
    /reframe/i,
    /daily-(assistant|reports)/i,
    /software-development-workflow/i,
    /agentcom/i,
    /improvement-loop/i,
    /futuristic/i,
    /openrig/i,
  ];

  for (const file of listFiles(kitRoot)) {
    const text = readText(file);
    const path = relative(repositoryRoot, file);

    for (const pattern of [...privatePatterns, ...excludedPatterns]) {
      assert.doesNotMatch(text, pattern, `${path} matches ${pattern}`);
    }
  }
});

test('the instruction template keeps the exact purpose line and its markers', () => {
  const template = readText(join(kitRoot, 'templates', 'agent-instructions.md'));
  const lines = template.split('\n');

  assert.ok(lines.includes(purposeLine), 'purpose line must match exactly');
  assert.equal(lines[0], '<!-- companion-starter-kit:begin -->');
  assert.ok(lines.includes('<!-- companion-starter-kit:end -->'));

  for (const heading of [
    'Purpose',
    'Conversation',
    'Using the computer',
    'Useful visuals',
    'Skills and existing workflows',
    'Context and control',
  ]) {
    assert.ok(lines.includes(`## ${heading}`), `missing section ${heading}`);
  }
});

test('adoption commands never remove, move, force or redirect over files', () => {
  const readme = readText(join(kitRoot, 'README.md'));
  const forbidden = [
    /\brm\b/,
    /\bmv\b/,
    /\bln\b/,
    /\bsudo\b/,
    /\bcurl\b|\bwget\b/,
    /\bcp\b[^\n]*\s-(\w*f|-force|-remove-destination)/,
    /(^|[^2&])>/m,
  ];

  for (const block of codeBlocks(readme, ['bash', 'sh'])) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(block, pattern, `README command matches ${pattern}:\n${block}`);
    }
  }
});

/**
 * Runs the README's adoption commands, in order, in a temporary HOME. The
 * first block's placeholder kit path is replaced with this checkout's kit.
 */
function runAdoptionCommands(home: string, extraEnvironment: Record<string, string>): string {
  const readme = readText(join(kitRoot, 'README.md'));
  const blocks = codeBlocks(readme, ['bash']).filter((block) => !block.startsWith('diff '));
  assert.equal(blocks.length, 5, 'expected setup, check, skills, memory and retrospective blocks');

  const setup = blocks[0].replace(
    'kit=/absolute/path/to/companion/starter-kit',
    `kit=${JSON.stringify(kitRoot)}`,
  );
  assert.notEqual(setup, blocks[0], 'the setup block must define the kit path');

  const script = ['set -eu', setup, ...blocks.slice(1)].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...extraEnvironment },
  });

  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Path → content of every file below a directory, for before/after checks. */
function snapshot(directory: string): Map<string, string> {
  const contents = new Map<string, string>();

  for (const file of listFiles(directory)) {
    contents.set(relative(directory, file), readText(file));
  }

  return contents;
}

test('adoption adds only missing skills and templates, and repeating it changes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'starter-kit-home-'));

  try {
    // A custom Pi agent directory, a user's own skill with a kit name, and
    // existing instructions that adoption must leave alone.
    const agentDirectory = join(home, 'pi-agent');
    const skills = join(agentDirectory, 'skills');
    const customSkill = join(skills, 'computer-use', 'SKILL.md');
    const instructions = join(home, 'companion', 'agents', 'AGENTS.md');
    mkdirSync(dirname(customSkill), { recursive: true });
    mkdirSync(dirname(instructions), { recursive: true });
    writeFileSync(customSkill, 'the user’s own computer-use skill\n');
    writeFileSync(instructions, '# My assistant\n');

    const environment = { PI_CODING_AGENT_DIR: agentDirectory };
    const firstOutput = runAdoptionCommands(home, environment);

    assert.match(firstOutput, /exists: .*\/pi-agent\/skills\/computer-use/);
    assert.match(firstOutput, /skipped, already exists: .*\/computer-use/);
    assert.equal(readText(customSkill), 'the user’s own computer-use skill\n');
    assert.equal(readText(instructions), '# My assistant\n');

    for (const [name, source] of skillDirectories()) {
      if (name === 'computer-use') {
        continue;
      }

      assert.deepEqual(snapshot(join(skills, name)), snapshot(source), `${name} copied exactly`);
    }

    const memory = join(home, 'companion', 'agents', 'memory');
    assert.deepEqual(snapshot(memory), snapshot(join(kitRoot, 'optional', 'memory', 'template')));

    // Users edit their notes and skills; a second run must keep every change.
    writeFileSync(join(memory, 'index.md'), '# Memory\n\nThe user’s notes.\n');
    const before = snapshot(home);
    const secondOutput = runAdoptionCommands(home, environment);

    assert.doesNotMatch(secondOutput, /added:/);
    assert.match(secondOutput, /exists: .*\/companion\/agents\/memory/);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
