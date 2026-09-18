import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../../src/config.ts';
import { DeliveryControl } from '../../src/core/delivery-control.ts';
import { createGraph, type Graph } from '../../src/core/graph.ts';
import { graphToMermaid } from '../../src/core/graph-mermaid.ts';
import { IntentDetector } from '../../src/core/intent-detector.ts';
import type { InspectableModule, RegisteredProcessor } from '../../src/core/module.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { AgentSessions } from '../../src/agents/sessions.ts';
import { PiBackend } from '../../src/agents/pi-backend.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { ActiveWindowSensor } from '../../src/sensors/screen/sensor.ts';
import { desktopFixture } from '../desktop-fixture.ts';
import { frame, processor, signal, testDetector, testSensors } from '../helpers.ts';

test('graph follows actual dependencies and subscriptions without invoking operations', () => {
  const detector = testDetector({ detect: async () => assert.fail('Inspection ran inference') });
  const router = new UserSensorRouter({ detector }, () => {});
  const activity = { delivery: new DeliveryControl() };
  const run = async () => assert.fail('Inspection ran a desktop command');

  const send = new SendTextToApplication(() => {}, false, run, activity);
  const enter = new EnterTextToApplication(() => {}, false, run, activity);
  const ignore = new Ignore(() => {}, activity);
  send.subscribe(router);
  enter.subscribe(router);
  ignore.subscribe(router);

  const sensors = testSensors({
    capture: async () => assert.fail('Inspection captured the screen'),
    transcribe: async () => assert.fail('Inspection ran transcription'),
  });
  const pipeline = new SensorPipeline({ ...sensors, router }, () => {}, signal(), activity);
  const graph = createGraph(pipeline);

  assert.equal(graph.nodes.length, 9);
  assert.equal(graph.edges.length, 9);
  assert.equal(graph.nodes.filter((node) => node.id === activity.delivery.id).length, 1);
  assert.deepEqual(
    graph.edges.filter((edge) => edge.to === activity.delivery.id).map((edge) => edge.from),
    [send.id, enter.id],
  );
  assert.deepEqual(
    graph.edges.find((edge) => edge.to === detector.id),
    {
      from: router.id,
      to: detector.id,
      label: 'detector',
      kind: 'dependency',
    },
  );
  assert.deepEqual(graph.edges.find((edge) => edge.to === enter.id)?.selection, {
    prefixes: ['enter'],
    llmEligible: false,
  });
  assert.deepEqual(graph.edges.find((edge) => edge.to === send.id)?.selection, {
    prefixes: ['insert'],
    llmEligible: true,
  });
  assert.deepEqual(graph.edges.find((edge) => edge.to === ignore.id)?.selection, {
    prefixes: [],
    llmEligible: true,
  });

  // Inspection projects only public graph fields, not methods or payload state.
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
  assert.equal(JSON.stringify(graph).includes(send.instruction), false);
});

test('inspection reports validated prefixes and cannot mutate runtime registrations', async () => {
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
  );
  const delivered: string[] = [];
  const command = {
    ...processor('NOTE', async (frame) => {
      delivered.push(frame.utterance);
    }),
    instruction: undefined,
    prefixes: [' NOTE ', 'Take Note'],
  };
  command.subscribe(router);

  // Runtime dispatch already owns normalized copies. Editing the original
  // array must not make the graph claim a prefix the router does not recognize.
  command.prefixes[0] = 'different';
  const graph = createGraph(router);
  const route = graph.edges.find((edge) => edge.kind === 'route');
  assert.ok(route?.selection);
  assert.deepEqual(route.selection.prefixes, ['take note', 'note']);

  route.selection.prefixes.push('unregistered');
  graph.nodes[0].label = 'Changed exported label';

  // Even a caller that circumvents ReadonlyMap only changes its inspection copy.
  const registrations = router.processors as Map<string, RegisteredProcessor>;
  registrations.clear();
  await router.route({ ...frame, utterance: 'TAKE NOTE, hello' }, signal());
  assert.deepEqual(delivered, ['hello']);

  const fresh = createGraph(router);
  assert.equal(fresh.nodes[0].label, router.label);
  assert.deepEqual(fresh.edges.find((edge) => edge.kind === 'route')?.selection?.prefixes, [
    'take note',
    'note',
  ]);
});

