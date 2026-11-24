#!/usr/bin/env bash
set -euo pipefail

repo=$1
commit=$2
report_dir=$3
shift 3

for tool in bwrap bsdtar curl flock jq sha256sum; do
    command -v "$tool" >/dev/null || { printf 'TypeRelay Linux release requires %s on Omarchy.\n' "$tool" >&2; exit 1; }
done
bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / -- /usr/bin/true || {
    printf 'TypeRelay Linux release requires working unprivileged user namespaces.\n' >&2
    exit 1
}

# Cache the pinned toolchain independently of the working checkout and its artifacts.
umask 077
cache=${XDG_CACHE_HOME:-$HOME/.cache}/typerelay/linux-release
recipe=$(sha256sum "$0")
root=$cache/${recipe%% *}
mkdir -p "$cache/home"
exec 9>"$cache/build.lock"
flock 9

sandbox=(bwrap --unshare-user --uid 0 --gid 0 --unshare-pid --unshare-ipc --die-with-parent)
system_mounts=(--dev /dev --proc /proc --ro-bind /etc/resolv.conf /etc/resolv.conf)
if [[ ! -d $root ]]; then
    stage=$(mktemp -d "$cache/bootstrap.XXXXXXXX")
    trap 'rm -rf -- "$stage"' EXIT
    mkdir "$stage/root"
    layer=b1dd3d113aab1041fd80cc61d9db7ffbc058f756bf46fc149a0d9aa8b85935f4 # Debian 12 amd64 slim rootfs
    token=$(curl -fsSL --retry 2 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull' | jq -er .token)
    curl -fsSL --retry 2 -H "Authorization: Bearer $token" "https://registry-1.docker.io/v2/library/debian/blobs/sha256:$layer" -o "$stage/rootfs.tar.gz"
    printf '%s  %s\n' "$layer" "$stage/rootfs.tar.gz" | sha256sum --check
    bsdtar --no-same-owner -xzf "$stage/rootfs.tar.gz" -C "$stage/root"
    "${sandbox[@]}" --bind "$stage/root" / "${system_mounts[@]}" --clearenv --setenv PATH /usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin \
        --setenv HOME /root --setenv DEBIAN_FRONTEND noninteractive -- /bin/bash -euo pipefail -c '
        apt-get -o APT::Sandbox::User=root update -qq
        apt-get -o APT::Sandbox::User=root install -y -qq --download-only --no-install-recommends \
            build-essential ca-certificates clang cmake curl file git libasound2-dev libayatana-appindicator3-dev \
            libclang-dev libdbus-1-dev librsvg2-dev libssl-dev libudev-dev libwebkit2gtk-4.1-dev \
            libxkbcommon-dev patchelf pkg-config rpm xz-utils
        # A build needs the files only. Package post-install scripts expect system users and services.
        for package in /var/cache/apt/archives/*.deb; do
            dpkg-deb --fsys-tarfile "$package" | tar --no-same-owner --keep-directory-symlink -xf - -C /
        done
        ln -sf gcc /usr/bin/cc
        ln -sf g++ /usr/bin/c++
        ldconfig
        find /usr/share/ca-certificates -name "*.crt" -printf "%P\n" | sort > /etc/ca-certificates.conf
        update-ca-certificates
        node=node-v26.13.1-linux-x64.tar.xz
        curl -fsSL --retry 2 "https://nodejs.org/dist/v26.13.1/$node" -o "/tmp/$node"
        printf "%s  %s\n" 5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864 "/tmp/$node" | sha256sum --check
        tar --no-same-owner -xJf "/tmp/$node" --strip-components=1 -C /usr/local
        rm "/tmp/$node"
        npm install --global --ignore-scripts pnpm@12.18.0
        curl -fsSL --retry 2 https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init
        printf "%s  %s\n" 20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c /tmp/rustup-init | sha256sum --check
        chmod +x /tmp/rustup-init
        CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.1
        rm /tmp/rustup-init
        apt-get clean
    '
    mv -- "$stage/root" "$root"
    rm -rf -- "$stage"
    trap - EXIT
fi

git_dir=$(git -C "$repo" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
mkdir -p "$report_dir"
mounts=(--bind "$repo" "$repo" --ro-bind "$git_common" "$git_common" --bind "$report_dir" "$report_dir")
[[ $git_dir == "$git_common" ]] || mounts+=(--ro-bind "$git_dir" "$git_dir")

umask 022
exec "${sandbox[@]}" --overlay-src "$root" --tmp-overlay / "${system_mounts[@]}" --tmpfs /tmp --bind "$cache/home" /build-home \
    "${mounts[@]}" --setenv HOME /build-home --setenv XDG_CACHE_HOME /build-home/.cache --setenv PATH /opt/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    --setenv CARGO_HOME /build-home/.cargo --setenv RUSTUP_HOME /opt/rustup --setenv APPIMAGE_EXTRACT_AND_RUN 1 \
    --setenv TYPERELAY_BOOKWORM_COMMIT "$commit" --chdir "$repo" -- node scripts/release-panel.mjs "$@"
