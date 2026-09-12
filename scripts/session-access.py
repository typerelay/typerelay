#!/usr/bin/env python3
"""Grant/revoke temporary access to this session's keyd keyboard and pointers.

Run using pkexec or sudo. Never changes groups, capabilities or world permissions.
Grants disappear when device nodes are recreated (usually reboot).
"""
import argparse
import os
import pathlib
import pwd
import subprocess


class SessionAccess:
    def run(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("action", choices=["grant", "revoke"])
        parser.add_argument("user")
        args = parser.parse_args()
        account = pwd.getpwnam(args.user)
        if os.geteuid() != 0 or account.pw_uid == 0:
            parser.error("Use administrator privileges and a non-root desktop user")
        paths = [pathlib.Path("/dev/uinput")]
        for entry in pathlib.Path("/sys/class/input").glob("event*"):
            path = pathlib.Path("/dev/input") / entry.name
            name = (entry / "device/name").read_text().strip()
            properties = subprocess.check_output(["/usr/bin/udevadm", "info", "--query=property", "--name", str(path)], text=True).splitlines()
            if name == "keyd virtual keyboard" or any(p in properties for p in ["ID_INPUT_MOUSE=1", "ID_INPUT_TOUCHPAD=1", "ID_INPUT_TOUCHSCREEN=1"]):
                paths.append(path)
        for path in paths:
            permission = "rw" if path.name == "uinput" else "r"
            operation = ["-m", f"u:{account.pw_uid}:{permission}"] if args.action == "grant" else ["-x", f"u:{account.pw_uid}"]
            subprocess.run(["/usr/bin/setfacl", *operation, str(path)], check=True)
            print(f"{args.action}: {path}")


if __name__ == "__main__":
    SessionAccess().run()
