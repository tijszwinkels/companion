"""Send a generated red PNG to the explicitly selected model endpoint. No desktop capture."""

import argparse
import base64
import json
import os
from pathlib import Path
import struct
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import zlib

# The same reasoning-off field Companion's classifier sends for each
# llm.requestProfile (src/core/llm-request-profile.ts). Absent means local-qwen.
REASONING_OFF = {
    "local-qwen": {"chat_template_kwargs": {"enable_thinking": False, "preserve_thinking": True}},
    "groq": {"reasoning_effort": "none"},
    "openrouter": {"reasoning": {"enabled": False}},
}

# Some hosted endpoints (Groq's Cloudflare front) refuse Python's default
# "Python-urllib" User-Agent with HTTP 403, so name this script instead.
USER_AGENT = "companion-check-vision/1"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--config", required=True, type=Path)
args = parser.parse_args()
config = json.loads(args.config.read_text())["llm"]
url = config["baseUrl"].rstrip("/")
parsed = urlsplit(url)
if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
    parser.error("Use an HTTP(S) endpoint without embedded credentials, query or fragment")
profile = config.get("requestProfile", "local-qwen")
if not isinstance(profile, str) or profile not in REASONING_OFF:
    parser.error("llm.requestProfile must be one of: " + ", ".join(REASONING_OFF))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


# A 128 x 128 solid red RGB PNG, constructed without image-library dependencies.
png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", 128, 128, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\0\0" * 128) * 128))
png += chunk(b"IEND", b"")
payload = {
    "model": config["model"], "stream": False, "temperature": 0, "max_tokens": 32,
    **REASONING_OFF[profile],
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Name the dominant color in this image. Answer with one color word only."},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
    ]}],
}
request = urllib.request.Request(url + "/chat/completions", data=json.dumps(payload).encode(), headers={
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "Authorization": "Bearer " + os.environ.get("COMPANION_LLM_API_KEY", "local"),
})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Do not forward the credential to redirects or environment-configured proxies.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
print("Sending synthetic image to", url, "model", config["model"], "profile", profile, flush=True)
try:
    with opener.open(request, timeout=config.get("timeoutMs", 15000) / 1000) as response:
        reply = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(f"Endpoint returned HTTP {error.code}; check model, auth, profile and server logs") from None
choice = reply["choices"][0]
answer = choice["message"].get("content", "")
assert choice["finish_reason"] == "stop", "Reply did not finish normally"
assert isinstance(answer, str) and answer.strip().lower().rstrip(".! ") == "red", "Expected the color red"
print("PASS: endpoint accepted the inline image and answered red. This is not an intent-quality or tool-use test.")
