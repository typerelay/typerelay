import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest


class LinuxUpgradeQATests(unittest.TestCase):
    def test_rejects_candidate_before_touching_guests(self):
        runner = pathlib.Path(__file__).resolve().parents[1] / "linux-upgrade-qa" / "run.mjs"
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            cache = root / "guest-cache"
            packages = []
            for kind, extension in (("appimage", "AppImage"), ("deb", "deb"), ("rpm", "rpm")):
                path = root / f"TypeRelay.{extension}"
                path.write_bytes(b"candidate")
                packages.append(dict(
                    target=f"linux-x86_64-{kind}",
                    name=path.name,
                    filePath=str(path),
                    sha256=hashlib.sha256(b"candidate").hexdigest(),
                ))

            duplicate = [packages[0], packages[1], packages[1]]
            changed = [dict(packages[0], sha256="0" * 64), *packages[1:]]
            for candidate, message in ((duplicate, "repeated"), (changed, "does not match")):
                with self.subTest(message=message):
                    result = subprocess.run(
                        ["node", runner],
                        input=json.dumps(dict(version="1.4.4", packages=candidate)),
                        env=dict(os.environ, TYPERELAY_LINUX_QA_DIR=str(cache)),
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(cache.exists())
