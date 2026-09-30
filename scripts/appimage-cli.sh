#!/bin/sh
# Managed by TypeRelay
set -eu
tool=${0##*/}
case "$tool" in
    typerelay) mode=--cli ;;
    typerelay-tui) mode=--tui-cli ;;
    *) printf '%s\n' 'Unknown TypeRelay command.' >&2; exit 1 ;;
esac
if [ -x "/usr/bin/$tool" ]; then
    exec "/usr/bin/$tool" "$@"
fi
reference="${XDG_DATA_HOME:-${HOME:?HOME is missing}/.local/share}/typerelay/appimage-path"
if [ ! -r "$reference" ] || ! IFS= read -r appimage < "$reference"; then
    printf '%s\n' 'Launch the TypeRelay AppImage once to register terminal commands for this user.' >&2
    exit 1
fi
if [ ! -x "$appimage" ]; then
    printf '%s\n' 'The registered TypeRelay AppImage is missing. Launch its new location to register it again.' >&2
    exit 1
fi
# Reuse AppImageLauncher's registered helper without Qt or interpreter status output.
registration=/proc/sys/fs/binfmt_misc/appimage-type2
if [ -r "$registration" ]; then
    bypass=$(sed -n 's|^interpreter \(.*\)/appimagelauncher/binfmt-interpreter$|\1/appimagelauncher/binfmt-bypass|p' "$registration")
    if [ -x "$bypass" ]; then
        exec "$bypass" "$appimage" "$mode" "$@"
    fi
fi
export APPIMAGELAUNCHER_DISABLE=1
exec "$appimage" "$mode" "$@"