test('a new inspection sees new subscriptions, while failed registration adds no edge', () => {
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  const before = createGraph(router);
  const ignore = processor('IGNORE');
  ignore.subscribe(router);

  assert.throws(() => processor('IGNORE').subscribe(router), /Duplicate/);
  const after = createGraph(router);
  assert.equal(before.edges.filter((edge) => edge.kind === 'route').length, 0);
  assert.equal(after.edges.filter((edge) => edge.kind === 'route').length, 1);
});

test('shared dependencies and cycles terminate, but two objects cannot claim one ID', () => {
  const rootDependencies: Record<string, InspectableModule> = {};
  const childDependencies: Record<string, InspectableModule> = {};
  const root = { id: 'root', label: 'Root', dependencies: rootDependencies };
  const child = { id: 'child', label: 'Child', dependencies: childDependencies };
  rootDependencies.first = child;
  rootDependencies.second = child;
  childDependencies.parent = root;

  const graph = createGraph(root);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 3);

  rootDependencies.duplicate = { id: 'child', label: 'Other child', dependencies: {} };
  assert.throws(() => createGraph(root), /Duplicate module ID: child/);
  assert.throws(() => createGraph({ id: ' ', label: 'Blank ID', dependencies: {} }), /blank/);
});

test('Mermaid uses safe node identifiers and preserves prefix-only route labels', () => {
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Not executed') }) },
    () => {},
  );
  new EnterTextToApplication(() => {}, true).subscribe(router);
  const graph = createGraph(router);
  graph.nodes[0].label = 'Router "] --> injected["\n<b>text</b>';

  const diagram = graphToMermaid(graph);
  assert.ok(diagram.startsWith('flowchart LR\n'));
  assert.ok(diagram.includes('prefix: enter + payload'));
  assert.equal(diagram.includes('LLM: ENTER_TEXT_TO_APPLICATION'), false);
  assert.equal(diagram.includes('"] --> injected['), false);
  assert.equal(diagram.includes('<b>'), false);

  assert.throws(
    () =>
      graphToMermaid({
        nodes: [],
        edges: [{ from: 'missing', to: 'other', label: '', kind: 'dependency' }],
      }),
    /unknown module/,
  );
});

test('Mermaid rejects duplicate identities in supplied graph data', () => {
  const graph: Graph = {
    nodes: [
      { id: 'repeated', label: 'First object' },
      { id: 'repeated', label: 'Different object' },
    ],
    edges: [{ from: 'repeated', to: 'repeated', label: 'self', kind: 'dependency' }],
  };

  assert.throws(() => graphToMermaid(graph), /duplicate module ID: repeated/);
});

test('a processor with no remaining selector still has a readable route label', () => {
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Not executed') }) },
    () => {},
  );
  const action = processor('CUSTOM');
  action.subscribe(router);

  // Instructions are read live, including when they have been removed after
  // registration. Preserve the intent name in this inactive route's diagram.
  action.instruction = undefined;
  const graph = createGraph(router);
  assert.deepEqual(graph.edges.find((edge) => edge.kind === 'route')?.selection, {
    prefixes: [],
    llmEligible: false,
  });
  assert.ok(graphToMermaid(graph).includes('-.->|"CUSTOM"|'));
});

