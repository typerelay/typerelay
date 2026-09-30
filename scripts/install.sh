#!/bin/sh
# Linux bootstrap. The block is parsed before running so piped scripts cannot
# consume installer answers; interactive prompts read from the controlling TTY.
{
    set -eu
    requested_ref=
    dry_run=false
    with_panel=true
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --ref)
                [ "$#" -ge 2 ] && [ -n "$2" ] || { printf '%s\n' 'Missing value for --ref' >&2; exit 2; }
                requested_ref=$2
                shift 2
                ;;
            --dry-run) dry_run=true; shift ;;
            --without-panel) with_panel=false; shift ;;
            --help|-h)
                printf '%s\n' 'TypeRelay Linux installer' 'Usage: sh install.sh [--dry-run] [--without-panel] [--ref BRANCH_TAG_OR_COMMIT]' 'Downloads the latest prebuilt release for Omarchy/Hyprland x86_64. Requires curl, Python 3 and tar.' '--ref builds from source instead; requires Rust/Cargo, gh/curl, and Node, pnpm, GTK3 and WebKitGTK 4.1 for the panel.'
                exit 0
                ;;
            *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
        esac
    done
    [ "$(uname -s)" = Linux ] || { printf '%s\n' 'This installer currently supports Omarchy/Linux only.' >&2; exit 1; }
    [ "$(id -u)" -ne 0 ] || { printf '%s\n' 'Run as your desktop user, not root. The installer requests administrator access when needed.' >&2; exit 1; }
    for dependency in python3 tar mktemp; do
        command -v "$dependency" >/dev/null 2>&1 || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
    done
    if [ "$dry_run" = false ] && ! ( : </dev/tty ) 2>/dev/null; then
        printf '%s\n' 'An interactive terminal is required. Use --dry-run to preview without prompts.' >&2
        exit 1
    fi

    bootstrap_dir=$(mktemp -d "${TMPDIR:-/tmp}/typerelay-install.XXXXXX")
    trap 'rm -rf "$bootstrap_dir"' 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [ -z "$requested_ref" ]; then
        [ "$(uname -m)" = x86_64 ] || { printf '%s\n' 'Prebuilt Linux releases require x86_64.' >&2; exit 1; }
        command -v curl >/dev/null 2>&1 || { printf '%s\n' 'Missing dependency: curl' >&2; exit 1; }
        release_url=https://transfer.typerelay.com/apps
        curl -fsSL --proto '=https' --proto-redir '=https' "$release_url/latest.json" -o "$bootstrap_dir/latest.json"
        version=$(python3 - "$bootstrap_dir/latest.json" <<'PY'
import json, pathlib, re, sys
latest = json.loads(pathlib.Path(sys.argv[1]).read_text())
version = latest.get("version", "")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
    sys.exit("Invalid TypeRelay release version.")
release = latest.get("platforms", {}).get("linux-x86_64", {})
expected = f"https://transfer.typerelay.com/apps/TypeRelay-Omarchy-{version}-x86_64.tar.gz"
if release.get("url") != expected or not release.get("signature"):
    sys.exit("The latest release has no valid Omarchy/Linux x86_64 bundle.")
print(version)
PY
        )
        printf 'Downloading TypeRelay %s for Omarchy/Hyprland. Existing installation remains active.\n' "$version"
        curl -fsSL --proto '=https' --proto-redir '=https' "$release_url/TypeRelay-$version-linux-x86_64.json" -o "$bootstrap_dir/release.json"
        curl -fsSL --proto '=https' --proto-redir '=https' "$release_url/TypeRelay-Omarchy-$version-x86_64.tar.gz" -o "$bootstrap_dir/bundle.tar.gz"
        python3 - "$bootstrap_dir" "$version" <<'PY'
import hashlib, json, pathlib, re, sys, tarfile
root = pathlib.Path(sys.argv[1])
version = sys.argv[2]
latest = json.loads((root / "latest.json").read_text())["platforms"]["linux-x86_64"]
release = json.loads((root / "release.json").read_text())
if release.get("version") != version or release.get("target") != "linux-x86_64" or release.get("updater") != latest:
    sys.exit("Linux release metadata does not match the latest release.")
