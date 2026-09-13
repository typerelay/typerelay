import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scripts = pathlib.Path(__file__).resolve().parents[1]
        for name in ("installer", "session-access"):
            spec = importlib.util.spec_from_file_location(name, scripts / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            setattr(cls, name.replace("-", "_"), module)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = pathlib.Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.home / ".config"), "XDG_DATA_HOME": str(self.home / ".local/share")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        binary = self.home / "source-binary"
        binary.write_bytes(b"test-binary")
        binary.with_name("typerelay-tui").write_bytes(b"test-tui-binary")
        self.subject = self.installer.Installer(binary, "# helper", self.home)
        self.subject.preflight = Mock()
        self.subject.prompt = Mock(return_value=True)
        self.subject.privileged = Mock()
        self.subject.conflicts = Mock(return_value={"manual": [], "possible": [], "espanso_process": True, "espanso_enabled": True, "espanso_active": True})
        self.subject.command = Mock(return_value=subprocess.CompletedProcess([], 0, '{"backup": null}', ""))
        self.subject.systemctl = Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.sleep = patch.object(self.installer.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.stdout = contextlib.redirect_stdout(io.StringIO())
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def test_optional_panel_install_tracks_ownership_and_uninstall_preserves_data(self):
        panel = self.subject.binary.with_name("typerelay-panel")
        panel.write_bytes(b"test-panel")
        with patch.object(self.installer.subprocess, "Popen") as launch:
            self.subject.install(False)
            launch.assert_called_once()
        installed = self.subject.destination.with_name("typerelay-panel")
        self.assertEqual(installed.read_bytes(), b"test-panel")
        state = json.loads(self.subject.manifest.read_text())
        self.assertIn("typerelay-panel", state["binaries"])
        self.assertTrue((self.home / ".local/share/applications/typerelay-panel.desktop").exists())
        self.subject.config.mkdir(parents=True, exist_ok=True)
        settings = self.subject.config / "panel.json"
        settings.write_text('{"shortcut":"Ctrl+Shift+Comma"}')
        panel.unlink()  # Uninstall must use ownership, even without an installer-side panel.
        self.subject.uninstall(False)
        self.assertFalse(installed.exists())
        self.assertTrue(settings.exists())

    def test_bundle_checks_both_binaries_before_mutations(self):
        self.subject.command.side_effect = lambda path, *args, **kwargs: subprocess.CompletedProcess([], 0, ("typerelay" if pathlib.Path(path) == self.subject.binary else "typerelay-tui") + " 0.4.0\n", "")
        self.subject.validate_bundle()
        self.subject.binary.with_name("typerelay-tui").unlink()
        with self.assertRaisesRegex(RuntimeError, "Missing typerelay-tui"):
            self.subject.validate_bundle()
        self.subject.privileged.assert_not_called()

    def test_uninstall_reads_legacy_manifest_without_removing_unowned_tui(self):
        self.subject.install(False)
        state = json.loads(self.subject.manifest.read_text())
        del state["binaries"]
        self.subject.manifest.write_text(json.dumps(state))
        self.subject.uninstall(False)
        self.assertFalse(self.subject.destination.exists())
        self.assertTrue(self.subject.destination.with_name("typerelay-tui").exists())

    def test_dry_run_and_cancel_do_not_mutate(self):
        self.subject.install(True)
        self.subject.prompt.assert_not_called()
        self.subject.privileged.assert_not_called()
        self.assertFalse(self.subject.config.exists())
        self.subject.prompt.return_value = False
        self.subject.install(False)
        self.subject.privileged.assert_not_called()
        self.assertFalse(self.subject.config.exists())

    def test_install_upgrade_uninstall_preserve_snippets_and_restore_espanso(self):
        self.subject.config.mkdir(parents=True)
        original = "matches:\n- trigger: 'mine'\n  replace: mine\n"
        (self.subject.config / "poc.yml").write_text(original)
        self.subject.install(False)
        migrated = self.subject.snippets / "mysnippets.yml"
        self.assertEqual(migrated.read_text(), original)
        migrated.write_text(original + "# personal edit\n")
        (self.subject.snippets / "sales.yml").write_text("matches: []\n")
        self.subject.conflicts.return_value.update(espanso_process=False, espanso_enabled=False, espanso_active=False)
        self.subject.install(False)
        self.assertIn("# personal edit", migrated.read_text())
        self.assertTrue(json.loads(self.subject.manifest.read_text())["espanso_enabled"])
        self.assertIn("--dir", self.subject.unit.read_text())
        self.assertIn("RestartPreventExitStatus=78", self.subject.unit.read_text())
        self.subject.uninstall(False)
        self.assertFalse(self.subject.unit.exists())
        self.assertFalse(self.subject.destination.exists())
        self.assertFalse(self.subject.destination.with_name("typerelay-tui").exists())
        self.assertFalse(self.subject.manifest.exists())
        self.assertEqual((self.subject.config / "poc.yml").read_text(), original)
        self.assertTrue((self.subject.snippets / "sales.yml").exists())
        self.assertIn("# personal edit", migrated.read_text())
        self.subject.systemctl.assert_any_call("enable", "espanso.service")
        self.subject.command.assert_any_call("espanso", "start")
        self.subject.privileged.assert_any_call("uninstall")

    def test_start_failure_restores_previous_service(self):
        self.subject.systemctl.side_effect = lambda *args, **kwargs: subprocess.CompletedProcess([], 3 if args == ("is-active", "typerelay.service") else 0, "", "")
        with self.assertRaisesRegex(RuntimeError, "failed to start"):
            self.subject.install(False)
        self.assertTrue(self.subject.manifest.exists(), "Recovery/uninstall must remain possible")
        self.subject.systemctl.assert_any_call("enable", "espanso.service", check=False)
        self.subject.systemctl.assert_any_call("start", "espanso.service", check=False)

    def test_failed_upgrade_restores_migrated_files_binaries_and_manifest(self):
        self.subject.config.mkdir(parents=True)
        self.subject.snippets.mkdir()
        file = self.subject.snippets / "mine.yml"
        old_text = "matches:\n- trigger: ',old'\n  replace: original\n"
        file.write_text(old_text)
        database = self.subject.snippets / "typerelay.sqlite"
        database.write_bytes(b"previous database")
        sync_state = self.subject.config / "sync/state.json"
        sync_state.parent.mkdir()
        sync_state.write_text('{"cursor": 3}')
        self.subject.destination.parent.mkdir(parents=True)
        self.subject.destination.write_bytes(b"old engine")
        self.subject.destination.with_name("typerelay-tui").write_bytes(b"old tui")
        self.subject.data.mkdir(parents=True)
        old_manifest = '{"binary_sha256": "old", "espanso_enabled": false, "espanso_active": false}'
        self.subject.manifest.write_text(old_manifest)
        self.subject.conflicts.return_value.update(espanso_process=False, espanso_enabled=False, espanso_active=False)
        active_checks = []
        def service(*args, **kwargs):
            if args == ("is-active", "typerelay.service"):
                active_checks.append(True)
                return subprocess.CompletedProcess([], 0 if len(active_checks) == 1 else 3, "", "")
            return subprocess.CompletedProcess([], 0, "", "")
        def migrate(check=False):
            if check:
                return None
            backup = self.home / "migration-backup"
            backup.mkdir()
            saved = backup / "0.bak"
            saved.write_text(old_text)
            (backup / "manifest.json").write_text(json.dumps([{"path": str(file), "backup": str(saved)}]))
            file.write_text("matches:\n- trigger: old\n  replace: original\n")
            database.write_bytes(b"new incompatible database")
            database.with_name("typerelay.sqlite-wal").write_bytes(b"new WAL")
            sync_state.unlink()
            return str(backup)
        self.subject.systemctl.side_effect = service
        self.subject.migrate_snippets = Mock(side_effect=migrate)
        with self.assertRaisesRegex(RuntimeError, "failed to start"):
            self.subject.install(False)
        self.assertEqual(file.read_text(), old_text)
        self.assertEqual(database.read_bytes(), b"previous database")
        self.assertFalse(database.with_name("typerelay.sqlite-wal").exists())
        self.assertEqual(sync_state.read_text(), '{"cursor": 3}')
        self.assertEqual(self.subject.destination.read_bytes(), b"old engine")
        self.assertEqual(self.subject.destination.with_name("typerelay-tui").read_bytes(), b"old tui")
        self.assertEqual(self.subject.manifest.read_text(), old_manifest)
        self.subject.systemctl.assert_any_call("start", "typerelay.service", check=False)

    def test_database_upgrade_does_not_reimport_legacy_yaml(self):
        self.subject.snippets.mkdir(parents=True)
        (self.subject.snippets / "typerelay.sqlite").write_bytes(b"existing database")
        (self.subject.config / "poc.yml").write_text("matches: []")
        self.subject.migrate_snippets(check=True)
        self.subject.migrate_snippets()
        self.assertFalse((self.subject.snippets / "mysnippets.yml").exists())
        self.subject.command.assert_any_call(str(self.subject.binary), "validate", "--dir", str(self.subject.snippets))

    def test_uninstall_preserves_replaced_binary(self):
        self.subject.install(False)
        self.subject.destination.write_bytes(b"a replacement made outside installer")
        self.subject.uninstall(False)
        self.assertTrue(self.subject.destination.exists())

    def test_service_paths_are_quoted_and_session_bound(self):
        self.subject.destination = pathlib.Path('/tmp/a b%$"/typerelay')
        service = self.subject.service_text()
        self.assertIn('"/tmp/a b%%$$\\"/typerelay"', service)
        self.assertIn("PartOf=graphical-session.target", service)
        self.assertIn("KillSignal=SIGINT", service)
        self.assertNotIn("User=root", service)

    def test_scoped_rules_restore_previous_acl(self):
        access = self.session_access.SessionAccess(self.home)
        access.paths = Mock(return_value=[("uinput", pathlib.Path("/dev/uinput"), "rw"), ("keyd virtual keyboard", pathlib.Path("/dev/input/event16"), "r")])
        access.acl = Mock(return_value=None)
        access.set_acl = Mock()
        with patch.object(self.session_access.subprocess, "run"):
            access.persistent("install", 1234)
            rule = self.home / "etc/udev/rules.d/99-typerelay-1234.rules"
            self.assertIn('ATTRS{name}=="keyd virtual keyboard"', rule.read_text())
            self.assertNotIn('GROUP="input"', rule.read_text())
            self.assertNotIn('0666', rule.read_text())
            access.acl.side_effect = lambda path, uid: "rw-" if path.name == "uinput" else "r--"
            access.persistent("uninstall", 1234)
            self.assertFalse(rule.exists())
            access.set_acl.assert_any_call(pathlib.Path("/dev/uinput"), 1234, None)
            access.set_acl.assert_any_call(pathlib.Path("/dev/input/event16"), 1234, None)


if __name__ == "__main__":
    unittest.main()
