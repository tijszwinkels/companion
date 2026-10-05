"""Transcribe only the repository's public fixture; no capture, history or network."""

import argparse
import json
from pathlib import Path
import struct
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--model-dir", required=True, type=Path)
parser.add_argument("--worker", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
worker = args.worker or root / "native/asr-worker/target/release/companion-asr-worker"
pcm = subprocess.run(
    ["ffmpeg", "-nostdin", "-v", "error", "-i", str(root / "test/fixtures/speech.wav"),
     "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
    check=True, capture_output=True, timeout=30,
).stdout
assert len(pcm) % 2 == 0 and 0 < len(pcm) // 2 <= 496000
result = subprocess.run(
    [str(worker.resolve()), "--model", str(args.model_dir.resolve())],
    input=struct.pack("<I", len(pcm) // 2) + pcm,
    capture_output=True, timeout=180, check=True,
)
records = [json.loads(line) for line in result.stdout.splitlines()]
assert len(records) == 2, "Expected ready and result records"
assert records[0] == {
    "type": "ready", "protocol": 1, "engine": "parakeet-tdt", "decoder": "parakeet-rs/0.3.5"
}, "Unexpected worker identity"
assert records[1]["type"] == "result" and "dublin" in records[1]["text"].lower(), records[1]
print("PASS: public fixture transcribed:", records[1]["text"])
