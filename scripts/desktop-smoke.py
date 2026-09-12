#!/usr/bin/env python3
"""Explicit live-desktop smoke test. Keep keyboard/mouse idle while this runs.

Uses disposable GTK/browser/terminal windows; restores Espanso and prior focus.
Dependencies: Python GObject/GTK4, chromium, foot, temporary device ACLs.
"""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time


class BrowserFixture(http.server.BaseHTTPRequestHandler):
    output = None

    def do_GET(self):
        body = b'<!doctype html><title>TypeRelay Browser Test</title><textarea id="field" autofocus rows="10" cols="80"></textarea><script>field.oninput=()=>fetch("/result",{method:"POST",body:field.value});</script>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.output.write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


class Smoke:
    def __init__(self):
        self.root = pathlib.Path(__file__).resolve().parents[1]
        self.children = []

    def command(self, *args):
        return subprocess.check_output(args, text=True).strip()

    def start(self, *args, **kwargs):
        child = subprocess.Popen(args, **kwargs)
        self.children.append(child)
        return child

    def focus(self, title):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            windows = json.loads(self.command("hyprctl", "-j", "clients"))
            found = next((w for w in windows if w["title"] == title), None)
            if found:
                selector = json.dumps("address:" + found["address"])
                self.command("hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({window = ' + selector + '}))')
                time.sleep(0.3)
                active = json.loads(self.command("hyprctl", "-j", "activewindow"))
                if active.get("address") == found["address"]:
                    return found["class"]
            time.sleep(0.1)
        raise RuntimeError("Disposable window failed to acquire focus: " + title)

    def check(self, output, expected_class):
        text = ",brb next ,brbmore ,hello ,unknown ,brx\bb ,symbols ,naf ,paragraphs after"
        expected = "Be right back.next I will be back a little later.Hello from TypeRelay!,unknown Be right back.Hello! (One + two) = 3; email@example.com / $5 #tagSincerely,\nNitai\nCeo & Founder\n\nFirst paragraph.\n\nSecond paragraph with a tab:\tCafé ☕\nafter"
        subprocess.run([str(self.root / "target/debug/examples/send_keys"), text, expected_class], check=True, timeout=20)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            actual = output.read_text() if output.exists() else ""
            if actual == expected:
                print(f"PASS {expected_class}: native expansion + multiline paste, blank lines, tabs, Unicode, trailing typing", flush=True)
                return
            time.sleep(0.1)
        raise AssertionError(f"{expected_class}: expected {expected!r}, got {actual!r}")

    def gtk(self, output):
        import gi
        gi.require_version("Gtk", "4.0")
        from gi.repository import Gtk

        class Window(Gtk.Application):
            def do_activate(self):
                window = Gtk.ApplicationWindow(application=self, title="TypeRelay GTK Test")
                entry = Gtk.TextView()
                buffer = entry.get_buffer()
                buffer.connect("changed", lambda b: output.write_text(b.get_text(b.get_start_iter(), b.get_end_iter(), True)))
                window.set_child(entry)
                window.set_default_size(700, 100)
                window.present()
                entry.grab_focus()

        Window(application_id="com.typerelay.Smoke").run([])

    def terminal(self, output):
        import termios
        import tty
        state = termios.tcgetattr(sys.stdin)
        text = ""
        in_paste = False
        escape = ""
        try:
            tty.setraw(sys.stdin.fileno())
            sys.stdout.write("\x1b[?2004h")
            sys.stdout.flush()
            while True:
                character = sys.stdin.read(1)
                if not character or character == "\x03":
                    break
                if character == "\x1b" or escape:
                    escape += character
                    if escape == "\x1b[200~":
                        in_paste = True
                        escape = ""
                    elif escape == "\x1b[201~":
                        in_paste = False
                        escape = ""
                    elif len(escape) > 6:
                        raise AssertionError("Unexpected terminal escape sequence")
                    continue
                if character in ("\r", "\n"):
                    assert in_paste, "Expansion sent an Enter key outside bracketed paste"
                    character = "\n"
                text = text[:-1] if character in ("\x7f", "\x08") else text + character
                output.write_text(text)
        finally:
            sys.stdout.write("\x1b[?2004l")
            sys.stdout.flush()
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, state)

    def run(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("--fixture", choices=["gtk", "terminal"])
        parser.add_argument("--output", type=pathlib.Path)
        args = parser.parse_args()
        if args.fixture:
            return getattr(self, args.fixture)(args.output)
        original = json.loads(self.command("hyprctl", "-j", "activewindow")).get("address")
        espanso_status = subprocess.run(["espanso", "status"], capture_output=True, text=True)
        espanso_running = espanso_status.returncode == 0 and "is running" in espanso_status.stdout
        clipboard = subprocess.run(["wl-paste", "--no-newline"], capture_output=True)
        before_clipboard = (clipboard.returncode, hashlib.sha256(clipboard.stdout).hexdigest())
        server = None
        client = None
        with tempfile.TemporaryDirectory(prefix="typerelay-smoke-") as temporary:
            directory = pathlib.Path(temporary)
            try:
                if espanso_running:
                    self.command("espanso", "stop")
                log = (directory / "client.log").open("w+")
                client = self.start(str(self.root / "target/debug/typerelay"), "run", "--file", str(self.root / "examples/matches.yml"), stdout=log, stderr=log, env={**os.environ, "XDG_CONFIG_HOME": str(directory / "config")})
                time.sleep(0.6)
                if client.poll() is not None:
                    raise RuntimeError((directory / "client.log").read_text())

                output = directory / "gtk.txt"
                gtk = self.start(sys.executable, __file__, "--fixture", "gtk", "--output", str(output))
                self.check(output, self.focus("TypeRelay GTK Test"))
                gtk.terminate()
                gtk.wait(timeout=5)

                output = directory / "browser.txt"
                BrowserFixture.output = output
                server = http.server.HTTPServer(("127.0.0.1", 0), BrowserFixture)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                browser = self.start("chromium", "--user-data-dir=" + str(directory / "browser"), "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--ozone-platform=wayland", "--app=http://127.0.0.1:" + str(server.server_port), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.check(output, self.focus("TypeRelay Browser Test"))
                browser.terminate()
                browser.wait(timeout=5)

                output = directory / "terminal.txt"
                terminal = self.start("foot", "--app-id=org.omarchy.typerelay-smoke", "--title=TypeRelay Terminal Test", sys.executable, __file__, "--fixture", "terminal", "--output", str(output), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.check(output, self.focus("TypeRelay Terminal Test"))
                terminal.terminate()
                terminal.wait(timeout=5)
                clipboard = subprocess.run(["wl-paste", "--no-newline"], capture_output=True)
                assert before_clipboard == (clipboard.returncode, hashlib.sha256(clipboard.stdout).hexdigest()), "Clipboard changed"
                print("PASS clipboard unchanged", flush=True)
            finally:
                if client and client.poll() is None:
                    client.send_signal(signal.SIGINT)
                    client.wait(timeout=5)
                for child in reversed(self.children):
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=5)
                if server:
                    server.shutdown()
                    server.server_close()
                if espanso_running:
                    self.command("espanso", "start")
                if original:
                    self.command("hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({window = ' + json.dumps("address:" + original) + '}))')


if __name__ == "__main__":
    Smoke().run()
