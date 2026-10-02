#!/usr/bin/env python3
"""Scoped input access: temporary grants or persistent per-user udev rules."""
import argparse
import json
import os
import pathlib
import pwd
import subprocess


class SessionAccess:
    marker = "# Managed by TypeRelay"

    def __init__(self, root="/", device_name="auto"):
        self.root = pathlib.Path(root)
        if not device_name or any(c in device_name for c in '\n\r\0"\\*?[]'):
            raise ValueError("Keyboard name contains unsupported udev-rule characters")
        self.device_name = device_name

    def devices(self):
        for entry in (self.root / "sys/class/input").glob("event*"):
            path = self.root / "dev/input" / entry.name
            name = (entry / "device/name").read_text().strip()
            properties = subprocess.check_output(["/usr/bin/udevadm", "info", "--query=property", "--name", str(path)], text=True).splitlines()
            yield name, path, properties

    def select_keyboard(self, requested=None):
        if requested in (None, "auto"):
            self.__init__(self.root, "auto")
            return self.device_name
        keyboards = [(name, properties) for name, _, properties in self.devices() if "ID_INPUT_KEYBOARD=1" in properties]
        keyd = [name for name, _ in keyboards if name == "keyd virtual keyboard"]
        if requested and keyd and requested != "keyd virtual keyboard":
            raise RuntimeError("Stop keyd before selecting a physical keyboard")
        candidates = [name for name, _ in keyboards if name == requested] if requested else keyd or [name for name, properties in keyboards if "ID_INTEGRATION=internal" in properties] or [name for name, _ in keyboards if "virtual" not in name.lower()]
        if len(candidates) != 1:
            choices = ", ".join(name for name, _ in keyboards)
            raise RuntimeError("Select exactly one keyboard with --device-name. Available keyboards: " + choices)
        self.__init__(self.root, candidates[0])
        return self.device_name

    def paths(self, previous=()):
        paths = [("uinput", self.root / "dev/uinput", "rw")]
        for name, path, properties in self.devices():
            if ("ID_INPUT_KEYBOARD=1" in properties and (name == self.device_name or self.device_name == "auto" and any(p.startswith("DEVPATH=/devices/") and not p.startswith("DEVPATH=/devices/virtual/input/") for p in properties))) or name in previous or any(p in properties for p in ["ID_INPUT_MOUSE=1", "ID_INPUT_TOUCHPAD=1", "ID_INPUT_TOUCHSCREEN=1"]):
                paths.append((name, path, "r"))
        return paths

    def rules(self, uid):
        lines = [self.marker]
        access = f'RUN+="/usr/bin/setfacl -m u:{uid}:r $env{{DEVNAME}}"'
        selector = 'DEVPATH!="/devices/virtual/input/*", ' if self.device_name == "auto" else f'ATTRS{{name}}=="{self.device_name}", '
        lines.append('ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", ' + selector + access)
        for kind in ["MOUSE", "TOUCHPAD", "TOUCHSCREEN"]:
            lines.append(f'ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ENV{{ID_INPUT_{kind}}}=="1", ' + access)
        lines.append(f'ACTION!="remove", SUBSYSTEM=="misc", KERNEL=="uinput", RUN+="/usr/bin/setfacl -m u:{uid}:rw $env{{DEVNAME}}"')
        return "\n".join(lines) + "\n"

    def acl(self, path, uid):
        lines = subprocess.check_output(["/usr/bin/getfacl", "-ncp", str(path)], text=True).splitlines()
        prefix = f"user:{uid}:"
        return next((line[len(prefix):].split()[0] for line in lines if line.startswith(prefix)), None)

    def set_acl(self, path, uid, permission):
        operation = ["-m", f"u:{uid}:{permission}"] if permission else ["-x", f"u:{uid}"]
        if permission or self.acl(path, uid) is not None:
            subprocess.run(["/usr/bin/setfacl", *operation, str(path)], check=True)

    def managed_write(self, path, text):
        if path.exists() and not path.read_text().startswith(self.marker):
            raise RuntimeError(f"Refusing to overwrite unmanaged file: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".new")
        temporary.write_text(text)
        temporary.chmod(0o644)
        os.replace(temporary, path)

    def persistent(self, action, uid):
        rule = self.root / f"etc/udev/rules.d/99-typerelay-{uid}.rules"
        module = self.root / f"etc/modules-load.d/typerelay-{uid}.conf"
        state_path = self.root / f"var/lib/typerelay/access-{uid}.json"
        if action == "install":
            subprocess.run(["/usr/bin/modprobe", "uinput"], check=True)
            paths = self.paths()
            previous = json.loads(state_path.read_text()) if state_path.exists() else {}
            for name, path, _ in paths:
                if name not in previous:
                    previous[name] = self.acl(path, uid)
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps(previous, indent=2) + "\n")
            state_path.chmod(0o600)
            self.managed_write(rule, self.rules(uid))
            self.managed_write(module, self.marker + "\nuinput\n")
            subprocess.run(["/usr/bin/udevadm", "verify", str(rule)], check=True)
            subprocess.run(["/usr/bin/udevadm", "control", "--reload"], check=True)
            for _, path, permission in paths:
                self.set_acl(path, uid, permission)
            print("Persistent input access installed.")
        else:
            for path in [rule, module]:
                if path.exists():
                    if not path.read_text().startswith(self.marker):
                        raise RuntimeError(f"Refusing to remove unmanaged file: {path}")
                    path.unlink()
            subprocess.run(["/usr/bin/udevadm", "control", "--reload"], check=True)
            if state_path.exists():
                previous = json.loads(state_path.read_text())
                for name, path, permission in self.paths(previous):
                    if self.acl(path, uid) == permission.ljust(3, "-"):
                        self.set_acl(path, uid, previous.get(name))
                state_path.unlink()
            print("Persistent input access removed; previous ACLs restored.")

    def run(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("action", choices=["grant", "revoke", "install", "uninstall", "render-rules"])
        parser.add_argument("user")
        parser.add_argument("--device-name", default=self.device_name)
        args = parser.parse_args()
        self.__init__(device_name=args.device_name)
        account = pwd.getpwnam(args.user)
        if args.action == "render-rules":
            print(self.rules(account.pw_uid), end="")
            return
        if os.geteuid() != 0 or account.pw_uid == 0:
            parser.error("Use administrator privileges and a non-root desktop user")
        if args.action in ("install", "uninstall"):
            return self.persistent(args.action, account.pw_uid)
        for _, path, permission in self.paths():
            self.set_acl(path, account.pw_uid, permission if args.action == "grant" else None)
            print(f"{args.action}: {path}")


if __name__ == "__main__":
    SessionAccess().run()
