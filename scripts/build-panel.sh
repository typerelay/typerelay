#!/bin/sh
set -eu
panel_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
for dependency in node pnpm pkg-config; do
    command -v "$dependency" >/dev/null 2>&1 || { printf 'Missing panel build dependency: %s\n' "$dependency" >&2; exit 1; }
done
pkg-config --exists gtk+-3.0 webkit2gtk-4.1 || { printf '%s\n' 'Install GTK3 and WebKitGTK 4.1 development packages first.' >&2; exit 1; }
pnpm --dir "$panel_root" --filter typerelay-desktop install --frozen-lockfile
pnpm --dir "$panel_root" --filter typerelay-desktop build
cargo build --manifest-path "$panel_root/apps/desktop/src-tauri/Cargo.toml" --release --locked
panel_target_dir=$(node "$panel_root/scripts/build-cache.mjs" --target-directory "$panel_root/apps/desktop/src-tauri/Cargo.toml")
mkdir -p "$panel_root/target/release"
panel_binary="$panel_target_dir/release/typerelay-panel"
[ "$panel_binary" -ef "$panel_root/target/release/typerelay-panel" ] || cp "$panel_binary" "$panel_root/target/release/typerelay-panel"
node "$panel_root/scripts/build-cache.mjs" "$panel_target_dir/release"
printf '%s\n' 'Panel built. Install the matching bundle with target/release/typerelay install.'
