import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { restoreIntentRequest, type IntentRequestRecord } from '../core/intent-request.ts';

/** Frozen labels and requests; images remain checksum-verified, separate files. */
export interface EvalExample {
  id: string;
  observedAt: number;
  expected: string;
  originalPrediction: string | null;
  request: string;
}

export interface EvalDataset {
  version: 1;
  exportedAt: string;
  examples: EvalExample[];
}

interface Row {
  id: string;
  observed_at: number;
  intent_request: string | null;
  recognized_intent: string | null;
  correct: number | null;
  actual_intent: string | null;
  feedback_prediction: string | null;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Never open history's writer: that would migrate/chmod the live database. */
function readRows(path: string): Row[] {
  const database = new DatabaseSync(path, { readOnly: true });

  try {
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 5) {
      throw Error('Evals require schema 5; this command never migrates the database');
    }

    return database
      .prepare(
        `
      SELECT u.id, u.observed_at, u.intent_request, u.recognized_intent,
             f.correct, f.actual_intent, f.recognized_intent AS feedback_prediction
      FROM utterances AS u LEFT JOIN intent_feedback AS f ON f.id = u.id
      ORDER BY u.observed_at, u.id
    `,
      )
      .all() as unknown as Row[];
  } finally {
    database.close();
  }
}

function expectedIntent(row: Row): string | null {
  // An incorrect label with no correction is not a ground-truth class. Correct
  // feedback uses its captured prediction, never an inferred success outcome.
  return row.actual_intent || (row.correct === 1 ? row.feedback_prediction : null);
}

export function inspectDatabase(path: string): Record<string, number> {
  const rows = readRows(path);

  return {
    total: rows.length,
    recorded: rows.filter((row) => row.intent_request !== null).length,
    labeled: rows.filter((row) => row.correct !== null).length,
    usableLabels: rows.filter((row) => row.intent_request !== null && expectedIntent(row)).length,
    correctWithRequest: rows.filter((row) => row.correct === 1 && row.intent_request !== null)
      .length,
    correctMissingRequest: rows.filter((row) => row.correct === 1 && row.intent_request === null)
      .length,
    correctedWithRequest: rows.filter(
      (row) => row.correct === 0 && row.actual_intent && row.intent_request !== null,
    ).length,
    correctedMissingRequest: rows.filter(
      (row) => row.correct === 0 && row.actual_intent && row.intent_request === null,
    ).length,
    incorrectWithoutClass: rows.filter((row) => row.correct === 0 && !row.actual_intent).length,
    missingRequest: rows.filter((row) => row.intent_request === null).length,
    recordedWithoutClass: rows.filter((row) => row.intent_request !== null && !expectedIntent(row))
      .length,
  };
}

/** Extract only registered names from the recorded system prompt, not context. */
export function recordedIntents(record: IntentRequestRecord): string[] {
  const messages = record.body.messages;
  if (!Array.isArray(messages)) {
    throw Error('Recorded messages are missing');
  }

  const names: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== 'system' || typeof message.content !== 'string') {
      continue;
    }
    for (const match of message.content.matchAll(/^Name: (\S+)\r?$/gm)) {
      names.push(match[1]!);
    }
  }

  if (names.length === 0) {
    throw Error('Cannot identify registered intents in recorded system prompt');
  }
  return [...new Set(names)];
}

async function screenshot(directory: string, id: string): Promise<Buffer> {
  if (!uuid.test(id)) {
    throw Error('Invalid utterance UUID');
  }
  const data = join(directory, 'data');
  const days = await readdir(data, { withFileTypes: true });
  const matches: Buffer[] = [];

  // Search date buckets because the current timezone may differ from recording.
  for (const day of days) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) {
      continue;
    }
    try {
      matches.push(await readFile(join(data, day.name, 'screenshots', `${id}.png`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (matches.length !== 1) {
    throw Error(`Expected one screenshot, found ${matches.length}`);
  }
  return matches[0]!;
}

export async function exportDataset(
  databasePath: string,
  outputDirectory: string,
  limit = 100,
): Promise<{ exported: number; skipped: { id: string; reason: string }[] }> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw Error('Limit must be a positive integer');
  }
  const rows = readRows(databasePath);
  // Refuse to overwrite an existing reviewed dataset, even if it is empty.
  await mkdir(outputDirectory, { mode: 0o700 });
  const examples: EvalExample[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const row of rows) {
    const expected = expectedIntent(row);
    if (!row.intent_request || !expected) {
      continue;
    }
    if (examples.length >= limit) {
      break;
    }
    try {
      const png = await screenshot(dirname(databasePath), row.id);
      const record = restoreIntentRequest(row.intent_request, png);
      if (!recordedIntents(record).includes(expected)) {
        throw Error('Label is not a registered intent in this recorded request');
      }
      await writeFile(join(outputDirectory, `${row.id}.png`), png, { mode: 0o600, flag: 'wx' });
      examples.push({
        id: row.id,
        observedAt: row.observed_at,
        expected,
        originalPrediction: row.recognized_intent,
        request: row.intent_request,
      });
    } catch (error) {
      skipped.push({ id: row.id, reason: (error as Error).message });
    }
  }

  const dataset: EvalDataset = { version: 1, exportedAt: new Date().toISOString(), examples };
  await writeFile(join(outputDirectory, 'dataset.json'), JSON.stringify(dataset, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(outputDirectory, 'export-report.json'),
    JSON.stringify({ exported: examples.length, skipped }, null, 2) + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  return { exported: examples.length, skipped };
}

export async function loadDataset(path: string): Promise<EvalDataset> {
  const dataset = JSON.parse(await readFile(path, 'utf8')) as EvalDataset;
  if (dataset.version !== 1 || !Array.isArray(dataset.examples) || dataset.examples.length === 0) {
    throw Error('Expected a nonempty version 1 evaluation dataset');
  }
  const ids = new Set<string>();
  for (const example of dataset.examples) {
    if (
      !example ||
      !uuid.test(example.id) ||
      ids.has(example.id) ||
      typeof example.expected !== 'string' ||
      !example.expected ||
      typeof example.request !== 'string' ||
      !Number.isFinite(example.observedAt) ||
      !(example.originalPrediction === null || typeof example.originalPrediction === 'string')
    ) {
      throw Error('Invalid or duplicate evaluation example');
    }
    ids.add(example.id);
  }
  return dataset;
}

export async function restoreExample(
  datasetPath: string,
  example: EvalExample,
): Promise<IntentRequestRecord> {
  if (!uuid.test(example.id)) {
    throw Error('Invalid utterance UUID');
  }
  const png = await readFile(join(dirname(datasetPath), `${example.id}.png`));
  const record = restoreIntentRequest(example.request, png);
  if (!recordedIntents(record).includes(example.expected)) {
    throw Error('Expected intent is absent from the recorded prompt');
  }
  return record;
}

/** Fingerprints contain no prompt text or screenshots and permit parity checks. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
