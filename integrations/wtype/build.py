"""Build the reviewed wtype dependency patch into a private, empty directory.

This never installs a binary or changes PATH. Pin both the upstream commit and
source digests so a future upstream change cannot silently alter the candidate.
Requires a C compiler, patch, pkg-config, wayland-scanner, and development files
for wayland-client and xkbcommon. It does not install missing dependencies.
"""
import argparse
import hashlib
from pathlib import Path
import shlex
import subprocess
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path, help="Empty private build directory")
arguments = parser.parse_args()
directory = arguments.directory.resolve()
directory.mkdir(parents=True, exist_ok=True)
if any(directory.iterdir()):
    raise SystemExit("Build directory must be empty; existing files were not changed")

revision = "d71be3a7b3f93b534a2823fd68cabd7ac2a02359"  # wtype v0.4
sources = {
    "main.c": "713597abfc049196864ffcc041bb6683c761b71d68ed2da86cdcfc6b7ed3d244",
    "protocol/virtual-keyboard-unstable-v1.xml": "7ad7870003ecd592cae47dc19d277a609b7f18fd7b7be012623cf3225a7294f5",
    "LICENSE": "e8bd6bac1b3ba6253625830bceb30c5340f74f4bc898d1bd5450596cbd8224f0",
}

for name, expected_digest in sources.items():
    url = f"https://raw.githubusercontent.com/atx/wtype/{revision}/{name}"
    with urllib.request.urlopen(url, timeout=30) as response:
        contents = response.read()

    if hashlib.sha256(contents).hexdigest() != expected_digest:
        raise SystemExit(f"Upstream source digest mismatch: {name}")

    (directory / Path(name).name).write_bytes(contents)

patch = Path(__file__).with_name("printable-keycodes.patch")
subprocess.run(["patch", "--batch", "-p1", "-i", str(patch)], cwd=directory, check=True)

protocol = "virtual-keyboard-unstable-v1"
for mode, output in [
    ("client-header", f"{protocol}-client-protocol.h"),
    ("private-code", f"{protocol}-protocol.c"),
]:
    subprocess.run(["wayland-scanner", mode, f"{protocol}.xml", output], cwd=directory, check=True)

flags = subprocess.check_output(
    ["pkg-config", "--cflags", "--libs", "wayland-client", "xkbcommon"], text=True,
)
subprocess.run(
    ["cc", "-O2", "main.c", f"{protocol}-protocol.c", "-o", "wtype", *shlex.split(flags)],
    cwd=directory, check=True,
)
print(f"Built {directory / 'wtype'}; nothing installed")
