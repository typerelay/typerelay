#!/usr/bin/env python3
"""Read-only Git-flow PR routing and tracked credential-file checks."""
import json
import os
import pathlib
import subprocess
import sys


class RepositoryPolicy:
    @staticmethod
    def valid_pull_request(base, head):
        if base == "main":
            return head.startswith(("release/", "hotfix/"))
        if base == "develop":
            return head == "main" or head.startswith(("feature/", "bugfix/", "release/", "hotfix/"))
        if base.startswith("release/"):
            return head.startswith("bugfix/")
        return False

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
        if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
            event = json.loads(pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            pr = event["pull_request"]
            base, head = pr["base"]["ref"], pr["head"]["ref"]
            if not cls.valid_pull_request(base, head):
                raise SystemExit(f"Invalid Git-flow route: {head} → {base}. See docs/development/git-flow.md")
        print("Repository policy checks passed")


if __name__ == "__main__":
    RepositoryPolicy.run()
