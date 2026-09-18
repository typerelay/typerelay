import fcntl
import os
import pathlib
import pty
import signal
import struct
import subprocess
import termios
import time
import unittest


class TerminalTests(unittest.TestCase):
    def launch(self):
        binary = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", pathlib.Path(__file__).resolve().parents[2] / "target")) / "debug/examples/tui_terminal_probe"
        if not binary.exists():
            self.skipTest("Build examples first: cargo build --examples")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        before = termios.tcgetattr(slave)
        process = subprocess.Popen([str(binary)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        self.addCleanup(self.stop, process)
        self.addCleanup(os.close, slave)
        time.sleep(0.3)
        self.assertIsNone(process.poll(), "Probe failed to initialize")
        return process, master, slave, before

    def stop(self, process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)

    def ticks(self, pid):
        fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[11]) + int(fields[12])

    def test_idle_cpu_and_terminal_disconnect_exit(self):
        process, master, _, _ = self.launch()
        try:
            start = self.ticks(process.pid)
            time.sleep(1)
            cpu_seconds = (self.ticks(process.pid) - start) / os.sysconf("SC_CLK_TCK")
            self.assertLess(cpu_seconds, 0.03, "Idle reader is busy-looping")
        finally:
            os.close(master)
        self.assertEqual(process.wait(timeout=2), 0)

    def test_disconnect_during_incomplete_escape_sequence(self):
        process, master, _, _ = self.launch()
        os.write(master, b"\x1b[")
        time.sleep(0.02)
        os.close(master)
        self.assertEqual(process.wait(timeout=2), 0)

    def test_normal_quit_restores_terminal_mode(self):
        process, master, slave, before = self.launch()
        try:
            os.write(master, b"q")
            self.assertEqual(process.wait(timeout=2), 0)
            self.assertEqual(termios.tcgetattr(slave), before)
        finally:
            os.close(master)

    def test_hangup_signal_exits_cleanly(self):
        process, master, _, _ = self.launch()
        try:
            process.send_signal(signal.SIGHUP)
            self.assertEqual(process.wait(timeout=2), 0)
        finally:
            os.close(master)

    def test_signal_exits_and_restores_terminal_mode(self):
        process, master, slave, before = self.launch()
        try:
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=2), 0)
            self.assertEqual(termios.tcgetattr(slave), before)
        finally:
            os.close(master)


if __name__ == "__main__":
    unittest.main()
