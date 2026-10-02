import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


class AppImageCLITests(unittest.TestCase):
    def setUp(self):
        if any(pathlib.Path("/usr/bin", name).exists() for name in ("typerelay", "typerelay-tui")):
            self.skipTest("Native package commands take precedence on this host")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.commands = self.root / "bin"
        self.commands.mkdir()
        self.registration = self.root / "appimage-type2"
        script = pathlib.Path(__file__).resolve().parents[1] / "appimage-cli.sh"
        for name in ("typerelay", "typerelay-tui"):
            command = self.commands / name
            command.write_text(script.read_text().replace("registration=/proc/sys/fs/binfmt_misc/appimage-type2", 'registration="' + str(self.registration) + '"'))
            command.chmod(0o755)

    def register(self, user, filename="TypeRelay.AppImage"):
        home = self.root / user
        data = home / "custom data"
        reference = data / "typerelay/appimage-path"
        reference.parent.mkdir(parents=True)
        appimage = home / filename
        appimage.write_text("#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\"\nexit 7\n")
        appimage.chmod(0o755)
        reference.write_text(str(appimage) + "\n")
        return appimage, {**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(data), "PATH": str(self.commands) + os.pathsep + os.environ["PATH"]}

    def test_shared_commands_resolve_each_users_appimage_and_forward_arguments(self):
        for user in ("first user", "second user"):
            appimage, environment = self.register(user, "TypeRelay ' $ ` %.AppImage")
            for name, mode in (("typerelay", "--cli"), ("typerelay-tui", "--tui-cli")):
                result = subprocess.run([name, "--dir", "snippet files", "--version"], env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 7)
                self.assertEqual(result.stdout.splitlines(), [str(appimage), mode, "--dir", "snippet files", "--version"])
                self.assertEqual(result.stderr, "")

    def test_terminal_commands_skip_appimage_integration_and_preserve_wayland(self):
        appimage, environment = self.register("wayland user")
        appimage.write_text('#!/bin/sh\n[ "$APPIMAGELAUNCHER_DISABLE" = 1 ] || exit 90\n[ "$QT_QPA_PLATFORM" = wayland ] || exit 91\nprintf \'%s\\n\' "$@"\n')
        environment["QT_QPA_PLATFORM"] = "wayland"
        for inherited in (None, "0"):
            environment.pop("APPIMAGELAUNCHER_DISABLE", None)
            if inherited is not None:
                environment["APPIMAGELAUNCHER_DISABLE"] = inherited
            for name, mode in (("typerelay", "--cli"), ("typerelay-tui", "--tui-cli")):
                with self.subTest(command=name, inherited=inherited):
                    result = subprocess.run([name, "--version"], env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), [mode, "--version"])
                    self.assertEqual(result.stderr, "")

    def test_registered_bypass_launches_terminal_commands_without_interpreter_output(self):
        appimage, environment = self.register("bypass user", "TypeRelay ' $ ` %.AppImage")
        helper = self.root / "custom lib directory/appimagelauncher/binfmt-bypass"
        helper.parent.mkdir(parents=True)
        helper.write_text('#!/bin/sh\n[ "$QT_QPA_PLATFORM" = wayland ] || exit 91\nprintf \'%s\\n\' "$0" "$@"\nexit 7\n')
        helper.chmod(0o755)
        self.registration.write_text("enabled\ninterpreter " + str(helper.with_name("binfmt-interpreter")) + "\nflags: F\noffset 8\nmagic 414902\n")
        environment["QT_QPA_PLATFORM"] = "wayland"
        for name, mode in (("typerelay", "--cli"), ("typerelay-tui", "--tui-cli")):
            with self.subTest(command=name):
                result = subprocess.run([name, "--dir", "snippet files", "--version"], env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [str(helper), str(appimage), mode, "--dir", "snippet files", "--version"])
                self.assertEqual(result.stderr, "")
        helper.write_text('#!/bin/sh\nprintf \'%s\\n\' "Real launch failure" >&2\nexit 37\n')
        result = subprocess.run(["typerelay-tui"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 37)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "Real launch failure\n")

    def test_missing_or_unrelated_bypass_keeps_direct_appimage_execution(self):
        appimage, environment = self.register("fallback user")
        unrelated = self.root / "unrelated/binfmt-bypass"
        unrelated.parent.mkdir()
        unrelated.write_text("#!/bin/sh\nexit 99\n")
        unrelated.chmod(0o755)
        for interpreter in (self.root / "missing/appimagelauncher/binfmt-interpreter", self.root / "unrelated/binfmt-interpreter"):
            with self.subTest(interpreter=interpreter):
                self.registration.write_text("enabled\ninterpreter " + str(interpreter) + "\n")
                result = subprocess.run(["typerelay-tui", "--help"], env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [str(appimage), "--tui-cli", "--help"])
                self.assertEqual(result.stderr, "")

    def test_appimage_relocation_updates_command_without_reinstalling_wrapper(self):
        appimage, environment = self.register("user")
        moved = appimage.with_name("Updated TypeRelay.AppImage")
        appimage.rename(moved)
        reference = pathlib.Path(environment["XDG_DATA_HOME"]) / "typerelay/appimage-path"
        reference.write_text(str(moved) + "\n")
        result = subprocess.run(["typerelay-tui", "--help"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout.splitlines(), [str(moved), "--tui-cli", "--help"])

    def test_missing_registration_or_deleted_appimage_returns_actionable_error(self):
        appimage, environment = self.register("user")
        appimage.unlink()
        result = subprocess.run(["typerelay-tui"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("new location", result.stderr)
        (pathlib.Path(environment["XDG_DATA_HOME"]) / "typerelay/appimage-path").unlink()
        result = subprocess.run(["typerelay"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("register terminal commands for this user", result.stderr)

    def test_default_data_directory_uses_home(self):
        appimage, environment = self.register("user")
        home = pathlib.Path(environment["HOME"])
        default = home / ".local/share/typerelay"
        default.mkdir(parents=True)
        (default / "appimage-path").write_text(str(appimage) + "\n")
        environment.pop("XDG_DATA_HOME")
        result = subprocess.run(["typerelay-tui"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout.splitlines(), [str(appimage), "--tui-cli"])

    def test_native_panel_routes_cli_before_gui_and_panel_version_handling(self):
        repository = pathlib.Path(__file__).resolve().parents[2]
        target = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", str(repository / "apps/desktop/src-tauri/target")))
        if not target.is_absolute():
            target = repository / target
        binary = target / "debug/typerelay-panel"
        if not binary.is_file():
            self.skipTest("Build the native panel first with check-linux-package.sh")
        bundle = self.root / "bundle"
        bundle.mkdir()
        panel = bundle / "typerelay-panel"
        shutil.copyfile(binary, panel)
        panel.chmod(0o755)
        for name in ("typerelay", "typerelay-tui"):
            tool = bundle / name
            tool.write_text("#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\"\nexit 7\n")
            tool.chmod(0o755)
        appimage, environment = self.register("native user")
        appimage.write_text('#!/bin/sh\nexec "' + str(panel) + '" "$@"\n')
        environment["XDG_CONFIG_HOME"] = str(self.root / "unused-config")
        for variable in ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"):
            environment.pop(variable, None)
        for name in ("typerelay", "typerelay-tui"):
            for arguments in (["--version"], ["--help"], ["--dir", "snippet files"]):
                result = subprocess.run([name, *arguments], env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [str(bundle / name), *arguments])
                self.assertEqual(result.stderr, "")
        self.assertFalse(pathlib.Path(environment["XDG_CONFIG_HOME"]).exists())
