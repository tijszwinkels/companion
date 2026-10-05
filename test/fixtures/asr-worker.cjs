#!/usr/bin/env node
// Disposable protocol peer for lifecycle tests. Records process/request events
// and request framing (sample count, zero padding, content hash), never audio.
// Each spawn selects its own plan so recovery is observable. Within a process,
// plan.requests and settings.texts can script consecutive requests.
const { createHash } = require('node:crypto');
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
const record = (event, details = {}) =>
  appendFileSync(eventsPath, JSON.stringify({ event, pid: process.pid, ...details }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
record('start');

// Ignore TERM deliberately: the parent must be able to end uncooperative work.
process.on('SIGTERM', () => {});
process.stdin.resume();

function respond(action, message) {
  switch (action) {
    case 'hang':
      return;
    case 'delay':
      setTimeout(() => send(message), 150);
      return;
    case 'on-signal':
      // Respond only when the test releases this request, independent of time.
      // Publish 'waiting' only after installing the handler: before that, the
      // default SIGUSR2 disposition would terminate this process.
      process.once('SIGUSR2', () => send(message));
      record('waiting');
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

/** Describe a request's framing: zero samples at each end and a core hash. */
function framing(pcm) {
  const samples = pcm.length / 2;
  let leadingZeros = 0;
  while (leadingZeros < samples && pcm.readInt16LE(leadingZeros * 2) === 0) {
    leadingZeros++;
  }
  let trailingZeros = 0;
  while (
    trailingZeros < samples - leadingZeros &&
    pcm.readInt16LE((samples - 1 - trailingZeros) * 2) === 0
  ) {
    trailingZeros++;
  }
  const core = pcm.subarray(leadingZeros * 2, (samples - trailingZeros) * 2);
  const hash = createHash('sha256').update(core).digest('hex');
  return { samples, leadingZeros, trailingZeros, hash };
}

let requests = 0;
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
  const details = framing(buffered.subarray(4));
  buffered.fill(0);
  buffered = Buffer.alloc(0);
  record('request', details);
  const index = requests++;
  const action = plan.requests?.[index] ?? plan.request;
  const text = settings.texts?.[index] ?? settings.text ?? 'Dublin.';
  respond(action, { type: 'result', text });
});
