// CLI preload: replace desktop commands with fixed data and forbid every other
// subprocess. Checking loaded libraries also catches accidental ONNX imports.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

childProcess.spawn = () => assert.fail('CLI acquired an audio subprocess');
childProcess.execFile = (file, args, _options, callback) => {
  let result;
  if (file === 'hyprctl' && args[1] === 'activewindow') {
    result = Buffer.from(
      JSON.stringify({
        address: '0xabc',
        class: 'editor',
        title: 'Fixture',
        at: [0, 0],
        size: [800, 600],
        monitor: 0,
        mapped: true,
        hidden: false,
      }),
    );
  } else if (file === 'hyprctl' && args[1] === 'monitors') {
    result = Buffer.from(
      JSON.stringify([{ id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0 }]),
    );
  } else if (file === 'grim') {
    result = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
  } else {
    assert.fail(`CLI invoked an unexpected command: ${file}`);
  }

  const child = new EventEmitter();
  process.nextTick(() => {
    callback(null, result, Buffer.alloc(0));
    child.emit('close', 0);
  });
  return child;
};
syncBuiltinESMExports();

process.once('exit', () => {
  const libraries = process.report.getReport().sharedObjects;
  assert.equal(
    libraries.some((path) => /onnxruntime/i.test(path)),
    false,
    'Non-audio CLI mode loaded the native ONNX runtime',
  );
});
