/**
 * Adversarial fixture tests for the JSON cleanup experiment.
 *
 * WHAT THIS PROVES: the synthetic adversarial fixtures are well formed and
 * realistic (built through the live router and prompt builder), and the eval
 * HARNESS detects each scripted attack response by the documented mechanism:
 * contract rejection, classification regression, a failed literal check or a
 * transport error.
 *
 * WHAT THIS DOES NOT PROVE: that any real model resists these attacks. The
 * "attack" and "compliant" responses are scripted by a local fake server.
 * Model robustness needs a separately authorized real run and human review.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadLiteralChecks } from '../../src/evals/experiments/json-cleanup/checks.ts';
import { runPairedComparison } from '../../src/evals/experiments/json-cleanup/compare.ts';
import {
  SHORTCUT_ONLY_ROUTES,
  TEXT_ROUTES,
} from '../../src/evals/experiments/json-cleanup/contract.ts';
import { planExperiment, runExperiment } from '../../src/evals/experiments/json-cleanup/runner.ts';
import {
  ADVERSARIAL_CASES,
  FIXED_ROUTE_CASES,
  INFERRED_CASES,
  writeAdversarialFixtures,
  type AdversarialCase,
  type ScriptedResponse,
} from '../fixtures/intent-json-cleanup/adversarial.ts';

const VARIANT_MARKER = 'Response format (json-cleanup-v1):';

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'companion-cleanup-adversarial-'));
  return writeAdversarialFixtures(join(root, 'fixtures'));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function utteranceOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: unknown }[];
  const user = messages.find((message) => message.role === 'user')!;
  const part = (user.content as { type: string; text?: string }[]).find(
    (entry) => entry.type === 'text',
  )!;
  return JSON.parse(part.text!).utterance;
}

function systemPromptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((message) => message.role === 'system')!.content;
}

/** Answer in the request's own wire mode, as a real OpenAI-compatible server would. */
function reply(response: ServerResponse, streaming: boolean, scripted: ScriptedResponse): void {
  const finish = scripted.finishReason ?? 'stop';
  if (!streaming) {
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: scripted.content },
            finish_reason: finish,
          },
        ],
      }),
    );
    return;
  }

  response.setHeader('Content-Type', 'text/event-stream');
  const packets = [
    {
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: scripted.content },
          finish_reason: finish,
        },
      ],
    },
  ];
  response.end(
    packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
  );
}

/**
 * Local fake model. Variant requests (JSON prompt) get the case's scripted
 * response; exact-replay baseline requests get `baseline(case)` as a bare name.
 */
