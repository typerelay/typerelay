#!/bin/sh
# GitHub bootstrap. The block is parsed before running so piped scripts cannot
# consume installer answers; interactive prompts read from the controlling TTY.
{
    set -eu
    requested_ref=main
    dry_run=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --ref)
                [ "$#" -ge 2 ] || { printf '%s\n' 'Missing value for --ref' >&2; exit 2; }
                requested_ref=$2
                shift 2
                ;;
            --dry-run) dry_run=true; shift ;;
            --help|-h)
                printf '%s\n' 'TypeRelay GitHub installer' 'Usage: sh install.sh [--ref BRANCH_TAG_OR_COMMIT] [--dry-run]' 'Requires Linux, Rust/Cargo, Python 3, tar, and gh or curl.'
                exit 0
                ;;
            *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
        esac
    done
    [ "$(uname -s)" = Linux ] || { printf '%s\n' 'This installer currently supports Omarchy/Linux only.' >&2; exit 1; }
    [ "$(id -u)" -ne 0 ] || { printf '%s\n' 'Run as your desktop user, not root. The installer requests administrator access when needed.' >&2; exit 1; }
    for dependency in cargo python3 tar mktemp; do
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
    if [ "$dry_run" = true ]; then
        "$bootstrap_dir/target/release/typerelay" install --dry-run </dev/null
    else
        "$bootstrap_dir/target/release/typerelay" install </dev/tty
    fi
}
