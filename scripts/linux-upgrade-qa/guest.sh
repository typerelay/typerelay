#!/usr/bin/env bash
set -eEuo pipefail
umask 077

legacy_engine=497c40d7e07a659208a7a960540993e5ad362c2879b894aae9b85e18452e7993
legacy_tui=f4fbf0cc599da351941bf7c4cae5faad617bfc338893463882b3f13e427a05e9
legacy_settings='{"shortcut":"Ctrl+Alt+Semicolon","launch_at_login":false,"keyboard":"auto","keyboard_fallback":""}'

fail() { printf '%s\n' "$*" >&2; exit 1; }
trap 'printf "Guest QA failed at line %s\n" "$LINENO" >&2' ERR
[[ $EUID != 0 ]] || fail 'Run as the disposable QA user.'

check_sha() {
    printf '%s  %s\n' "$2" "$1" | sha256sum --check --strict
}

use_profile() {
    export HOME="$1"
    export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
    export XDG_RUNTIME_DIR="$HOME/run" XDG_STATE_HOME="$HOME/.local/state"
    export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
    mkdir -p "$HOME/.local/bin" "$XDG_RUNTIME_DIR"
}

seed() (
    local archive=$1 output=$2
    [[ $archive == /* && -f $archive && $output == /* && ! -e $output ]] || fail 'Give an existing absolute legacy archive path and a new absolute output path.'
    use_profile "$work/profile"
    tar -xzf "$archive" -C "$HOME/.local/bin" typerelay typerelay-tui
    check_sha "$HOME/.local/bin/typerelay" "$legacy_engine"
    check_sha "$HOME/.local/bin/typerelay-tui" "$legacy_tui"
    [[ $(typerelay --version) == 'typerelay 1.3.3' ]]
    [[ $(typerelay-tui --version) == 'typerelay-tui 1.3.3' ]]
    mkdir -p "$XDG_CONFIG_HOME/typerelay" "$XDG_DATA_HOME/typerelay"
    printf '%s\n' "$legacy_settings" > "$XDG_CONFIG_HOME/typerelay/panel.json"
    jq -n --arg engine "$legacy_engine" --arg tui "$legacy_tui" '{binaries: {typerelay: $engine, "typerelay-tui": $tui}, binary_sha256: $engine, device_name: "auto"}' > "$XDG_DATA_HOME/typerelay/installation.json"
    printf 'matches:\n  - trigger: qa-upgrade\n    replace: Upgrade fixture survives.\n' > "$work/snippet.yml"
    typerelay import yaml "$work/snippet.yml" --name upgrade-qa
    typerelay export upgrade-qa "$HOME/.qa-original-export.yml"
    grep -Fq 'Upgrade fixture survives.' "$HOME/.qa-original-export.yml"
    tar -czf "$work/profile.tar.gz" -C "$HOME" .local .config .qa-original-export.yml
    (set -o noclobber; cat "$work/profile.tar.gz" > "$output")
)

if [[ ${1:-} == seed ]]; then
    [[ $# == 3 ]] || fail 'Usage: guest.sh seed <legacy-archive> <fixture.tar.gz>'
    work=$(mktemp -d)
    trap 'rm -r -- "$work"' EXIT
    seed "$2" "$3"
    exit
fi

[[ $# == 5 ]] || fail 'Usage: guest.sh <appimage|deb|rpm> <version> <package> <sha256> <fixture.tar.gz>'
format=$1 version=$2 package=$3 package_sha=$4 fixture=$5
[[ $package == /* && -f $package && $fixture == /* && -f $fixture && $package_sha =~ ^[0-9a-f]{64}$ ]] || fail 'Give absolute package and fixture paths and the package SHA-256.'
[[ $(uname -m) == x86_64 ]] || fail 'Linux upgrade QA needs x86_64.'
# shellcheck disable=SC1091
source /etc/os-release
case "$format/$ID" in
    appimage/omarchy) ;;
    appimage/arch)
        omarchy_package=$(pacman -Q omarchy) || fail 'AppImage upgrade QA needs Omarchy.'
        PRETTY_NAME="$PRETTY_NAME with $omarchy_package"
        ;;
    deb/debian) [[ $VERSION_ID == 12 ]] || fail 'DEB upgrade QA needs Debian 12.' ;;
    rpm/fedora) ;;
    *) fail "Unexpected distribution for $format: $ID." ;;
esac
case "$(systemd-detect-virt --vm)" in
    kvm|qemu) ;;
    *) fail 'Run package checks inside a disposable QEMU guest.' ;;
esac
if [[ -z ${TYPERELAY_QA_DBUS:-} ]]; then
    unset DBUS_SESSION_BUS_ADDRESS AT_SPI_BUS_ADDRESS
    export TYPERELAY_QA_DBUS=1
    exec dbus-run-session -- bash "$0" "$@"
fi
printf 'Testing %s on %s\n' "$format" "$PRETTY_NAME"
check_sha "$package" "$package_sha"
export PATH=/usr/local/bin:/usr/bin:/bin
export APPIMAGELAUNCHER_DISABLE=1
case "$format" in
    appimage)
        chmod u+x "$package"
        [[ $(timeout 30s "$package" --cli --version) == "typerelay $version" ]]
        [[ $(timeout 30s "$package" --tui-cli --version) == "typerelay-tui $version" ]]
        sudo -n env PKEXEC_UID="$EUID" APPIMAGELAUNCHER_DISABLE=1 "$package" --input-access auto
        panel_command=$package
        ;;
    deb)
        [[ $(dpkg-deb -f "$package" Package) == type-relay && $(dpkg-deb -f "$package" Version) == "$version" ]]
        sudo -n env DEBIAN_FRONTEND=noninteractive dpkg --install "$package"
        [[ $(dpkg-query -W -f='${Version} ${Status}' type-relay) == "$version install ok installed" ]]
        panel_command=/usr/bin/typerelay-panel
        ;;
    rpm)
        [[ $(rpm -qp --queryformat '%{NAME} %{VERSION}' "$package") == "type-relay $version" ]]
        if rpm -q type-relay >/dev/null; then sudo -n dnf -y --disablerepo='*' remove type-relay; fi
        sudo -n dnf -y --disablerepo='*' install "$package"
        [[ $(rpm -q --queryformat '%{VERSION}' type-relay) == "$version" ]]
        panel_command=/usr/bin/typerelay-panel
        ;;
esac
[[ $(timeout 30s "$panel_command" --version) == "typerelay-panel $version" ]]

work=$(mktemp -d /tmp/typerelay-qa.XXXXXXXX)
xvfb= accessibility= registry=
cleanup() {
    local status=$?
    if ((status)); then
        for log in "$work"/*/panel.log "$work"/xvfb.log "$work"/accessibility.log; do
            if [[ -f $log ]]; then tail -n 60 "$log" >&2; fi
        done
    fi
    for pid in "$registry" "$accessibility" "$xvfb"; do
        if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    done
    rm -r -- "$work"
}
trap cleanup EXIT
Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp > "$work/xvfb.log" 2>&1 3>"$work/display" &
xvfb=$!
for ((attempt=0; attempt<100; attempt++)); do
    if [[ -s $work/display ]]; then break; fi
    kill -0 "$xvfb" 2>/dev/null || fail 'Xvfb exited.'
    sleep .1
done
[[ -s $work/display ]] || fail 'Xvfb did not report a display.'
export DISPLAY=":$(<"$work/display")" XDG_CURRENT_DESKTOP=XFCE GDK_BACKEND=x11
unset HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY AT_SPI_BUS_ADDRESS NO_AT_BRIDGE XAUTHORITY
xdotool getdisplaygeometry >/dev/null
python3 -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi'
accessibility_launcher=/usr/libexec/at-spi-bus-launcher
if [[ ! -x $accessibility_launcher ]]; then accessibility_launcher=/usr/lib/at-spi-bus-launcher; fi
# Fedora's standalone session bus cannot activate this executable under SELinux.
"$accessibility_launcher" > "$work/accessibility.log" 2>&1 &
accessibility=$!
for ((attempt=0; attempt<50; attempt++)); do
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.a11y.Bus | grep -q 'boolean true'; then break; fi
    kill -0 "$accessibility" 2>/dev/null || fail 'Accessibility bus launcher exited.'
    sleep .1
done
dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:IsEnabled variant:boolean:true >/dev/null
AT_SPI_BUS_ADDRESS=$(dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress | sed -n 's/^ *string "\(.*\)"/\1/p')
[[ -n $AT_SPI_BUS_ADDRESS ]] || fail 'Accessibility bus address is missing.'
export AT_SPI_BUS_ADDRESS
DBUS_SESSION_BUS_ADDRESS="$AT_SPI_BUS_ADDRESS" "${accessibility_launcher%/*}/at-spi2-registryd" >> "$work/accessibility.log" 2>&1 &
registry=$!
for ((attempt=0; attempt<50; attempt++)); do
    if dbus-send --bus="$AT_SPI_BUS_ADDRESS" --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.a11y.atspi.Registry | grep -q 'boolean true'; then break; fi
    kill -0 "$registry" 2>/dev/null || fail 'Accessibility registry exited.'
    sleep .1
done
((attempt < 50)) || fail 'Accessibility registry did not start.'

assert_commands() {
    local command directory=/usr/bin
    if [[ $format == appimage ]]; then directory=/usr/local/bin; fi
    type -a typerelay typerelay-tui
    for command in typerelay typerelay-tui; do
        [[ $(command -v "$command") == "$directory/$command" ]]
        [[ $(timeout 30s "$command" --version) == "$command $version" ]]
    done
}

warning_names_path() {
    xdotool search --onlyvisible --name '^TypeRelay terminal commands$' >/dev/null || return 1
    timeout 4s python3 - "$HOME/.local/bin/typerelay" <<'PY'
import sys

import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def names_path(node):
    if node.get_role() in (Atspi.Role.LABEL, Atspi.Role.TEXT) and sys.argv[1] in (node.get_name() or ''):
        return True
    return any(names_path(child) for child in children(node))


found = any(
    names_path(window)
    for app in children(Atspi.get_desktop(0))
    for window in children(app)
    if window.get_role() == Atspi.Role.ALERT
)
sys.exit(not found)
PY
}

panel_ready() {
    [[ -S $XDG_RUNTIME_DIR/typerelay-panel/events.sock ]] || return 1
    if [[ $format == appimage ]]; then
        [[ -f $XDG_DATA_HOME/typerelay/appimage-path ]] && [[ $(<"$XDG_DATA_HOME/typerelay/appimage-path") == "$package" ]]
    fi
}

test_tui() (
    local tmux_command=(tmux -f /dev/null -S "$HOME/tmux.sock")
    export SHELL=/bin/bash
    unset DBUS_SESSION_BUS_ADDRESS
    trap '"${tmux_command[@]}" kill-server 2>/dev/null || true' EXIT
    screen_has() {
        local screen
        for ((attempt=0; attempt<40; attempt++)); do
            screen=$("${tmux_command[@]}" capture-pane -pt editor -S -200) || return 1
            if [[ $screen == *"$1"* ]]; then return; fi
            sleep .25
        done
        printf '%s\n' "$screen" >&2
        fail "TUI did not show $1"
    }
    keys() {
        "${tmux_command[@]}" send-keys -t editor "$@"
        sleep .25
    }
    open_editor() {
        "${tmux_command[@]}" new-session -d -s editor -x 140 -y 42 'typerelay-tui; status=$?; printf "TUI exited %s\n" "$status"; sleep 10'
        screen_has 'upgrade-qa'
        keys Down Enter
        screen_has 'qa-upgrade'
        keys Enter
        screen_has 'Upgrade fixture survives.'
    }
    open_editor
    keys F11
    screen_has 'Tab key'
    keys Down Down Down Down Down Down Enter
    screen_has '{{key:tab}}'
    keys C-s
    for ((attempt=0; attempt<20; attempt++)); do
        timeout 15s typerelay export upgrade-qa "$HOME/tab-export.yml" >/dev/null
        if grep -Fq '{{key:tab}}' "$HOME/tab-export.yml"; then break; fi
        sleep .25
    done
    grep -Fq '{{key:tab}}' "$HOME/tab-export.yml"
    keys C-q
    screen_has 'TUI exited 0'
    "${tmux_command[@]}" kill-server
    open_editor
    screen_has '{{key:tab}}'
    keys C-q
    screen_has 'TUI exited 0'
    printf 'TUI F11 Tab key saved and reopened successfully\n'
)

test_profile() (
    local kind=$1 panel= backups=() sentinel
    use_profile "$work/$kind"
    shopt -s nullglob
    stop_panel() {
        if [[ -n $panel ]]; then
            timeout 10s "$panel_command" --quit || true
            kill "$panel" 2>/dev/null || true
            wait "$panel" 2>/dev/null || true
        fi
    }
    trap stop_panel EXIT
    launch() {
        rm -f -- "$XDG_RUNTIME_DIR/typerelay-panel/events.sock"
        "$panel_command" --background >> "$HOME/panel.log" 2>&1 &
        panel=$!
        for ((attempt=0; attempt<100; attempt++)); do
            kill -0 "$panel" 2>/dev/null || fail "Panel exited for $kind profile."
            if panel_ready && "$@"; then return; fi
            sleep .25
        done
        fail "Panel setup did not complete for $kind profile."
    }
    managed_retired() {
        [[ ! -e $HOME/.local/bin/typerelay && ! -e $HOME/.local/bin/typerelay-tui ]]
    }
    assert_backup() {
        backups=("$HOME"/.local/bin/.typerelay-legacy-*)
        [[ ${#backups[@]} == 1 ]]
        check_sha "${backups[0]}/typerelay" "$legacy_engine"
        check_sha "${backups[0]}/typerelay-tui" "$legacy_tui"
    }

    case "$kind" in
        managed)
            tar -xzf "$fixture" -C "$HOME"
            check_sha "$HOME/.local/bin/typerelay" "$legacy_engine"
            check_sha "$HOME/.local/bin/typerelay-tui" "$legacy_tui"
            [[ $(command -v typerelay) == "$HOME/.local/bin/typerelay" && $(command -v typerelay-tui) == "$HOME/.local/bin/typerelay-tui" ]]
            jq -e --arg engine "$legacy_engine" --arg tui "$legacy_tui" '.binary_sha256 == $engine and .binaries.typerelay == $engine and .binaries["typerelay-tui"] == $tui' "$XDG_DATA_HOME/typerelay/installation.json" >/dev/null
            launch managed_retired
            assert_commands
            assert_backup
            timeout 30s typerelay export upgrade-qa "$HOME/preserved.yml"
            cmp "$HOME/.qa-original-export.yml" "$HOME/preserved.yml"
            [[ $(jq -cS . "$XDG_CONFIG_HOME/typerelay/panel.json") == $(jq -cS . <<<"$legacy_settings") ]]
            stop_panel
            launch managed_retired
            assert_backup
            printf 'Managed backup, relaunch, snippets and settings verified\n'
            stop_panel
            panel=
            test_tui
            ;;
        clean)
            launch true
            assert_commands
            backups=("$HOME"/.local/bin/.typerelay-legacy-*)
            [[ ${#backups[@]} == 0 ]]
            printf 'Clean profile uses %s\n' "$version"
            ;;
        unmanaged)
            sentinel="$HOME/.local/bin/typerelay"
            printf '#!/bin/sh\nprintf "unmanaged sentinel\\n"\n' > "$sentinel"
            chmod u+x "$sentinel"
            cp "$sentinel" "$HOME/sentinel"
            mkdir -p "$XDG_DATA_HOME/typerelay"
            tar -xOzf "$fixture" .local/share/typerelay/installation.json > "$XDG_DATA_HOME/typerelay/installation.json"
            launch warning_names_path
            cmp "$HOME/sentinel" "$sentinel"
            [[ $(typerelay) == 'unmanaged sentinel' ]]
            backups=("$HOME"/.local/bin/.typerelay-legacy-*)
            [[ ${#backups[@]} == 0 ]]
            printf 'Unmanaged command with a stale receipt preserved and its exact path shown in the warning\n'
            ;;
    esac
)

for kind in managed clean unmanaged; do test_profile "$kind"; done
printf 'PASS %s %s %s\n' "$format" "$version" "$package_sha"
