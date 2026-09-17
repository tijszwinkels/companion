`silero_vad_v5.onnx` is the Silero v5 model bundled by
[@ricky0123/vad-web 0.0.31](https://www.npmjs.com/package/@ricky0123/vad-web/v/0.0.31),
copied from the previous Companion spike. Bundling keeps startup offline.

SHA-256: `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`

Upstream: [Silero VAD](https://github.com/snakers4/silero-vad).
License: [MIT](LICENSE.silero).

The state/context implementation follows the upstream
[ONNX wrapper](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py):
512 new samples, 64 previous samples, and recurrent state at 16 kHz.
