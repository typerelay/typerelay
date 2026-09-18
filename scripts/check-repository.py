#!/usr/bin/env python3
"""Read-only tracked credential and runtime-file checks."""
import pathlib
import subprocess


class RepositoryPolicy:
    @staticmethod
    def sensitive_path(path):
        name = pathlib.PurePosixPath(path).name.lower()
        return (
            pathlib.PurePosixPath(name).suffix in {".pem", ".key", ".p8", ".p12", ".pfx", ".jks", ".keystore", ".sqlite", ".db"}
            or name.endswith((".sqlite-wal", ".sqlite-shm"))
            or (name.startswith(".env") and not name.endswith(".example"))
            or (name.startswith(("id_rsa", "id_ed25519")) and not name.endswith(".pub"))
            or (name.startswith("credentials") and name.endswith(".json"))
        )

    @classmethod
    def run(cls):
        files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
        forbidden = [path for path in files if path and cls.sensitive_path(path)]
        if forbidden:
            raise SystemExit("Credential/runtime files must not be tracked: " + ", ".join(forbidden))
        print("Repository policy checks passed")


if __name__ == "__main__":
    RepositoryPolicy.run()
