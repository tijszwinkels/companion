`speech.wav` is the first five seconds of the public Silero test recording:
https://github.com/snakers4/silero-vad/blob/master/tests/data/test.wav

Converted to mono PCM16 at 16 kHz with:

```sh
ffmpeg -i test.wav -t 5 -ar 16000 -ac 1 speech.wav
```

It contains narrated conversation about getting to Dublin. This is used to test
VAD, actual transcription, and background-speech classification.
See [Silero's MIT license](../../assets/LICENSE.silero).
