#!/usr/bin/env python3
"""Explicit desktop test; keep keyboard/mouse idle. Uses temporary snippets/settings."""
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


class TuiSmoke(desktop.Smoke):
    def keys(self, expected_class, *arguments):
        active = json.loads(self.command("hyprctl", "-j", "activewindow"))
        if active.get("class") != expected_class:
            raise RuntimeError("Test window lost focus; input aborted")
        self.command("wtype", *arguments)
        time.sleep(0.1)

    def type(self, expected_class, text):
        subprocess.run([str(self.root / "target/debug/examples/send_keys"), text, expected_class], check=True, timeout=15)

    def run(self):
        original = json.loads(self.command("hyprctl", "-j", "activewindow")).get("address")
        service_active = subprocess.run(["systemctl", "--user", "is-active", "typerelay"], capture_output=True).returncode == 0
        espanso = subprocess.run(["espanso", "status"], capture_output=True, text=True)
        espanso_active = espanso.returncode == 0 and "is running" in espanso.stdout
        client = None
        with tempfile.TemporaryDirectory(prefix="typerelay-tui-smoke-") as temporary:
            directory = pathlib.Path(temporary)
            snippets = directory / "typerelay/snippets"
            snippets.mkdir(parents=True)
            source = snippets / "test.yml"
            source.write_text("# Preserve this comment\nmatches:\n  - trigger: ',brb'\n    replace: 'Be right back.'\n")
            try:
                if service_active:
                    self.command("systemctl", "--user", "stop", "typerelay")
                if espanso_active:
                    self.command("espanso", "stop")
                log = (directory / "client.log").open("w+")
                client = self.start(str(self.root / "target/debug/typerelay"), "run", "--dir", str(snippets), stdout=log, stderr=log)
                time.sleep(0.6)
                if client.poll() is not None:
                    raise RuntimeError((directory / "client.log").read_text())
                environment = {**os.environ, "XDG_CONFIG_HOME": str(directory)}
                tui = self.start("foot", "--app-id=org.omarchy.typerelay-tui-smoke", "--title=TypeRelay TUI Test", str(self.root / "target/debug/typerelay-tui"), "--dir", str(snippets), env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                identity = self.focus("TypeRelay TUI Test")
                time.sleep(0.4)
                self.keys(identity, "-k", "Down", "-k", "Return", "-k", "F2")
                self.type(identity, "edited")
                self.keys(identity, "-k", "Tab")
                self.type(identity, ",brb next")
                self.keys(identity, "-M", "ctrl", "-k", "s", "-m", "ctrl")
                text = source.read_text()
                assert '"replace":",brb next"' in text or '"replace": ",brb next"' in text, text
                assert "# Preserve this comment" in text
                print("PASS TUI add/save: expansion suppressed only in editor; comment preserved", flush=True)

                self.keys(identity, "-k", "slash")
                self.type(identity, "next")
                self.keys(identity, "-k", "Return", "-k", "Return", "-k", "Tab", "-k", "End", "-k", "Return")
                self.type(identity, "second")
                self.keys(identity, "-M", "ctrl", "-k", "s", "-m", "ctrl")
                assert ",brb next\\nsecond" in source.read_text(), source.read_text()
                print("PASS TUI search/edit: multiline content saved exactly", flush=True)

                self.keys(identity, "-k", "F6")
                self.keys(identity, "https://example.invalid/sync")
                self.keys(identity, "-M", "ctrl", "-k", "s", "-m", "ctrl", "-k", "F5")
                assert "https://example.invalid/sync" in (directory / "typerelay/settings.yml").read_text()
                print("PASS Settings saved; disabled Sync leaves snippet files unchanged", flush=True)

                output = directory / "other-window.txt"
                gtk = self.start(sys.executable, str(self.root / "scripts/desktop-smoke.py"), "--fixture", "gtk", "--output", str(output))
                other = self.focus("TypeRelay GTK Test")
                self.type(other, ",brb ")
                time.sleep(0.3)
                assert output.read_text() == "Be right back.", output.read_text()
                print("PASS expansion remains enabled in another app while TUI is open", flush=True)
                gtk.terminate()
                gtk.wait(timeout=5)
                self.focus("TypeRelay TUI Test")
                self.keys(identity, "-M", "ctrl", "-k", "q", "-m", "ctrl")
                tui.wait(timeout=5)
                print("PASS clean TUI exit", flush=True)
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
                            child.kill()
                            child.wait(timeout=3)
                if service_active:
                    self.command("systemctl", "--user", "start", "typerelay")
                elif espanso_active:
                    self.command("espanso", "start")
                if original:
                    self.command("hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({window = ' + json.dumps("address:" + original) + '}))')


if __name__ == "__main__":
    TuiSmoke().run()
