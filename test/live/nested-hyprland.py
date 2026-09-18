"""Own a disposable nested compositor for the quick-tap regression.

No user config is loaded. A private runtime directory isolates its sockets and
clients; environment import and systemd notifications are disabled. Killing this
process cleans up all its bindings, avoiding expired Lua handles in Hyprland.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

repository = Path(__file__).resolve().parents[2]
parent_runtime = os.environ["XDG_RUNTIME_DIR"]
parent_display = os.environ["WAYLAND_DISPLAY"]

# Hyprland's long instance signature leaves little space in a UNIX socket path.
with tempfile.TemporaryDirectory(prefix="cq-") as temporary:
    directory = Path(temporary)
    config = directory / "hyprland.lua"
    config.write_text('''
hl.monitor({ output = "", mode = "1280x800@60", position = "0x0", scale = 1 })
hl.config({
  animations = { enabled = false },
  misc = { disable_hyprland_logo = true, disable_splash_rendering = true },
  input = { follow_mouse = 0 },
})
''')
    environment = {
        **os.environ,
        "XDG_RUNTIME_DIR": temporary,
        "WAYLAND_DISPLAY": str(Path(parent_runtime) / parent_display),
        "HYPRLAND_NO_SD_VARS": "1",
        "HYPRLAND_NO_SD_NOTIFY": "1",
        # Force the Wayland backend. The fixture must never acquire a physical
        # display or input device from the user's session.
        "AQ_DRM_DEVICES": "/dev/nonexistent-companion-test",
        "LIBSEAT_BACKEND": "noop",
    }
    environment.pop("HYPRLAND_INSTANCE_SIGNATURE", None)
    with (directory / "hyprland.log").open("w") as log:
        compositor = subprocess.Popen(
            ["Hyprland", "--config", str(config)],
            env=environment, stdout=log, stderr=log, start_new_session=True,
        )
        try:
            for attempt in range(100):
                sockets = list((directory / "hypr").glob("*/.socket.sock"))
                displays = [p for p in directory.glob("wayland-*") if not p.name.endswith(".lock")]
                if sockets and displays:
                    break
                if compositor.poll() is not None:
                    raise RuntimeError("Nested Hyprland exited during startup")
                time.sleep(0.1)
            else:
                raise RuntimeError("Timed out starting nested Hyprland")

            environment["HYPRLAND_INSTANCE_SIGNATURE"] = sockets[0].parent.name
            environment["WAYLAND_DISPLAY"] = displays[0].name
            environment["COMPANION_TEST_NESTED"] = "1"
            test_process = subprocess.Popen(
                ["node", "--import", "tsx", *(sys.argv[1:] or ["test/live/quick-tap.ts"])],
                cwd=repository, env=environment, start_new_session=True,
            )
            try:
                raise SystemExit(test_process.wait(timeout=70))
            finally:
                # Also reap any GUI helper left behind by an interrupted test.
                try:
                    os.killpg(test_process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                test_process.wait(timeout=5)
        except (RuntimeError, subprocess.TimeoutExpired):
            print((directory / "hyprland.log").read_text()[-6000:])
            raise
        finally:
            if compositor.poll() is None:
                os.killpg(compositor.pid, signal.SIGTERM)
                try:
                    compositor.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(compositor.pid, signal.SIGKILL)
                    compositor.wait()
