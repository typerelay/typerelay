#!/usr/bin/env python3
"""Explicit live prefix reload test with disposable settings and snippet files."""
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("desktop_smoke", pathlib.Path(__file__).with_name("desktop-smoke.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class PrefixSmoke(desktop.Smoke):
    def run(self):
        original = json.loads(self.command("hyprctl", "-j", "activewindow")).get("address")
        service = subprocess.run(["systemctl", "--user", "is-active", "typerelay"], capture_output=True).returncode == 0
        client = None
        with tempfile.TemporaryDirectory(prefix="typerelay-prefix-smoke-") as temporary:
            directory = pathlib.Path(temporary)
            config = directory / "typerelay"
            snippets = config / "snippets"
            snippets.mkdir(parents=True)
            file = snippets / "test.yml"
            content = "matches:\n- trigger: brb\n  replace: 'Be right back.'\n"
            file.write_text(content)
            settings = config / "settings.yml"
            settings.write_text("trigger_prefix: ','\nsync_url: ''\n")
            try:
                if service:
                    self.command("systemctl", "--user", "stop", "typerelay")
                log = (directory / "engine.log").open("w+")
                client = self.start(str(self.root / "target/debug/typerelay"), "run", "--dir", str(snippets), env={**os.environ, "XDG_CONFIG_HOME": str(directory)}, stdout=log, stderr=log)
                time.sleep(0.6)
                if client.poll() is not None:
                    raise RuntimeError((directory / "engine.log").read_text())
                output = directory / "output.txt"
                self.start(sys.executable, str(self.root / "scripts/desktop-smoke.py"), "--fixture", "gtk", "--output", str(output))
                identity = self.focus("TypeRelay GTK Test")
                self.type_keys(identity, ",brb ")
                assert output.read_text() == "Be right back."
                settings.write_text("trigger_prefix: ';'\nsync_url: ''\n")
                time.sleep(0.7)
                self.type_keys(identity, ";brb ")
                assert output.read_text() == "Be right back.Be right back."
                self.type_keys(identity, ",brb ")
                assert output.read_text() == "Be right back.Be right back.,brb "
                assert file.read_text() == content
                print("PASS: comma expands, semicolon reloads live, old prefix stops expanding; snippet file unchanged", flush=True)
            finally:
                if client and client.poll() is None:
                    client.send_signal(signal.SIGINT)
                    client.wait(timeout=5)
                for child in reversed(self.children):
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            child.kill(); child.wait(timeout=3)
                if service:
                    self.command("systemctl", "--user", "start", "typerelay")
                if original:
                    self.command("hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({window = ' + json.dumps("address:" + original) + '}))')

    def type_keys(self, identity, text):
        subprocess.run([str(self.root / "target/debug/examples/send_keys"), text, identity], check=True, timeout=10)
        time.sleep(0.2)


if __name__ == "__main__":
    PrefixSmoke().run()
