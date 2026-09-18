#!/usr/bin/env python3
"""Interactive per-user TypeRelay installer, embedded in the Rust executable."""
import argparse
import hashlib
import json
import os
import pathlib
import pwd
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import time


class Installer:
    marker = "# Managed by TypeRelay"

    def __init__(self, binary, permission_source, home=None):
        self.home = pathlib.Path(home or pathlib.Path.home())
        config = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", self.home / ".config"))
        data = pathlib.Path(os.environ.get("XDG_DATA_HOME", self.home / ".local/share"))
        self.config = config / "typerelay"
        self.snippets = self.config / "snippets"
        self.data = data / "typerelay"
        self.unit = config / "systemd/user/typerelay.service"
        self.destination = self.home / ".local/bin/typerelay"
        self.manifest = self.data / "installation.json"
        self.helper = self.data / "session-access.py"
        self.binary = pathlib.Path(binary).resolve()
        self.permission_source = permission_source

    def artifacts(self):
        artifacts = [("typerelay", self.binary, self.destination), ("typerelay-tui", self.binary.with_name("typerelay-tui"), self.destination.with_name("typerelay-tui"))]
        panel = self.binary.with_name("typerelay-panel")
        if panel.exists():
            artifacts.append(("typerelay-panel", panel, self.destination.with_name("typerelay-panel")))
        return artifacts

    def validate_bundle(self):
        versions = []
        for name, source, destination in self.artifacts():
            if not source.is_file():
                raise RuntimeError(f"Missing {name} in the installer bundle. Build/download both binaries before installing.")
            result = self.command(str(source), "--version")
            parts = result.stdout.strip().split()
            if len(parts) != 2 or parts[0] != name:
                raise RuntimeError(f"Invalid {name} binary in installer bundle")
            versions.append(parts[1])
            if destination.exists() and destination.resolve() != source:
                installed = self.command(str(destination), "--version", check=False)
                if not installed.stdout.startswith(name + " "):
                    raise RuntimeError(f"Refusing to replace an unrelated executable named {name}")
        if len(set(versions)) != 1:
            raise RuntimeError("Engine and TUI versions differ; use a matching installer bundle")

    def command(self, *args, check=True):
        return subprocess.run(args, check=check, capture_output=True, text=True)

    def systemctl(self, *args, check=True):
        return self.command("systemctl", "--user", *args, check=check)

    def prompt(self, question, default=True):
        answer = input(question + (" [Y/n] " if default else " [y/N] ")).strip().lower()
        return default if not answer else answer in ("y", "yes")

    def quote(self, path):
        text = str(path)
        if any(c in text for c in ("\n", "\r", "\0")):
            raise RuntimeError("Unsupported control character in installation path")
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'

    def service_text(self):
        return f'''{self.marker}
[Unit]
Description=TypeRelay text expansion
After=graphical-session.target
PartOf=graphical-session.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart={self.quote(self.destination)} run --dir {self.quote(self.snippets)}
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=78
KillSignal=SIGINT
# The clipboard-restoration owner must survive stopping the main client.
KillMode=process
TimeoutStopSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=graphical-session.target
'''

    def processes(self):
        found = []
        for entry in pathlib.Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid != os.getuid():
                    continue
                args = [s.decode(errors="replace") for s in (entry / "cmdline").read_bytes().split(b"\0") if s]
                if args:
                    found.append((int(entry.name), args))
            except (OSError, ValueError):
                continue
        return found

    def conflicts(self):
        main_pid = self.systemctl("show", "typerelay.service", "--property=MainPID", "--value", check=False).stdout.strip()
        manual = []
        possible = set()
        espanso_process = False
        for pid, args in self.processes():
            names = {pathlib.Path(arg).name for arg in args[:2]}
            if pathlib.Path(args[0]).name == "typerelay" and len(args) > 1 and args[1] == "run" and str(pid) != main_pid:
                manual.append(pid)
            if "espanso" in names:
                espanso_process = True
            possible.update(names.intersection({"autokey-gtk", "autokey-qt", "xremap", "kmonad"}))
        enabled = self.systemctl("is-enabled", "espanso.service", check=False).stdout.strip()
        active = self.systemctl("is-active", "espanso.service", check=False).returncode == 0
        return {"manual": manual, "possible": sorted(possible), "espanso_process": espanso_process, "espanso_enabled": enabled.startswith("enabled"), "espanso_active": active}

    def permissions_current(self):
        try:
            uid = os.getuid()
            access = runpy.run_path(str(self.helper))["SessionAccess"]()
            rule = pathlib.Path(f"/etc/udev/rules.d/99-typerelay-{uid}.rules")
            module = pathlib.Path(f"/etc/modules-load.d/typerelay-{uid}.conf")
            saved = pathlib.Path(f"/var/lib/typerelay/access-{uid}.json")
            return saved.exists() and rule.read_text() == access.rules(uid) and module.read_text() == access.marker + "\nuinput\n" and all(os.access(path, os.R_OK | (os.W_OK if permission == "rw" else 0)) for _, path, permission in access.paths())
        except (OSError, KeyError, subprocess.CalledProcessError):
            return False

    def privileged(self, action):
        if action == "install" and self.permissions_current():
            print("Existing persistent input access is current; no administrator changes needed.")
            return
        arguments = ["/usr/bin/python3", str(self.helper), action, pwd.getpwuid(os.getuid()).pw_name]
        if shutil.which("sudo"):
            arguments.insert(0, "sudo")
        elif shutil.which("pkexec"):
            arguments.insert(0, "pkexec")
        else:
            raise RuntimeError("Install sudo or polkit to configure persistent input access")
        subprocess.run(arguments, check=True)

    def stop_manual(self, pids):
        for pid in pids:
            try:
                os.kill(pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.conflicts()["manual"]:
            time.sleep(0.1)
        if self.conflicts()["manual"]:
            raise RuntimeError("Manual client did not stop; it was not force-killed")

    def write_private(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".new")
        temporary.write_text(text)
        temporary.chmod(0o600)
        os.replace(temporary, path)

    def migrate_snippets(self, check=False):
        if (self.snippets / "typerelay.sqlite").is_file():
            self.command(str(self.binary), "validate", "--dir", str(self.snippets))
            return None
        legacy = self.config / "poc.yml"
        if check:
            files = list(self.snippets.glob("*.yml")) + list(self.snippets.glob("*.yaml")) if self.snippets.exists() else []
            source = ("--dir", self.snippets) if files else ("--file", legacy) if legacy.exists() else None
            if source:
                self.command(str(self.binary), "migrate", source[0], str(source[1]), "--settings", str(self.config / "settings.yml"), "--check")
            return None
        self.snippets.mkdir(parents=True, exist_ok=True)
        self.snippets.chmod(0o700)
        existing = [p for p in self.snippets.iterdir() if p.suffix in (".yml", ".yaml") and p.is_file() and not p.is_symlink()]
        if not existing:
            legacy = self.config / "poc.yml"
            target = self.snippets / "mysnippets.yml"
            if legacy.is_file():
                if target.exists() or target.is_symlink():
                    raise RuntimeError("Refusing to overwrite mysnippets.yml")
                shutil.copy2(legacy, target)
                target.chmod(0o600)
                print("Copied poc.yml to snippets/mysnippets.yml; original preserved.")
            else:
                self.write_private(target, "matches: []\n")
        result = self.command(str(self.binary), "migrate", "--dir", str(self.snippets), "--settings", str(self.config / "settings.yml"), "--json")
        report = json.loads(result.stdout)
        if report.get("backup"):
            print("Snippet/settings backups: " + report["backup"])
        return report.get("backup")

    def preflight(self, automatic=False):
        if self.command("pgrep", "-u", str(os.getuid()), "-x", "typerelay-tui", check=False).returncode == 0:
            raise RuntimeError("Save and close typerelay-tui before installing so its database can be backed up safely.")
        if os.getuid() == 0:
            raise RuntimeError("Run as your desktop user; the installer requests administrator access only for device rules")
        required = ["systemctl", "notify-send"] if automatic else ["systemctl", "udevadm", "setfacl", "getfacl", "modprobe", "notify-send"]
        missing = [name for name in required if not shutil.which(name)]
        if missing:
            raise RuntimeError("Missing dependencies: " + ", ".join(missing))
        if not automatic and self.command("systemctl", "is-active", "keyd", check=False).returncode:
            raise RuntimeError("This Omarchy client requires keyd to be running")
        if self.unit.exists() and not self.unit.read_text().startswith(self.marker):
            raise RuntimeError("Existing typerelay.service is unmanaged; preserve/move it before installing")
        self.validate_bundle()
        if automatic:
            if not self.manifest.exists():
                raise RuntimeError("Automatic update requires a managed TypeRelay installation")
            state = json.loads(self.manifest.read_text())
            for name, _, destination in self.artifacts():
                expected = state.get("binaries", {}).get(name)
                if not expected or not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
                    raise RuntimeError(f"Installed {name} changed outside TypeRelay; refusing automatic replacement")

    def install(self, dry_run, automatic=False):
        self.preflight(automatic)
        conflicts = self.conflicts()
        print("Binaries: " + ", ".join(str(destination) for _, _, destination in self.artifacts()) + f"\nService: {self.unit}\nSnippets: {self.snippets}")
        print("Starts with your graphical login, runs as your user, restarts after failures.")
        print("Administrator access installs scoped udev rules and loads uinput at boot.")
        if conflicts["manual"]:
            print("Running manual TypeRelay client(s): " + ", ".join(map(str, conflicts["manual"])))
        if conflicts["espanso_process"] or conflicts["espanso_enabled"] or conflicts["espanso_active"]:
            print("INTERFERENCE: Espanso is running or enabled for login; it must be stopped and its autostart disabled.")
        if conflicts["possible"]:
            print("POSSIBLE INTERFERENCE: " + ", ".join(conflicts["possible"]) + ". These tools will not be stopped automatically.")
        if dry_run:
            self.migrate_snippets(check=True)
            print("Dry run: nothing changed.\n\n" + self.service_text())
            return
        if not automatic and not self.prompt("Install TypeRelay with this configuration?"):
            print("Cancelled. Nothing changed.")
            return
        if not automatic and (conflicts["manual"] or conflicts["espanso_process"] or conflicts["espanso_enabled"] or conflicts["espanso_active"]):
            if not self.prompt("Stop manual TypeRelay clients and stop/disable Espanso to use the service?"):
                print("Cancelled. Nothing changed.")
                return
        if not automatic and conflicts["possible"] and not self.prompt("Continue despite these possible conflicts?", default=False):
            print("Cancelled. Nothing changed.")
            return
        old_manifest = self.manifest.read_bytes() if self.manifest.exists() else None
        previous = json.loads(old_manifest) if old_manifest is not None else {"espanso_enabled": conflicts["espanso_enabled"], "espanso_active": conflicts["espanso_active"] or conflicts["espanso_process"]}
        self.migrate_snippets(check=True)
        self.data.mkdir(parents=True, exist_ok=True)
        self.data.chmod(0o700)
        self.write_private(self.helper, self.permission_source)
        # Save recovery information before any privileged mutation.
        previous["binaries"] = {**previous.get("binaries", {}), **{name: hashlib.sha256(source.read_bytes()).hexdigest() for name, source, _ in self.artifacts()}}
        previous["binary_sha256"] = previous["binaries"]["typerelay"]
        self.write_private(self.manifest, json.dumps(previous, indent=2) + "\n")
        if not automatic:
            self.privileged("install")
        rollback = tempfile.TemporaryDirectory(prefix="upgrade-", dir=self.data)
        old_binaries = []
        for name, _, destination in self.artifacts():
            backup = pathlib.Path(rollback.name) / name
            if destination.exists():
                shutil.copy2(destination, backup)
                old_binaries.append((destination, backup))
            else:
                old_binaries.append((destination, None))
        migration_backup = None
        storage_backup = None
        old_service_active = self.systemctl("is-active", "typerelay.service", check=False).returncode == 0
        try:
            if not automatic and conflicts["espanso_enabled"]:
                self.systemctl("disable", "espanso.service")
            if not automatic and conflicts["espanso_active"]:
                self.systemctl("stop", "espanso.service")
            if not automatic and conflicts["espanso_process"] and shutil.which("espanso"):
                self.command("espanso", "stop", check=False)
            self.systemctl("stop", "typerelay.service", check=False)
            self.stop_manual(conflicts["manual"])
            # The storage migration happens when the new engine first opens its database.
            # Back up the stopped client including SQLite/WAL and legacy files for rollback.
            storage_backup = pathlib.Path(tempfile.mkdtemp(prefix="storage-upgrade-", dir=self.data))
            if self.config.exists():
                shutil.copytree(self.config, storage_backup / "config", symlinks=True)
            panel_destination = self.destination.with_name("typerelay-panel")
            if panel_destination.exists() and any(name == "typerelay-panel" for name, _, _ in self.artifacts()):
                self.command(str(panel_destination), "--quit", check=False)
                time.sleep(0.3)
            self.destination.parent.mkdir(parents=True, exist_ok=True)
            for name, source, destination in self.artifacts():
                temporary = destination.with_name(name + ".new")
                shutil.copyfile(source, temporary)
                temporary.chmod(0o755)
                os.replace(temporary, destination)
            migration_backup = self.migrate_snippets()
            self.write_private(self.unit, self.service_text())
            self.systemctl("daemon-reload")
            variables = [name for name in ["WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_RUNTIME_DIR"] if os.environ.get(name)]
            if variables:
                self.systemctl("import-environment", *variables)
            self.systemctl("enable", "typerelay.service")
            if self.systemctl("is-active", "graphical-session.target", check=False).returncode == 0:
                self.systemctl("reset-failed", "typerelay.service", check=False)
                self.systemctl("start", "typerelay.service")
                time.sleep(1)
                if self.systemctl("is-active", "typerelay.service", check=False).returncode:
                    raise RuntimeError("Service failed to start; inspect journalctl --user -u typerelay -n 30")
            panel = self.destination.with_name("typerelay-panel")
            if any(name == "typerelay-panel" for name, _, _ in self.artifacts()):
                launcher = self.data.parent / "applications/typerelay-panel.desktop"
                self.write_private(launcher, "[Desktop Entry]\nType=Application\nName=TypeRelay\nExec=" + str(panel) + "\nTerminal=false\nCategories=Utility;\n")
                subprocess.Popen([str(panel), "--background"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            print("Installed. Manage with systemctl --user start|stop|restart typerelay.")
            print("Manage libraries in typerelay-tui. YAML files are import/export only.")
            if storage_backup:
                print("Upgrade backup: " + str(storage_backup))
        except Exception:
            self.systemctl("stop", "typerelay.service", check=False)
            self.systemctl("disable", "typerelay.service", check=False)
            if storage_backup and (storage_backup / "config").exists():
                for name in ("typerelay.sqlite", "typerelay.sqlite-wal", "typerelay.sqlite-shm"):
                    (self.snippets / name).unlink(missing_ok=True)
                shutil.copytree(storage_backup / "config", self.config, dirs_exist_ok=True, symlinks=True)
            if migration_backup:
                for item in json.loads((pathlib.Path(migration_backup) / "manifest.json").read_text()):
                    destination = pathlib.Path(item["path"])
                    if item["backup"]:
                        temporary = destination.with_name(destination.name + ".restore")
                        shutil.copy2(item["backup"], temporary)
                        os.replace(temporary, destination)
                    else:
                        destination.unlink(missing_ok=True)
            for destination, backup in old_binaries:
                if backup:
                    temporary = destination.with_name(destination.name + ".restore")
                    shutil.copy2(backup, temporary)
                    os.replace(temporary, destination)
                else:
                    destination.unlink(missing_ok=True)
            if old_manifest is not None:
                self.write_private(self.manifest, old_manifest.decode())
            if old_service_active:
                self.systemctl("enable", "typerelay.service", check=False)
                self.systemctl("start", "typerelay.service", check=False)
            if not automatic and conflicts["espanso_enabled"]:
                self.systemctl("enable", "espanso.service", check=False)
            if not automatic and conflicts["espanso_active"]:
                self.systemctl("start", "espanso.service", check=False)
            elif not automatic and conflicts["espanso_process"] and shutil.which("espanso"):
                self.command("espanso", "start", check=False)
            print("Installation incomplete. Snippets are preserved; rerun install or uninstall to recover.", file=sys.stderr)
            raise
        finally:
            rollback.cleanup()
            if automatic:
                shutil.rmtree(self.binary.parent, ignore_errors=True)

    def uninstall(self, dry_run):
        if not self.manifest.exists():
            print("No managed installation found. Snippets and standalone binary left untouched.")
            return
        state = json.loads(self.manifest.read_text())
        print("Stop TypeRelay clients and remove its service, managed binary and persistent input rules.")
        print("KEEP all snippet/config files: " + str(self.config))
        if dry_run:
            print("Dry run: nothing changed.")
            return
        if not self.prompt("Uninstall TypeRelay?"):
            print("Cancelled. Nothing changed.")
            return
        restore = (state.get("espanso_enabled") or state.get("espanso_active")) and self.prompt("Restore the previous Espanso startup/running state?")
        if self.unit.exists() and not self.unit.read_text().startswith(self.marker):
            raise RuntimeError("Service file was replaced with an unmanaged unit; refusing to remove it")
        if self.unit.exists():
            self.systemctl("disable", "--now", "typerelay.service")
        self.stop_manual(self.conflicts()["manual"])
        panel = self.destination.with_name("typerelay-panel")
        if panel.exists() and hashlib.sha256(panel.read_bytes()).hexdigest() == state.get("binaries", {}).get("typerelay-panel"):
            self.command(str(panel), "--quit", check=False)
        self.write_private(self.helper, self.permission_source)
        self.privileged("uninstall")
        self.unit.unlink(missing_ok=True)
        self.systemctl("daemon-reload")
        self.systemctl("reset-failed", "typerelay.service", check=False)
        hashes = state.get("binaries", {"typerelay": state.get("binary_sha256")})
        for name in ("typerelay", "typerelay-tui", "typerelay-panel"):
            destination = self.destination.with_name(name)
            if destination.exists():
                if hashlib.sha256(destination.read_bytes()).hexdigest() == hashes.get(name):
                    destination.unlink()
                else:
                    print("Preserved binary changed since installation or not owned: " + str(destination))
        panel = self.destination.with_name("typerelay-panel")
        for path in [self.data.parent / "applications/typerelay-panel.desktop", self.config.parent / "autostart/TypeRelay.desktop"]:
            if path.exists() and str(panel) in path.read_text():
                path.unlink()
        self.helper.unlink(missing_ok=True)
        self.manifest.unlink()
        if restore:
            if state.get("espanso_enabled"):
                self.systemctl("enable", "espanso.service")
            if state.get("espanso_active"):
                self.command("espanso", "start")
        print("Uninstalled. Your snippets are preserved.")

    @classmethod
    def run(cls):
        parser = argparse.ArgumentParser()
        parser.add_argument("action", choices=["install", "uninstall", "update"])
        parser.add_argument("binary")
        parser.add_argument("permission_source")
        parser.add_argument("--dry-run", action="store_true")
        args = parser.parse_args()
        if os.getuid() == 0:
            raise RuntimeError("Run the installer as your desktop user, not root")
        if args.action != "update" and not args.dry_run and not sys.stdin.isatty():
            raise RuntimeError("Run typerelay install/uninstall from an interactive terminal")
        installer = cls(args.binary, args.permission_source)
        if args.action == "update":
            installer.install(False, automatic=True)
        else:
            getattr(installer, args.action)(args.dry_run)


if __name__ == "__main__":
    try:
        Installer.run()
    except (RuntimeError, OSError, subprocess.CalledProcessError, EOFError, KeyboardInterrupt, ValueError) as error:
        print("Installer: " + str(error), file=sys.stderr)
        if len(sys.argv) > 1 and sys.argv[1] == "update" and shutil.which("notify-send"):
            subprocess.run(["notify-send", "TypeRelay update failed", str(error)], check=False)
        if len(sys.argv) > 2 and sys.argv[1] == "update":
            shutil.rmtree(pathlib.Path(sys.argv[2]).parent, ignore_errors=True)
        sys.exit(1)
