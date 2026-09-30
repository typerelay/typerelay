import fcntl
import hashlib
import io
import json
import os
import pathlib
import pty
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import termios
import unittest


class InstallBootstrapTests(unittest.TestCase):
    script = pathlib.Path(__file__).resolve().parents[1] / "install.sh"
    version = "9.8.7"
    commit = "a" * 40
    feed = "https://transfer.typerelay.com/apps"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="typerelay-bootstrap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.files = self.root / "files"
        self.bin = self.root / "bin"
        self.tmp = self.root / "tmp"
        for directory in (self.files, self.bin, self.tmp):
            directory.mkdir()
        self.environment = {**os.environ, "PATH": f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": str(self.tmp), "TYPERELAY_TEST_FILES": str(self.files), "TYPERELAY_TEST_LOG": str(self.root / "install.json"), "TYPERELAY_TEST_DOWNLOADS": str(self.root / "downloads.log")}
        self.environment.pop("TYPERELAY_TEST_CURL_FAIL", None)
        self.executable("uname", '#!/bin/sh\nif [ "$1" = -m ]; then printf "%s\\n" "${TYPERELAY_TEST_ARCH:-x86_64}"; else printf "%s\\n" "${TYPERELAY_TEST_OS:-Linux}"; fi\n')
        self.executable("id", '#!/bin/sh\nprintf "%s\\n" "${TYPERELAY_TEST_UID:-1000}"\n')
        (self.bin / "python3").symlink_to(sys.executable)
        self.executable("curl", f'''#!{sys.executable}
import os, pathlib, shutil, sys, urllib.parse
args = sys.argv[1:]
url = next(item for item in args if item.startswith("https://"))
with open(os.environ["TYPERELAY_TEST_DOWNLOADS"], "a") as log:
    log.write(url + "\\n")
if os.environ.get("TYPERELAY_TEST_CURL_FAIL") in (url, "all"):
    sys.exit(22)
output = args[args.index("-o") + 1] if "-o" in args else args[args.index("-fsSLo") + 1]
name = "commit.json" if "/commits/" in url else "source.tar.gz" if "/tarball/" in url else pathlib.PurePosixPath(urllib.parse.urlsplit(url).path).name
source = pathlib.Path(os.environ["TYPERELAY_TEST_FILES"]) / name
if not source.is_file():
    sys.exit(22)
shutil.copyfile(source, output)
''')
        self.executable("gh", "#!/bin/sh\nexit 1\n")
        self.executable("cargo", f'''#!{sys.executable}
import os, pathlib, shutil, sys
args = sys.argv[1:]
assert "--locked" in args
target = pathlib.Path(args[args.index("--target-dir") + 1]) / "release"
target.mkdir(parents=True)
for name in ("typerelay", "typerelay-tui"):
    shutil.copy2(pathlib.Path(os.environ["TYPERELAY_TEST_FILES"]) / name, target / name)
''')
        shutil.copyfile(self.script, self.files / "install.sh")
        self.archive_name = f"TypeRelay-Omarchy-{self.version}-x86_64.tar.gz"
        self.latest = {"version": self.version, "platforms": {"linux-x86_64": {"url": f"{self.feed}/{self.archive_name}", "signature": "fixture-signature"}}}
        self.release = {"version": self.version, "target": "linux-x86_64", "updater": self.latest["platforms"]["linux-x86_64"].copy(), "artifacts": []}
        self.bundle()
        self.metadata()

    def executable(self, name, content):
        file = self.bin / name
        file.write_text(content)
        file.chmod(0o755)

    def bundle(self, members=None):
        members = members or ["typerelay", "typerelay-tui", "typerelay-panel"]
        with tarfile.open(self.files / self.archive_name, "w:gz") as archive:
            for name in members:
                content = f'''#!{sys.executable}
import json, os, pathlib, sys
if sys.argv[1:] == ["--version"]:
    print("{name} {self.version}")
else:
    pathlib.Path(os.environ["TYPERELAY_TEST_LOG"]).write_text(json.dumps({{"args": sys.argv[1:], "panel": pathlib.Path(__file__).with_name("typerelay-panel").is_file(), "tty": sys.stdin.isatty()}}))
'''.encode()
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o755
                archive.addfile(info, io.BytesIO(content))
                if name in {"typerelay", "typerelay-tui", "typerelay-panel"}:
                    file = self.files / name
                    file.write_bytes(content)
                    file.chmod(0o755)
        content = (self.files / self.archive_name).read_bytes()
        self.release["artifacts"] = [{"name": self.archive_name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}]

    def metadata(self):
        (self.files / "latest.json").write_text(json.dumps(self.latest))
        (self.files / f"TypeRelay-{self.version}-linux-x86_64.json").write_text(json.dumps(self.release))

    @staticmethod
    def terminal_session():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    def run_script(self, *args, terminal=False):
        master, slave = pty.openpty() if terminal else (None, None)
        try:
            result = subprocess.run(["/bin/sh", str(self.script), *args], env=self.environment, stdin=slave if terminal else subprocess.DEVNULL, preexec_fn=self.terminal_session if terminal else None, capture_output=True, text=True, timeout=15)
        finally:
            if terminal:
                os.close(master)
                os.close(slave)
        self.assertEqual(list(self.tmp.iterdir()), [], "Bootstrap must clean temporary downloads on success and failure")
        return result

    def installed(self):
        return json.loads((self.root / "install.json").read_text())

    def test_prebuilt_dry_run_downloads_one_matching_bundle_without_building(self):
        self.executable("cargo", "#!/bin/sh\nexit 99\n")
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), {"args": ["install", "--dry-run"], "panel": True, "tty": False})
        self.assertIn("checksum verified", result.stdout)
        self.assertEqual((self.root / "downloads.log").read_text().splitlines(), [f"{self.feed}/latest.json", f"{self.feed}/TypeRelay-{self.version}-linux-x86_64.json", f"{self.feed}/{self.archive_name}"])

    def test_install_starts_interactive_installer_on_the_controlling_terminal(self):
        result = self.run_script(terminal=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), {"args": ["install"], "panel": True, "tty": True})

    def test_without_panel_reuses_the_verified_prebuilt_bundle(self):
        result = self.run_script("--dry-run", "--without-panel")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.installed()["panel"])

    def test_corrupt_download_or_wrong_size_never_starts_installation(self):
        for field, value in (("sha256", "0" * 64), ("size", 1)):
            with self.subTest(field=field):
                original = self.release["artifacts"][0][field]
                self.release["artifacts"][0][field] = value
                self.metadata()
                result = self.run_script("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("checksum or size mismatch", result.stderr)
                self.assertFalse((self.root / "install.json").exists())
                self.release["artifacts"][0][field] = original

    def test_release_metadata_must_match_the_latest_version_target_and_signature(self):
        for field, value in (("version", "1.0.0"), ("target", "windows-x86_64"), ("updater", {**self.release["updater"], "signature": "different"})):
            with self.subTest(field=field):
                original = self.release[field]
                self.release[field] = value
                self.metadata()
                result = self.run_script("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("metadata does not match", result.stderr)
                self.assertFalse((self.root / "install.json").exists())
                self.release[field] = original

    def test_missing_linux_release_and_untrusted_download_urls_are_rejected(self):
        for platforms in ({}, {"linux-x86_64": {"url": "https://example.invalid/bundle.tar.gz", "signature": "fixture"}}):
            with self.subTest(platforms=platforms):
                self.latest["platforms"] = platforms
                self.metadata()
                result = self.run_script("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("no valid Omarchy/Linux", result.stderr)
                self.assertFalse((self.root / "install.json").exists())

    def test_missing_duplicate_and_traversal_archive_entries_are_rejected(self):
        for members in (["typerelay", "typerelay-tui"], ["typerelay", "typerelay", "typerelay-panel"], ["typerelay", "typerelay-tui", "../escaped"]):
            with self.subTest(members=members):
                self.bundle(members)
                self.metadata()
                result = self.run_script("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Invalid Linux bundle", result.stderr)
                self.assertFalse((self.root / "install.json").exists())
                self.assertFalse((self.tmp / "escaped").exists())

    def test_unsupported_platform_root_and_missing_terminal_fail_before_downloading(self):
        for key, value, message in (("TYPERELAY_TEST_OS", "Darwin", "Omarchy/Linux only"), ("TYPERELAY_TEST_ARCH", "aarch64", "require x86_64"), ("TYPERELAY_TEST_UID", "0", "not root")):
            with self.subTest(key=key):
                self.environment[key] = value
                result = self.run_script("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / "downloads.log").exists())
                del self.environment[key]
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("interactive terminal is required", result.stderr)

    def test_explicit_ref_preserves_the_locked_source_build(self):
        (self.files / "commit.json").write_text(json.dumps({"sha": self.commit}))
        with tarfile.open(self.files / "source.tar.gz", "w:gz") as archive:
            info = tarfile.TarInfo("source/Cargo.toml")
            info.size = 0
            archive.addfile(info, io.BytesIO())
        result = self.run_script("--ref", "fixture/tag", "--without-panel", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), {"args": ["install", "--dry-run"], "panel": False, "tty": False})
        self.assertEqual((self.root / "downloads.log").read_text().splitlines(), ["https://api.github.com/repos/typerelay/typerelay/commits/fixture%2Ftag", f"https://api.github.com/repos/typerelay/typerelay/tarball/{self.commit}"])

    def test_readme_command_runs_in_fish_bash_and_zsh_and_stops_on_download_failure(self):
        readme = (self.script.parent.parent / "README.md").read_text()
        command = re.search(r"^curl .+ && sh .+$", readme, re.MULTILINE).group(0)
        installer = self.root / "downloaded-install.sh"
        command = command.replace("/tmp/typerelay-install.sh", shlex.quote(str(installer))) + " --dry-run"
        source_url = "https://raw.githubusercontent.com/typerelay/typerelay/main/scripts/install.sh"
        for name, options in (("fish", ["--no-config"]), ("bash", ["--noprofile", "--norc"]), ("zsh", ["-f"])):
            with self.subTest(shell=name):
                shell = shutil.which(name)
                self.assertIsNotNone(shell, f"{name} is required for the shell compatibility check")
                result = subprocess.run([shell, *options, "-c", command], env=self.environment, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.installed()["args"], ["install", "--dry-run"])
                (self.root / "install.json").unlink()
                self.environment["TYPERELAY_TEST_CURL_FAIL"] = source_url
                result = subprocess.run([shell, *options, "-c", command], env=self.environment, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "install.json").exists(), "A failed curl must not run a stale installer")
                del self.environment["TYPERELAY_TEST_CURL_FAIL"]


if __name__ == "__main__":
    unittest.main()