test('CLI exports its real wiring without requiring desktop, model, or audio resources', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-graph-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  // Every external resource is deliberately unavailable. These values are valid
  // configuration, but attempting to start any processing would fail the test.
  const configPath = join(directory, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      llm: { baseUrl: 'http://127.0.0.1:1/v1' },
      asr: { binary: '/nonexistent/voxtype', modelDir: '/nonexistent/model' },
      vadModel: '/nonexistent/vad.onnx',
    }),
  );

  // The CLI's graph branch skips desktop startup, but the exported wiring must
  // match wiring that uses the real desktop-owned delivery queue. A changed
  // queue ID, label, or dependency in DesktopRuntime must fail this comparison.
  const fixture = await desktopFixture(async () => assert.fail('Unexpected desktop command'));
  context.after(() => fixture.close());
  const activity = fixture.runtime.activity;
  const config = await loadConfig(configPath);
  const detector = new IntentDetector(config.llm);
  const router = new UserSensorRouter({ detector }, () => {}, activity);
  const send = new SendTextToApplication(() => {}, false, undefined, activity);
  const enter = new EnterTextToApplication(() => {}, false, undefined, activity);
  send.subscribe(router);
  enter.subscribe(router);
  new Ignore(() => {}, activity).subscribe(router);
  const sessions = new AgentSessions({ backend: new PiBackend() }, () => {});
  new StartCodingAgentSession({ sessions }, () => {}, false, activity).subscribe(router);
  new ContinueOpenAgentConversation({ sessions }, () => {}, false, activity).subscribe(router);
  assert.equal(send.dependencies.delivery, activity.delivery);
  assert.equal(enter.dependencies.delivery, activity.delivery);

  const desktopPipeline = new SensorPipeline(
    {
      screen: new ActiveWindowSensor(),
      transcriber: new Transcriber(config.asr),
      router,
    },
    () => {},
    fixture.controller.signal,
    activity,
  );
  const desktopGraph = createGraph(desktopPipeline);

  // Observe native libraries inside the fresh CLI process. A graph branch that
  // returns early is insufficient if static imports already loaded ONNX.
  const nativeProbePath = join(directory, 'check-native-vad.cjs');
  await writeFile(
    nativeProbePath,
    `const assert = require('node:assert/strict');
process.once('exit', () => {
  const libraries = process.report.getReport().sharedObjects;
  assert.equal(libraries.some((path) => /onnxruntime/i.test(path)), false,
    'Graph export loaded the native ONNX runtime');
});
`,
  );

  const run = promisify(execFile);
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const environment = {
    ...process.env,
    PATH: '/nonexistent',
    XDG_RUNTIME_DIR: join(directory, 'runtime'),
    XDG_STATE_HOME: join(directory, 'state'),
    COMPANION_LLM_API_KEY: 'graph-test-secret-never-export',
  };

  for (const format of ['json', 'mermaid']) {
    const { stdout } = await run(
      process.execPath,
      [
        '--require',
        nativeProbePath,
        '--import',
        'tsx',
        'src/cli.ts',
        '--graph',
        format,
        '--config',
        configPath,
      ],
      { cwd: project, env: environment, timeout: 10000 },
    );

    assert.equal(stdout.includes(environment.COMPANION_LLM_API_KEY), false);
    assert.equal(stdout.includes('http://127.0.0.1:1'), false);

    if (format === 'json') {
      const graph = JSON.parse(stdout) as Graph;
      assert.deepEqual(graph, desktopGraph);
      assert.equal(graph.nodes[0].id, 'pipeline');
      assert.equal(graph.nodes.length, 13);
      assert.equal(graph.edges.filter((edge) => edge.kind === 'route').length, 5);
    } else {
      assert.ok(stdout.startsWith('flowchart LR\n'));
    }
  }

  // Export must not create desktop socket/history directories.
  assert.deepEqual((await readdir(directory)).sort(), ['check-native-vad.cjs', 'config.json']);

  await assert.rejects(
    run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--graph', 'invalid'], {
      cwd: project,
      env: environment,
      timeout: 10000,
    }),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stdout, /--graph requires json or mermaid/);
      return true;
    },
  );
});