async function fakeModel(
  choose: (testCase: AdversarialCase) => ScriptedResponse,
  baseline: (testCase: AdversarialCase) => string = (testCase) =>
    testCase.mode === 'inferred' ? testCase.expected : testCase.route,
) {
  const byUtterance = new Map(ADVERSARIAL_CASES.map((testCase) => [testCase.utterance, testCase]));
  // Arm of every request in arrival order: 'variant', 'baseline' or 'fixed'.
  const sequence: string[] = [];

  const instance = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const testCase = byUtterance.get(utteranceOf(body));
      assert.ok(testCase, 'request for an unknown case');

      if (testCase.mode === 'fixed-route') {
        sequence.push('fixed');
        reply(response, body.stream === true, choose(testCase));
      } else if (systemPromptOf(body).includes(VARIANT_MARKER)) {
        sequence.push('variant');
        reply(response, body.stream === true, choose(testCase));
      } else {
        sequence.push('baseline');
        reply(response, body.stream === true, { content: baseline(testCase) });
      }
    })();
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    sequence,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('adversarial fixtures are complete, synthetic, supported and built from the live router', async () => {
  const paths = await fixtures();

  // Coverage of the requested attack families and of all five text routes.
  const categories = new Set(ADVERSARIAL_CASES.flatMap((testCase) => testCase.categories));
  for (const category of [
    'screenshot-injection',
    'dictated-injection',
    'route-switch',
    'no-text-intent',
    'meaning-preservation',
    'rich-formatting',
    'malformed-output',
    'action-attempt',
  ]) {
    assert.ok(categories.has(category as never), `missing category ${category}`);
  }
  assert.deepEqual(
    [...new Set(FIXED_ROUTE_CASES.map((testCase) => testCase.route))].sort(),
    [...TEXT_ROUTES].sort(),
  );
  assert.equal(
    new Set(ADVERSARIAL_CASES.map((testCase) => testCase.name)).size,
    ADVERSARIAL_CASES.length,
  );

  // Every case is usable by the experiment, with zero model calls.
  const inferredPlan = await planExperiment(
    { mode: 'inferred', datasetPath: paths.datasetPath },
    512,
  );
  assert.equal(inferredPlan.supported.length, INFERRED_CASES.length);
  assert.deepEqual(inferredPlan.unsupported, []);
  const fixedPlan = await planExperiment(
    { mode: 'fixed-route', datasetPath: paths.fixedRoutesPath },
    512,
  );
  assert.equal(fixedPlan.supported.length, FIXED_ROUTE_CASES.length);
  await loadLiteralChecks(paths.inferredChecksPath);
  await loadLiteralChecks(paths.fixedChecksPath);

  // Recorded eligibility comes from the live router: the expected label is
  // offered, and shortcut-only routes never are.
  const dataset = JSON.parse(await readFile(paths.datasetPath, 'utf8'));
  for (const example of dataset.examples) {
    const record = JSON.parse(example.request);
    const offered = [
      ...(record.body.messages[0].content as string).matchAll(/^Name: (\S+)$/gm),
    ].map((match) => match[1]);
    assert.ok(offered.includes(example.expected));
    assert.ok(!offered.some((name) => SHORTCUT_ONLY_ROUTES.has(name!)));
    assert.equal(record.body.max_tokens, 32);
  }

  const catalog = JSON.parse(await readFile(paths.catalogPath, 'utf8'));
  assert.equal(catalog.length, ADVERSARIAL_CASES.length);
});

test('harness flags every scripted attack by its documented mechanism (not model evidence)', async () => {
  const paths = await fixtures();
  const inferredChecks = await loadLiteralChecks(paths.inferredChecksPath);
  const fixedChecks = await loadLiteralChecks(paths.fixedChecksPath);
  const model = await fakeModel((testCase) => testCase.attack);

  try {
    const targets = [{ name: 'attacked', model: 'fake', baseUrl: model.url, concurrency: 4 }];

    // Inferred cases through the paired comparison: the baseline answers the
    // correct label, so classification attacks must surface as regressions.
    const comparison = await runPairedComparison({
      datasetPath: paths.datasetPath,
      targets,
      outputTokens: 512,
      order: 'baseline-first',
      checks: inferredChecks,
    });
    const fixed = await runExperiment(
      { mode: 'fixed-route', datasetPath: paths.fixedRoutesPath },
      targets,
      512,
      undefined,
      fixedChecks,
    );

    const variantById = new Map(
      [...comparison.report.variantReport.results, ...fixed.report.results].map((row) => [
        row.id,
        row,
      ]),
    );
    const pairById = new Map(comparison.report.pairs.map((pair) => [pair.id, pair]));

    for (const testCase of ADVERSARIAL_CASES) {
      const id = testCase.mode === 'inferred' ? paths.inferredIds[testCase.name]! : testCase.name;
      const row = variantById.get(id)!;
      const detection = testCase.attackDetectedBy;
      const label = `${testCase.name} (${detection})`;

      if (detection === 'classification') {
        assert.equal(row.status, 'valid', label);
        assert.equal(row.correct, false, label);
        assert.equal(pairById.get(id)!.change, 'regression', label);
      } else if (detection === 'literal-check') {
        assert.equal(row.status, 'valid', label);
        assert.equal(row.literalCheck, 'failed', label);
        if (testCase.mode === 'inferred') {
          // The intent is right; only the cleaned text is wrong.
          assert.equal(row.correct, true, label);
        }
      } else if (detection === 'error') {
        assert.equal(row.status, 'error', label);
      } else {
        assert.equal(row.status, 'invalid', label);
        assert.equal(row.invalidReason, detection.slice('invalid:'.length), label);
      }
    }

    // The paired summary counts the inferred attacks as regressions with causes.
    const paired = comparison.report.paired[0]!;
    const inferredAttacks = INFERRED_CASES.length;
    const literalOnly = INFERRED_CASES.filter(
      (testCase) => testCase.attackDetectedBy === 'literal-check',
    ).length;
    assert.equal(paired.pairedExamples, inferredAttacks);
    assert.equal(paired.baseline.accuracy, 1);
    assert.equal(paired.changes.regressions, inferredAttacks - literalOnly);
    assert.equal(
      paired.regressionCauses.invalidJson,
      INFERRED_CASES.filter((testCase) => testCase.attackDetectedBy.startsWith('invalid:')).length,
    );

    // Reports stay content-free even under attack: no utterance, no injected text.
    const shareable = JSON.stringify([comparison.report, fixed.report]);
    for (const testCase of ADVERSARIAL_CASES) {
      assert.ok(!shareable.includes(testCase.utterance), testCase.name);
    }
    assert.ok(!shareable.includes('rm -rf'));
    assert.ok(!shareable.includes('APPROVED'));
  } finally {
    await model.close();
  }
});

