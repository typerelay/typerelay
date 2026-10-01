"""Explicit local model verification; isolated profile, never changes user's AI settings.

macOS example: python3 scripts/tests/benchmark_native_ai.py --download --model qwen3.5-2b-gguf
Requires a release worker. Inference denies non-loopback networking via sandbox-exec.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request


class Benchmark:
    def __init__(self, options):
        self.options = options
        self.repo = pathlib.Path(__file__).resolve().parents[2]
        self.prompts = json.loads((self.repo / "crates/client/src/ai-prompts.json").read_text())
        self.catalog = json.loads((self.repo / "crates/client/src/ai-models.json").read_text())
        self.root = pathlib.Path(tempfile.gettempdir()) / "typerelay-ai-verification"
        self.directory = self.root / "native-ai"
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)

    def request(self, **request):
        request["token"] = self.endpoint["token"]
        host, port = self.endpoint["address"].rsplit(":", 1)
        with socket.create_connection((host, int(port)), timeout=180) as connection:
            body = json.dumps(request).encode()
            connection.sendall(struct.pack(">I", len(body)) + body)
            with connection.makefile("rb") as reader:
                header = reader.read(4)
                if len(header) != 4:
                    raise RuntimeError("Worker exited during inference")
                result = json.loads(reader.read(struct.unpack(">I", header)[0]))
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result["value"]

    def run(self):
        reports = []
        for model in self.catalog:
            if self.options.model and self.options.model != model["id"]:
                continue
            path = self.directory / (model["id"] + ".gguf")
            if not path.exists():
                if not self.options.download:
                    raise RuntimeError("Missing model; pass --download to explicitly fetch the benchmark fixture")
                url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{model["filename"]}'
                partial = path.with_suffix(".fixture")
                with urllib.request.urlopen(url, timeout=30) as response, partial.open("wb") as output:
                    shutil.copyfileobj(response, output)
                partial.rename(path)
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if path.stat().st_size != model["bytes"] or digest != model["sha256"]:
                raise RuntimeError("Corrupt benchmark fixture")
            (self.directory / "settings.json").write_text(json.dumps({"model": model["id"]}))
            endpoint = self.directory / "endpoint.json"
            endpoint.unlink(missing_ok=True)
            profile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
            command = ["sandbox-exec", "-p", profile, str(pathlib.Path(self.options.worker).resolve()), "--root", str(self.root)]
            if self.options.cpu:
                command.append("--cpu")
            with (self.root / "worker.log").open("w") as log:
                worker = subprocess.Popen(command, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        if endpoint.exists():
                            break
                        if worker.poll() is not None:
                            raise RuntimeError("Worker failed to start")
                        time.sleep(0.05)
                    self.endpoint = json.loads(endpoint.read_text())
                    start = time.monotonic()
                    search = self.request(op="infer", kind="search", id="search", prompt=self.prompts["search"]+"\nInput: "+json.dumps({"query":"find the message about returning a damaged product"}))
                    cold_seconds = time.monotonic() - start
                    start = time.monotonic()
                    author = self.request(op="infer", kind="author", id="author", prompt=self.prompts["author"]+"\nInput: "+json.dumps({"instruction":"Improve. Make the greeting warmer.","snippet":"Hello {{name}}, we received your message.","content_type":"template"}))
                    warm_seconds = time.monotonic() - start
                    rss = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(worker.pid)], text=True).strip())
                    report = {"routing_pass": search["intent"]=="descriptive" and bool(search["terms"]), "protected_draft_pass":author["text"].count("{{name}}")==1, "model": model["name"], "cpu_only": self.options.cpu, "cold_search_seconds": round(cold_seconds, 2), "warm_draft_seconds": round(warm_seconds, 2), "process_rss_bytes": rss * 1024, "external_network": "denied", "search": search, "draft": author}
                    if self.options.idle:
                        for _ in range(6):
                            time.sleep(50)
                        time.sleep(2)
                        assert self.request(op="status")["loaded"] is None
                        report["idle_unload"] = "verified after 302 seconds"
                    reports.append(report)
                    print(json.dumps(report), flush=True)
                finally:
                    if worker.poll() is None:
                        worker.terminate()
                    worker.wait(timeout=10)
        return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--idle", action="store_true")
    parser.add_argument("--worker", default="target/aarch64-apple-darwin/release/typerelay-ai")
    Benchmark(parser.parse_args()).run()
