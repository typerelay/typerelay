#!/bin/sh
set -eu
panel_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
for dependency in node pnpm pkg-config; do
    command -v "$dependency" >/dev/null 2>&1 || { printf 'Missing panel build dependency: %s\n' "$dependency" >&2; exit 1; }
done
pkg-config --exists gtk+-3.0 webkit2gtk-4.1 || { printf '%s\n' 'Install GTK3 and WebKitGTK 4.1 development packages first.' >&2; exit 1; }
pnpm --dir "$panel_root" --filter typerelay-desktop install --frozen-lockfile
pnpm --dir "$panel_root" --filter typerelay-desktop build
node "$panel_root/scripts/sync-desktop-version.mjs"
cargo build --manifest-path "$panel_root/apps/desktop/src-tauri/Cargo.toml" --release --locked
mkdir -p "$panel_root/target/release"
cp "$panel_root/apps/desktop/src-tauri/target/release/typerelay-panel" "$panel_root/target/release/typerelay-panel"
printf '%s\n' 'Panel built. Install the matching bundle with target/release/typerelay install.'