name = f"TypeRelay-Omarchy-{version}-x86_64.tar.gz"
artifacts = [item for item in release.get("artifacts", []) if item.get("name") == name]
if len(artifacts) != 1 or not re.fullmatch(r"[0-9a-f]{64}", artifacts[0].get("sha256", "")):
    sys.exit("Linux release metadata is missing a valid bundle checksum.")
archive = root / "bundle.tar.gz"
if archive.stat().st_size != artifacts[0].get("size") or hashlib.sha256(archive.read_bytes()).hexdigest() != artifacts[0]["sha256"]:
    sys.exit("Linux bundle checksum or size mismatch. Nothing installed.")
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    expected = {"typerelay", "typerelay-tui", "typerelay-panel"}
    if len(members) != len(expected) or {item.name for item in members} != expected or any(not item.isfile() for item in members):
        sys.exit("Invalid Linux bundle: expected matching engine, TUI and panel files.")
print("Linux bundle checksum verified.")
PY
        installer_dir="$bootstrap_dir/bundle"
        mkdir "$installer_dir"
        tar -xzf "$bootstrap_dir/bundle.tar.gz" -C "$installer_dir"
        if [ "$with_panel" = false ]; then
            rm "$installer_dir/typerelay-panel"
        fi
    else
        command -v cargo >/dev/null 2>&1 || { printf '%s\n' 'Missing dependency for --ref source build: cargo' >&2; exit 1; }
        encoded_ref=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$requested_ref")
        authenticated=false
        if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
            authenticated=true
            gh api --hostname github.com "repos/typerelay/typerelay/commits/$encoded_ref" > "$bootstrap_dir/commit.json" </dev/null
        else
            command -v curl >/dev/null 2>&1 || { printf '%s\n' 'Install gh and sign in, or install curl for public repository access.' >&2; exit 1; }
            if ! curl -fsSL "https://api.github.com/repos/typerelay/typerelay/commits/$encoded_ref" -o "$bootstrap_dir/commit.json"; then
                printf '%s\n' 'Cannot access this repository/ref. While private, run gh auth login with an authorized GitHub account, then retry.' >&2
                exit 1
            fi
        fi
        commit=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["sha"])' "$bootstrap_dir/commit.json")
        case "$commit" in *[!0-9a-f]*|'') printf '%s\n' 'Invalid commit returned by GitHub.' >&2; exit 1 ;; esac
        [ "${#commit}" -eq 40 ] || { printf '%s\n' 'Unexpected GitHub commit identifier.' >&2; exit 1; }
        printf 'Downloading TypeRelay commit %s\n' "$commit"
        if [ "$authenticated" = true ]; then
            gh api --hostname github.com "repos/typerelay/typerelay/tarball/$commit" > "$bootstrap_dir/source.tar.gz" </dev/null
        else
            curl -fsSL "https://api.github.com/repos/typerelay/typerelay/tarball/$commit" -o "$bootstrap_dir/source.tar.gz"
        fi
        mkdir "$bootstrap_dir/source"
        tar -xzf "$bootstrap_dir/source.tar.gz" -C "$bootstrap_dir/source" --strip-components=1
        printf '%s\n' 'Building TypeRelay from the downloaded source. Existing installation remains active.'
        cargo build --manifest-path "$bootstrap_dir/source/Cargo.toml" --workspace --bins --release --locked --target-dir "$bootstrap_dir/target" </dev/null
        if [ "$with_panel" = true ]; then
            sh "$bootstrap_dir/source/scripts/build-panel.sh" </dev/null
            cp "$bootstrap_dir/source/target/release/typerelay-panel" "$bootstrap_dir/target/release/typerelay-panel"
        fi
        installer_dir="$bootstrap_dir/target/release"
    fi
    if [ "$dry_run" = true ]; then
        "$installer_dir/typerelay" install --dry-run </dev/null
    else
        "$installer_dir/typerelay" install </dev/tty
    fi
}
