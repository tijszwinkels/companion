// Audio CLI ownership probe. The ASR fixture is a real subprocess; screen
// acquisition fails locally so no compositor, screenshot or microphone is used.
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

childProcess.execFile = (_file, _args, _options, callback) => {
  const child = new EventEmitter();
  process.nextTick(() => {
    callback(Error('Synthetic screen failure'), Buffer.alloc(0), Buffer.alloc(0));
    child.emit('close', 1);
  });
  return child;
};
syncBuiltinESMExports();
