import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("build_cache", Path(__file__).resolve().parents[1] / "prune-build-cache.py")
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class BuildCacheTests(unittest.TestCase):
    def test_trims_oldest_unlocked_profiles_and_preserves_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            target = root / "target"
            outside = root / "outside"
            outside.mkdir()
            sentinel = outside / "data"
            sentinel.write_text("keep")

            def profile(relative, age):
                directory = target / relative
                (directory / "deps").mkdir(parents=True)
                (directory / ".cargo-lock").touch()
                (directory / "typerelay-panel").write_text("binary")
                data = directory / "deps/output"
                data.write_bytes(os.urandom(128 * 1024))
                os.utime(data, (age, age))
                return directory

            active = profile("debug", 1)
            old = profile("x86_64-unknown-linux-gnu/release", 2)
            new = profile("release", 3)
            linked = target / "aarch64-apple-darwin"
            linked.symlink_to(outside, target_is_directory=True)
            (old / "build").symlink_to(outside, target_is_directory=True)
            (old / "deps/symlink").symlink_to(outside, target_is_directory=True)
            os.utime(old / "deps/symlink", (2, 2), follow_symlinks=False)

            limit = cache.disk_usage(target) - 64 * 1024
            cache.trim(target)
            self.assertTrue((old / "deps/output").is_file())
            with (target / ".typerelay-build-cleanup.lock").open("rb+") as cleanup:
                cache.lock_cargo_file(cleanup.fileno())
                cache.trim(target, limit)
                self.assertTrue((old / "deps/output").is_file())
            with (active / ".cargo-build-lock").open("wb") as lock:
                cache.lock_cargo_file(lock.fileno())
                cache.trim(target, limit)
                self.assertTrue((active / "deps/output").is_file())

            self.assertFalse((old / "deps").exists())
            self.assertTrue((old / "build").is_symlink())
            self.assertTrue(linked.is_symlink())
            self.assertEqual(sentinel.read_text(), "keep")
            self.assertTrue((new / "deps/output").is_file())
            self.assertEqual((old / "typerelay-panel").read_text(), "binary")
            self.assertTrue((old / ".cargo-lock").is_file())
            self.assertLessEqual(cache.disk_usage(target), limit)

    def test_symlinked_target_is_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            outside = root / "outside/release/deps"
            outside.mkdir(parents=True)
            (outside.parent / ".cargo-lock").touch()
            target = root / "target"
            target.symlink_to(root / "outside", target_is_directory=True)
            cache.trim(target, 0)
            self.assertTrue(outside.is_dir())

    def test_oversized_retained_artifacts_do_not_evict_the_latest_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for relative, built in (
                ("target", ("windows-test/release", "windows-test/x86_64-pc-windows-msvc/release")),
                ("apps/desktop/src-tauri/target", ("debug", "aarch64-apple-darwin/debug", "x86_64-apple-darwin/debug")),
            ):
                with self.subTest(target=relative):
                    target = root / relative
                    current = [target / name for name in built]
                    stale = target / "aarch64-unknown-linux-gnu/release"
                    for profile in [*current, stale]:
                        (profile / ".fingerprint").mkdir(parents=True)
                        (profile / ".cargo-lock").touch()
                        dep = profile / ".fingerprint/unchanged"
                        dep.write_text("compiler cache")
                        os.utime(dep, (1, 1))
                    artifact = target / "release/bundle/signed-package"
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    artifact.write_bytes(os.urandom(128 * 1024))
                    for _ in range(2):
                        cache.trim(target, 64 * 1024, protected_profiles=current)
                        self.assertGreater(cache.disk_usage(target), 64 * 1024)
                        self.assertTrue(artifact.is_file())
                        self.assertFalse((stale / ".fingerprint").exists())
                        for profile in current:
                            self.assertTrue((profile / ".fingerprint/unchanged").is_file())


if __name__ == "__main__":
    unittest.main()
