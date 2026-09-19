#!/usr/bin/env node
// Disposable protocol peer for lifecycle tests. Records process/request events,
// never audio. Each spawn selects its own plan so recovery is observable.
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const directory = process.argv[3];
const eventsPath = join(directory, 'events.jsonl');
const settings = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
let previous = '';
try {
  previous = readFileSync(eventsPath, 'utf8');
} catch {}
const generation = previous
  .split('\n')
  .filter((line) => line && JSON.parse(line).event === 'start').length;
const plan = settings.plans[generation] ?? {};
const record = (event) =>
  appendFileSync(eventsPath, JSON.stringify({ event, pid: process.pid }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
record('start');

// Ignore TERM deliberately: the parent must be able to end uncooperative work.
process.on('SIGTERM', () => {});
process.stdin.resume();

function respond(action, message) {
  switch (action) {
    case 'hang':
      return;
    case 'exit':
      process.exit(0);
    case 'eof':
      process.stdout.end();
      return;
    case 'malformed':
      process.stdout.write('{secret-transcript\n');
      return;
    case 'invalid-utf8':
      process.stdout.write(Buffer.from([0xff, 0x0a]));
      return;
    case 'oversized':
      process.stdout.write('x'.repeat(32769));
      return;
    case 'long-text':
      send({ type: 'result', text: 'x'.repeat(4001) });
      return;
    case 'double':
      process.stdout.write(JSON.stringify(message) + '\n' + JSON.stringify(message) + '\n');
      return;
    case 'wrong-type':
      send({ type: 'ready', protocol: 999 });
      return;
    case 'model-error':
      send({ type: 'error', code: 'model', detail: 'secret-transcript' });
      return;
    case 'inference-error':
      send({ type: 'error', code: 'inference', detail: 'secret-transcript' });
      return;
    case 'partial': {
      const bytes = Buffer.from(JSON.stringify(message) + '\n');
      // Split within a UTF-8 character and across JSON boundaries.
      const boundary = Math.max(1, bytes.indexOf(0xc3) + 1);
      process.stdout.write(bytes.subarray(0, boundary));
      setTimeout(() => process.stdout.write(bytes.subarray(boundary)), 5);
      return;
    }
    case 'stderr':
      process.stderr.write('secret-transcript'.repeat(10000));
      break;
  }
  send(message);
}

respond(plan.start, {
  type: 'ready',
  protocol: 1,
  engine: 'parakeet-tdt',
  decoder: 'parakeet-rs/0.3.5',
});

let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4) {
    return;
  }
  const bytes = 4 + buffered.readUInt32LE(0) * 2;
  if (buffered.length < bytes) {
    return;
  }
  if (buffered.length !== bytes) {
    process.exit(3);
  }
  buffered.fill(0);
  buffered = Buffer.alloc(0);
  record('request');
  respond(plan.request, { type: 'result', text: settings.text ?? 'Dublin.' });
});
