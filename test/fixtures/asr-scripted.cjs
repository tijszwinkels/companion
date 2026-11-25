#!/usr/bin/env node
// The test recogniser as an ASR worker process (protocol 1, see
// native/asr-worker/README.md), for tests that run the real listener as a
// child process. It never looks at the audio's words: each request is
// answered with the phrase the test wrote to `<model directory>/next.txt`,
// which is then consumed, so a second segment of the same sound (or the
// empty-result retry) is answered with no text and filtered out. Without a
// phrase the answer is empty. Every request is counted in `requests.txt`.
const { appendFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const directory = process.argv[3];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

send({ type: 'ready', protocol: 1, engine: 'parakeet-tdt', decoder: 'parakeet-rs/0.3.5' });
process.stdin.resume();

let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);

  // One request: a 32-bit sample count, then that many 16-bit samples.
  while (buffered.length >= 4) {
    const bytes = 4 + buffered.readUInt32LE(0) * 2;
    if (buffered.length < bytes) {
      return;
    }
    buffered = buffered.subarray(bytes);

    let text = '';
    try {
      text = readFileSync(join(directory, 'next.txt'), 'utf8');
      rmSync(join(directory, 'next.txt'));
    } catch {}
    appendFileSync(join(directory, 'requests.txt'), JSON.stringify(text) + '\n');
    send({ type: 'result', text });
  }
});
