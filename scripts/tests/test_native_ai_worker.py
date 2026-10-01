"""Native IPC tests. Build with cargo build --features ai-runtime --bin typerelay-ai."""
import json
import pathlib
import socket
import struct
import subprocess
import tempfile
import time
import unittest


class NativeWorkerTests(unittest.TestCase):
    binary = pathlib.Path(__file__).resolve().parents[2] / "target/debug/typerelay-ai"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="typerelay-ai-test-")
        self.root = pathlib.Path(self.temporary.name)
        self.worker = subprocess.Popen([str(self.binary), "--root", str(self.root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.cleanup_worker)
        endpoint = self.root / "native-ai/endpoint.json"
        for _ in range(100):
            if endpoint.exists():
                self.endpoint = json.loads(endpoint.read_text())
                break
            if self.worker.poll() is not None:
                self.fail("Worker exited before publishing endpoint")
            time.sleep(0.05)
        else:
            self.fail("Worker did not start")

    def cleanup_worker(self):
        if self.worker.poll() is None:
            self.worker.terminate()
            self.worker.wait(timeout=10)
        self.temporary.cleanup()

    def request(self, **request):
        request.setdefault("token", self.endpoint["token"])
        address, port = self.endpoint["address"].rsplit(":", 1)
        with socket.create_connection((address, int(port)), timeout=5) as connection:
            body = json.dumps(request).encode()
            connection.sendall(struct.pack(">I", len(body)) + body)
            with connection.makefile("rb") as reader:
                length = reader.read(4)
                if not length:
                    return None
                return json.loads(reader.read(struct.unpack(">I", length)[0]))

    def test_default_disabled_no_model_or_remote_account_required(self):
        status = self.request(op="status")["value"]
        self.assertIsNone(status["model"])
        self.assertEqual(len(status["models"]), 3)
        self.assertTrue(all(not model["installed"] for model in status["models"]))
        self.assertEqual(list((self.root / "native-ai").glob("*.gguf")), [])

    def test_enable_preference_survives_without_a_downloaded_model(self):
        self.assertFalse(self.request(op="status")["value"]["enabled"])
        self.assertIn("value", self.request(op="enable"))
        status = self.request(op="status")["value"]
        self.assertTrue(status["enabled"])
        self.assertIsNone(status["model"])
        self.assertTrue(json.loads((self.root / "native-ai/settings.json").read_text())["enabled"])
        self.assertIn("value", self.request(op="disable"))
        self.assertFalse(self.request(op="status")["value"]["enabled"])

    def test_legacy_enabled_model_preserves_checkbox_state(self):
        (self.root / "native-ai/settings.json").write_text(json.dumps({"model": "qwen3.5-4b-gguf"}))
        self.assertTrue(self.request(op="status")["value"]["enabled"])

    def test_second_worker_exits_and_cannot_replace_owner(self):
        second = subprocess.run([str(self.binary), "--root", str(self.root)], timeout=5, capture_output=True)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(json.loads((self.root / "native-ai/endpoint.json").read_text()), self.endpoint)
        self.assertIsNone(self.worker.poll())
        self.assertIn("models", self.request(op="status")["value"])

    def test_invalid_token_is_rejected_and_worker_survives(self):
        self.assertIsNone(self.request(op="status", token="incorrect"))
        self.assertIn("value", self.request(op="status"))

    def test_cancellation_before_request_arrival_is_honored(self):
        self.request(op="cancel", id="superseded")
        result = self.request(op="infer", kind="search", id="superseded", prompt="query")
        self.assertEqual(result["error"], "Cancelled")
        self.assertEqual(self.request(op="infer", kind="search", id="next", prompt="query")["error"], "AI is disabled")

    def test_corrupt_model_cannot_be_enabled(self):
        model = self.request(op="status")["value"]["models"][0]
        (self.root / "native-ai" / (model["id"] + ".gguf")).write_bytes(b"corrupt")
        self.assertIn("error", self.request(op="enable", model=model["id"]))
        self.assertIsNone(self.request(op="status")["value"]["model"])

    def test_shutdown_releases_process_for_native_update(self):
        self.assertIn("value", self.request(op="shutdown"))
        self.worker.wait(timeout=5)
        self.assertEqual(self.worker.returncode, 0)


if __name__ == "__main__":
    unittest.main()
