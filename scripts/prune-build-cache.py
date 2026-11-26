"""Trim reproducible Cargo intermediates in this checkout's local build directories."""

import os
import shutil
import stat
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl

CACHE_LIMIT = 20 * 1024**3
CACHE_NAMES = (".fingerprint", "build", "deps", "incremental")
CARGO_LOCKS = (".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock")


def local_directory(directory):
    return directory.is_dir() and directory.resolve() == directory


def disk_usage(directory):
    if os.name == "nt":
        total = 0
        pending = [directory]
        while pending:
            for entry in pending.pop().iterdir():
                info = entry.lstat()
                if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    continue
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry)
                elif stat.S_ISREG(info.st_mode):
                    total += info.st_size
        return total
    usage = subprocess.check_output(["du", "-skx", str(directory)])
    return int(usage.split(maxsplit=1)[0]) * 1024


def lock_cargo_file(fd):
    if os.name == "nt":
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


@contextmanager
def try_locks(files):
    with ExitStack() as locks:
        try:
            for file in files:
                if file.is_symlink() or file.resolve() != file:
                    raise OSError("unexpected lock path")
                fd = os.open(file, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), 0o600)
                locks.callback(os.close, fd)
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise OSError("unexpected lock type")
                lock_cargo_file(fd)
        except OSError:
            yield False
        else:
            yield True


def profiles(target):
    for parent in (target, *(entry for entry in target.iterdir() if entry.name != "desktop-releases" and local_directory(entry))):
        for directory in parent.iterdir():
            if local_directory(directory) and any((directory / name).is_file() for name in CARGO_LOCKS):
                yield directory
            # The Windows test script uses its own target directory inside the workspace target.
            elif parent.name == "windows-test" and local_directory(directory):
                yield from (child for child in directory.iterdir() if local_directory(child) and any((child / name).is_file() for name in CARGO_LOCKS))


def trim(target, limit=CACHE_LIMIT, protected_profiles=()):
    if not local_directory(target):
        return
    with try_locks((target / ".typerelay-build-cleanup.lock",)) as acquired:
        if acquired and disk_usage(target) > limit:
            trim_profiles(target, limit, {Path(directory).resolve() for directory in protected_profiles})


def trim_profiles(target, limit, protected_profiles):
    candidates = []
    for directory in profiles(target):
        if directory in protected_profiles:
            continue
        caches = [directory / name for name in CACHE_NAMES if local_directory(directory / name)]
        if not caches:
            continue
        # Cargo may place new outputs in existing subdirectories without touching the profile itself.
        modified = max((file.lstat().st_mtime for cache in caches for file in cache.iterdir()), default=directory.stat().st_mtime)
        candidates.append((modified, directory))

    for _, directory in sorted(candidates):
        if not local_directory(directory):
            continue
        # Hold the legacy and split Cargo locks through deletion. Never unlink the lock files.
        with try_locks(directory / name for name in CARGO_LOCKS) as acquired:
            if not acquired:
                continue
            for name in CACHE_NAMES:
                cache = directory / name
                if local_directory(cache):
                    shutil.rmtree(cache)
        print(f"Removed compiler intermediates from {directory}", flush=True)
        if disk_usage(target) <= limit:
            break


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    for relative in ("target", "apps/desktop/src-tauri/target"):
        try:
            trim(root / relative, protected_profiles=sys.argv[1:])
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            print(f"Compiler cache cleanup skipped for {relative}: {error}", file=sys.stderr)
