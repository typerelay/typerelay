import os
import pathlib
import subprocess
import tempfile
import unittest


class PanelIpcTests(unittest.TestCase):
    def test_isolated_requests_expire_and_full_notification_socket_never_blocks(self):
        binary = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", pathlib.Path(__file__).resolve().parents[2] / "target")) / "debug/examples/panel_ipc_probe"
        if not binary.exists():
            self.skipTest("Build examples first")
        with tempfile.TemporaryDirectory(prefix="typerelay-panel-ipc-") as directory:
            config = pathlib.Path(directory) / "config"
            runtime = pathlib.Path(directory) / "runtime"
            runtime.mkdir(mode=0o700)
            subprocess.run([str(binary)], env={**os.environ, "TYPERELAY_PANEL_PROBE": "1", "XDG_CONFIG_HOME": str(config), "XDG_RUNTIME_DIR": str(runtime)}, timeout=10, check=True, capture_output=True)
