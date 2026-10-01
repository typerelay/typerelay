#!/bin/sh
set -eu
cargo test --locked -p typerelay-client --lib --no-default-features --features desktop installation::tests
cargo build --locked --no-default-features --features desktop,ai-runtime --bin typerelay --bin typerelay-tui --bin typerelay-ai
target="${CARGO_TARGET_DIR:-target}/debug"
for command in install setup uninstall update; do
    if "$target/typerelay" "$command" --help >/dev/null 2>&1; then
        echo "Legacy installer command remains: $command" >&2
        exit 1
    fi
done
if strings "$target/typerelay" | grep -q 'Interactive per-user TypeRelay installer'; then
    echo 'Legacy Python installer is embedded in the native package engine' >&2
    exit 1
fi
mkdir -p apps/desktop/src-tauri/binaries
cp "$target/typerelay" apps/desktop/src-tauri/binaries/typerelay-x86_64-unknown-linux-gnu
cp "$target/typerelay-ai" apps/desktop/src-tauri/binaries/typerelay-ai-x86_64-unknown-linux-gnu
cp "$target/typerelay-tui" apps/desktop/src-tauri/binaries/typerelay-tui-x86_64-unknown-linux-gnu
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
python3 -m unittest scripts.tests.test_appimage_cli
dbus-run-session -- cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- --include-ignored
