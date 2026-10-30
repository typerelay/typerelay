import contextlib
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGET = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target")) / "debug"
CLI = pathlib.Path(os.environ.get("TYPERELAY_CLI", TARGET / "typerelay"))
TUI = pathlib.Path(os.environ.get("TYPERELAY_TUI", TARGET / "typerelay-tui"))


class TuiAppTests(unittest.TestCase):
    def setUp(self):
        if not CLI.is_file() or not TUI.is_file():
            self.skipTest("Build typerelay and typerelay-tui, or set TYPERELAY_CLI and TYPERELAY_TUI")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = dict(os.environ, XDG_CONFIG_HOME=self.temp.name, TERM="xterm-256color")
        self.directory = pathlib.Path(self.temp.name) / "typerelay" / "snippets"
        source = pathlib.Path(self.temp.name) / "seed.yml"
        source.write_text('matches:\n  - trigger: seed\n    replace: Original\n')
        subprocess.run([str(CLI), "import", "yaml", str(source), "--name", "Seed"], env=self.env, check=True, capture_output=True, timeout=15)

    def launch(self, rows=30, cols=100):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        process = subprocess.Popen([str(TUI), "--dir", str(self.directory)], env=self.env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.addCleanup(self.stop, process, master)
        self.master = master
        return process, master

    @staticmethod
    def stop(process, master):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        try:
            os.close(master)
        except OSError:
            pass

    def wait_for(self, predicate, message, drain=True):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            if drain and select.select([self.master], [], [], 0)[0]:
                try:
                    os.read(self.master, 65536)
                except OSError:
                    pass
            time.sleep(0.02)
        self.fail(message)

    def screen(self, process, master, text):
        output = bytearray()
        def seen():
            if select.select([master], [], [], 0)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
            if process.poll() is not None:
                self.fail(f"TUI exited {process.returncode}: {output[-2000:]!r}")
            plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)
            return text.replace(" ", "").encode() in plain.replace(b" ", b"")
        try:
            self.wait_for(seen, f"Missing {text!r} in terminal output", drain=False)
        except AssertionError as error:
            self.fail(f"{error}: {output[-2000:]!r}")

    def drafts(self):
        with contextlib.closing(sqlite3.connect(self.directory / "typerelay.sqlite")) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tui_drafts'").fetchone():
                return []
            return [json.loads(row[0]) for row in db.execute("SELECT data FROM tui_drafts")]

    def test_killed_editor_recovers_and_saves_once(self):
        process, master = self.launch()
        self.screen(process, master, "Seed")
        os.write(master, b"\x1b[B\r")
        self.screen(process, master, "Original")
        os.write(master, b"\r")
        self.screen(process, master, "Abbreviation")
        os.write(master, b"\tX")
        self.wait_for(lambda: any("X" in draft["entry"]["replace"] for draft in self.drafts()), "Edit was not persisted")
        process.kill()
        process.wait(timeout=3)
        process, master = self.launch()
        self.screen(process, master, "Drafts")
        self.assertEqual(len(self.drafts()), 1)
        os.write(master, b"s")
        self.wait_for(lambda: not self.drafts(), "Saved draft was not removed")
        os.write(master, b"\x11")
        self.assertEqual(process.wait(timeout=5), 0)
        exported = pathlib.Path(self.temp.name) / "export.yml"
        subprocess.run([str(CLI), "export", "Seed", str(exported)], env=self.env, check=True, capture_output=True, timeout=15)
        contents = exported.read_text()
        self.assertEqual(contents.count("trigger: seed"), 1)
        self.assertIn("X", contents)


    def test_small_terminal_quit_after_rejected_save_keeps_draft(self):
        process, master = self.launch()
        self.screen(process, master, "Seed")
        os.write(master, b"\x1b[B\r")
        self.screen(process, master, "snippets")
        os.write(master, b"\x1b[12~seed\tNew text")
        self.wait_for(lambda: any(draft["entry"]["replace"] == "New text" for draft in self.drafts()), "New draft was not persisted")
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 10, 40, 0, 0))
        process.send_signal(signal.SIGWINCH)
        os.write(master, b"\x13")
        self.screen(process, master, "Duplicate trigger")
        os.write(master, b"\x11")
        self.screen(process, master, "Discard")
        os.write(master, b"q")
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(len(self.drafts()), 1)
        process, master = self.launch(rows=10, cols=40)
        self.screen(process, master, "Drafts")
        os.write(master, b"\r")
        self.screen(process, master, "Draft resumed")
        os.write(master, b"\x13")
        self.screen(process, master, "uplicate trigger")
        os.write(master, b"\x11")
        self.screen(process, master, "Discard")
        os.write(master, b"d")
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(len(self.drafts()), 0)


if __name__ == "__main__":
    unittest.main()
