import contextlib
import hashlib
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
        self.subject.access = Mock(return_value=Mock(select_keyboard=Mock(return_value="keyd virtual keyboard")))
        self.subject.permissions_current = Mock(return_value=True)
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

    def test_package_setup_keeps_package_files_and_refreshes_engine_and_tui(self):
        panel = self.home / "TypeRelay.AppImage"
        panel.write_bytes(b"appimage")
        self.subject.panel_launcher = panel
        self.subject.install(False)
        state = json.loads(self.subject.manifest.read_text())
        self.assertEqual(state["panel_launcher"], str(panel))
        self.assertEqual(set(state["binaries"]), {"typerelay", "typerelay-tui"})
        self.subject.setup(check=True)
        self.subject.binary.write_bytes(b"new engine")
        with self.assertRaisesRegex(RuntimeError, "need updating"):
            self.subject.setup(check=True)
        self.subject.setup(automatic=True)
        self.assertEqual(self.subject.destination.read_bytes(), b"new engine")
        self.assertTrue(self.subject.binary.exists(), "Package directory must never be removed by automatic setup")
        self.assertEqual(panel.read_bytes(), b"appimage")
        self.subject.setup(check=True)
        self.subject.destination.write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "need updating"):
            self.subject.setup(check=True)

    def test_package_migration_retires_only_owned_legacy_panel(self):
        source_panel = self.subject.binary.with_name("typerelay-panel")
        source_panel.write_bytes(b"legacy panel")
        with patch.object(self.installer.subprocess, "Popen"):
            self.subject.install(False)
        panel = self.home / "TypeRelay.AppImage"
        panel.write_bytes(b"appimage")
        self.subject.panel_launcher = panel
        self.subject.setup(automatic=True)
        self.assertFalse(self.subject.destination.with_name("typerelay-panel").exists())
        self.assertTrue(source_panel.exists())
        self.assertNotIn("typerelay-panel", json.loads(self.subject.manifest.read_text())["binaries"])
        self.assertIn(str(panel), (self.home / ".local/share/applications/typerelay-panel.desktop").read_text())
        self.subject.uninstall(False)
        self.assertTrue(panel.exists(), "Removing expansion setup must not delete package files")
        self.assertFalse((self.home / ".local/share/applications/typerelay-panel.desktop").exists())

    def test_package_setup_preserves_unowned_panel_and_selected_keyboard(self):
        panel = self.home / "TypeRelay.AppImage"
        panel.write_bytes(b"appimage")
        self.subject.panel_launcher = panel
        self.subject.device_name = "AT Translated Set 2 keyboard"
        self.subject.install(False)
        unowned = self.subject.destination.with_name("typerelay-panel")
        unowned.write_bytes(b"unrelated")
        self.subject.setup(automatic=True)
        self.assertEqual(unowned.read_bytes(), b"unrelated")
        self.subject.device_name = None
        self.subject.setup(check=True)
        self.assertEqual(self.subject.device_name, "AT Translated Set 2 keyboard")

    def test_system_package_uses_its_own_menu_entry(self):
        panel = self.subject.binary.with_name("typerelay-panel")
        panel.write_bytes(b"packaged panel")
        self.subject.panel_launcher = panel
        self.subject.setup()
        self.assertFalse((self.home / ".local/share/applications/typerelay-panel.desktop").exists())
        self.assertTrue(panel.exists())

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

    def test_automatic_update_requires_owned_managed_binaries(self):
        self.subject.destination.parent.mkdir(parents=True)
        self.subject.destination.write_bytes(b"installed engine")
        self.subject.destination.with_name("typerelay-tui").write_bytes(b"installed tui")
        self.subject.data.mkdir(parents=True)
        self.subject.manifest.write_text(json.dumps({"binaries": {"typerelay": hashlib.sha256(b"installed engine").hexdigest(), "typerelay-tui": hashlib.sha256(b"installed tui").hexdigest()}}))
        def command(path, *args, **kwargs):
            if path == "pgrep":
                return subprocess.CompletedProcess([], 1, "", "")
            name = "typerelay" if pathlib.Path(path) == self.subject.binary else pathlib.Path(path).name
            return subprocess.CompletedProcess([], 0, f"{name} 0.11.0\n", "")
        self.subject.command.side_effect = command
        with patch.object(self.installer.shutil, "which", return_value="/usr/bin/tool"):
            self.installer.Installer.preflight(self.subject, True)
            self.subject.destination.write_bytes(b"external replacement")
            with self.assertRaisesRegex(RuntimeError, "changed outside TypeRelay"):
                self.installer.Installer.preflight(self.subject, True)

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

    def test_keyd_free_install_and_update_keep_selected_keyboard(self):
        self.subject.device_name = "AT Translated Set 2 keyboard"
        self.subject.conflicts.return_value.update(espanso_process=False, espanso_enabled=False, espanso_active=False)
        self.subject.install(False)
        self.assertIn('--device-name "AT Translated Set 2 keyboard"', self.subject.unit.read_text())
        self.assertEqual(json.loads(self.subject.manifest.read_text())["device_name"], self.subject.device_name)
        self.subject.device_name = None
        self.subject.access.return_value.select_keyboard.return_value = "AT Translated Set 2 keyboard"
        self.subject.validate_bundle = Mock()
        self.subject.command.return_value = subprocess.CompletedProcess([], 1, "", "")
        with patch.object(self.installer.shutil, "which", return_value="/usr/bin/tool"):
            self.installer.Installer.preflight(self.subject, True)
        self.subject.access.return_value.select_keyboard.assert_called_with("AT Translated Set 2 keyboard")
        self.subject.command.return_value = subprocess.CompletedProcess([], 0, '{"backup": null}', "")
        bundle = self.home / "update-bundle"
        bundle.mkdir()
        for name in (self.subject.binary.name, "typerelay-tui"):
            self.installer.shutil.copyfile(self.subject.binary.with_name(name), bundle / name)
        self.subject.binary = bundle / self.subject.binary.name
        self.subject.install(False, automatic=True)
        self.assertIn('--device-name "AT Translated Set 2 keyboard"', self.subject.unit.read_text())
        self.subject.privileged.assert_called_once_with("install")

    def test_native_keyboard_selection_ignores_virtual_devices_and_security_key(self):
        access = self.session_access.SessionAccess(self.home)
        access.devices = Mock(return_value=[("AT Translated Set 2 keyboard", pathlib.Path("/dev/input/event3"), ["ID_INPUT_KEYBOARD=1", "ID_INTEGRATION=internal"]), ("TypeRelay virtual keyboard", pathlib.Path("/dev/input/event20"), ["ID_INPUT_KEYBOARD=1"]), ("Yubico YubiKey OTP+FIDO+CCID", pathlib.Path("/dev/input/event24"), ["ID_INPUT_KEYBOARD=1", "ID_INTEGRATION=external"])])
        self.assertEqual(access.select_keyboard(), "AT Translated Set 2 keyboard")
        self.assertIn('ATTRS{name}=="AT Translated Set 2 keyboard"', access.rules(1234))
        self.assertNotIn("Yubico", access.rules(1234))
        self.assertNotIn("TypeRelay virtual keyboard", access.rules(1234))
        # Selecting a keyboard must not grant access to every keyboard.
        self.assertEqual([name for name, _, _ in access.paths()], ["uinput", "AT Translated Set 2 keyboard"])

    def test_keyd_preferred_and_ambiguous_native_selection_requires_explicit_name(self):
        access = self.session_access.SessionAccess(self.home)
        access.devices = Mock(return_value=[("keyd virtual keyboard", pathlib.Path("/dev/input/event16"), ["ID_INPUT_KEYBOARD=1"]), ("Built-in keyboard", pathlib.Path("/dev/input/event3"), ["ID_INPUT_KEYBOARD=1", "ID_INTEGRATION=internal"])])
        self.assertEqual(access.select_keyboard(), "keyd virtual keyboard")
        with self.assertRaisesRegex(RuntimeError, "Stop keyd"):
            access.select_keyboard("Built-in keyboard")
        access.devices.return_value = [("USB keyboard", pathlib.Path("/dev/input/event3"), ["ID_INPUT_KEYBOARD=1"]), ("Other keyboard", pathlib.Path("/dev/input/event4"), ["ID_INPUT_KEYBOARD=1"])]
        with self.assertRaisesRegex(RuntimeError, "--device-name"):
            access.select_keyboard()
        self.assertEqual(access.select_keyboard("USB keyboard"), "USB keyboard")
        access.devices.return_value.append(access.devices.return_value[0])
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            access.select_keyboard("USB keyboard")

    def test_native_access_uninstall_restores_previously_selected_keyboards(self):
        access = self.session_access.SessionAccess(self.home, "Built-in keyboard")
        access.devices = Mock(return_value=[("Built-in keyboard", pathlib.Path("/dev/input/event3"), ["ID_INPUT_KEYBOARD=1"]), ("Old keyboard", pathlib.Path("/dev/input/event4"), ["ID_INPUT_KEYBOARD=1"])])
        access.acl = Mock(return_value=None)
        access.set_acl = Mock()
        state = self.home / "var/lib/typerelay/access-1234.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"Old keyboard": "rw-"}))
        with patch.object(self.session_access.subprocess, "run"):
            access.persistent("install", 1234)
            access.acl.side_effect = lambda path, uid: "rw-" if path.name == "uinput" else "r--"
            access.persistent("uninstall", 1234)
        access.set_acl.assert_any_call(pathlib.Path("/dev/input/event4"), 1234, "rw-")

    def test_keyboard_name_cannot_broaden_device_permissions(self):
        for name in ['*', 'Keyboard"', "Keyboard\n", "Keyboard\\", "Keyboard?"]:
            with self.assertRaises(ValueError):
                self.session_access.SessionAccess(self.home, name)

    def test_preflight_does_not_require_keyd_and_rejects_missing_update_permissions(self):
        self.subject.validate_bundle = Mock()
        self.subject.command.return_value = subprocess.CompletedProcess([], 1, "", "")
        self.subject.access.return_value.select_keyboard.return_value = "Built-in keyboard"
        with patch.object(self.installer.shutil, "which", return_value="/usr/bin/tool"):
            self.installer.Installer.preflight(self.subject)
            self.assertEqual(self.subject.device_name, "Built-in keyboard")
            self.subject.command.assert_called_once_with("pgrep", "-u", str(os.getuid()), "-x", "typerelay-tui", check=False)
            self.subject.permissions_current.return_value = False
            with self.assertRaisesRegex(RuntimeError, "administrator setup"):
                self.installer.Installer.preflight(self.subject, True)

    def test_embedded_permission_helper_uses_selected_device(self):
        self.subject.permission_source = (pathlib.Path(__file__).resolve().parents[1] / "session-access.py").read_text()
        self.subject.device_name = "Built-in keyboard"
        access = self.installer.Installer.access(self.subject)
        self.assertEqual(access.device_name, "Built-in keyboard")
        self.assertIn('ATTRS{name}=="Built-in keyboard"', access.rules(1234))


if __name__ == "__main__":
    unittest.main()