test('compliant scripted responses pass the contract, classification and literal checks', async () => {
  const paths = await fixtures();
  const model = await fakeModel((testCase) => testCase.compliant);

  try {
    const targets = [{ name: 'compliant', model: 'fake', baseUrl: model.url, concurrency: 2 }];
    const comparison = await runPairedComparison({
      datasetPath: paths.datasetPath,
      targets,
      outputTokens: 512,
      order: 'variant-first',
      checks: await loadLiteralChecks(paths.inferredChecksPath),
    });
    const fixed = await runExperiment(
      { mode: 'fixed-route', datasetPath: paths.fixedRoutesPath },
      targets,
      512,
      undefined,
      await loadLiteralChecks(paths.fixedChecksPath),
    );

    const paired = comparison.report.paired[0]!;
    assert.equal(paired.baseline.accuracy, 1);
    assert.equal(paired.variant.accuracy, 1);
    assert.equal(paired.changes.regressions, 0);
    assert.equal(paired.variant.malformedRate, 0);

    for (const row of [...comparison.report.variantReport.results, ...fixed.report.results]) {
      assert.equal(row.status, 'valid', row.id);
      assert.notEqual(row.literalCheck, 'failed', row.id);
    }
    assert.equal(fixed.report.summary[0]!.routeIdentity!.changed, 0);
    assert.equal(fixed.report.summary[0]!.literalChecks!.failed, 0);
    assert.equal(
      comparison.report.variantReport.summary[0]!.literalChecks!.passed,
      INFERRED_CASES.filter((testCase) => testCase.checks).length,
    );

    // Private outputs keep the cleaned text exactly for human review.
    const negation = comparison.privateOutputs.find(
      (entry) => entry.id === paths.inferredIds['in-continue-negation'],
    )!;
    assert.equal(negation.cleanedText, "No, don't delete it. Keep 0007 for now.");
    assert.equal(negation.literalCheck.status, 'passed');

    // variant-first order: the whole variant arm ran before the baseline arm.
    assert.equal(comparison.report.order, 'variant-first');
    const compareSequence = model.sequence.filter((arm) => arm !== 'fixed');
    assert.deepEqual(compareSequence, [
      ...Array<string>(INFERRED_CASES.length).fill('variant'),
      ...Array<string>(INFERRED_CASES.length).fill('baseline'),
    ]);
  } finally {
    await model.close();
  }
});
