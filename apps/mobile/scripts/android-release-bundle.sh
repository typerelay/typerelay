#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ANDROID_DIR="${REPO_ROOT}/apps/mobile/android"
HOST_OS="$(uname -s)"
NDK_VERSION="28.2.13676358"
LOCAL_ANDROID_CONFIG_PATH="${TYPERELAY_ANDROID_CONFIG_PATH:-}"
if [ -z "${LOCAL_ANDROID_CONFIG_PATH}" ] && [ "${HOST_OS}" = "Darwin" ]; then
	LOCAL_ANDROID_CONFIG_PATH="${REPO_ROOT}/../helpmonks-install-script/macos_config.fish"
fi

LOCAL_SHARED_KEYSTORE="${REPO_ROOT}/../helpmonks-install-script/android/helpmonks-upload-key.jks"
for suffix in KEYSTORE_PATH KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD; do
	app_variable="TYPERELAY_ANDROID_${suffix}"
	shared_variable="HELPMONKS_ANDROID_${suffix}"
	if [ -z "${!app_variable:-}" ]; then
		value="${!shared_variable:-}"
		if [ "${suffix}" = "KEYSTORE_PATH" ] && [ ! -f "${value}" ] && [ "${value##*/}" = "helpmonks-upload-key.jks" ] && [ -f "${LOCAL_SHARED_KEYSTORE}" ]; then
			value="${LOCAL_SHARED_KEYSTORE}"
		fi
		export "${app_variable}=${value}"
	fi
done

release_signing_configured() {
	[ -n "${TYPERELAY_ANDROID_KEYSTORE_PATH:-}" ] && [ -n "${TYPERELAY_ANDROID_KEYSTORE_PASSWORD:-}" ] && [ -n "${TYPERELAY_ANDROID_KEY_ALIAS:-}" ] && [ -n "${TYPERELAY_ANDROID_KEY_PASSWORD:-}" ]
}

if ! release_signing_configured && [ "${TYPERELAY_ANDROID_CONFIG_LOADED:-false}" != "true" ] && [ -f "${LOCAL_ANDROID_CONFIG_PATH}" ]; then
	if ! command -v fish >/dev/null 2>&1; then
		echo "fish is required to load Android signing config from ${LOCAL_ANDROID_CONFIG_PATH}" >&2
		exit 1
	fi
	exec fish --no-config -c '
		source "$argv[1]"
		set -gx TYPERELAY_ANDROID_CONFIG_LOADED true
		exec bash "$argv[2]"
	' "${LOCAL_ANDROID_CONFIG_PATH}" "${BASH_SOURCE[0]}"
fi

java_major() {
	"$1/bin/java" -XshowSettings:properties -version 2>&1 | awk -F= '/^[[:space:]]*java\.specification\.version[[:space:]]*=/ { value = $2; gsub(/[[:space:]]/, "", value); sub(/^1\./, "", value); print value; exit }'
}

compatible_android_jdk() {
	if [[ ! -x "$1/bin/java" || ! -x "$1/bin/javac" || ! -x "$1/bin/jarsigner" ]]; then return 1; fi
	local major
	major="$(java_major "$1")"
	[[ "${major}" =~ ^[0-9]+$ && "${major}" -ge 21 && "${major}" -le 24 ]]
}

REQUESTED_ANDROID_JDK_HOME="${ANDROID_STUDIO_JDK_HOME:-${JAVA_HOME:-}}"
ANDROID_JDK_HOME=""
if [[ -n "${REQUESTED_ANDROID_JDK_HOME}" ]]; then
	if ! compatible_android_jdk "${REQUESTED_ANDROID_JDK_HOME}"; then
		echo "Configured Android JDK is incompatible: ${REQUESTED_ANDROID_JDK_HOME} (Java $(java_major "${REQUESTED_ANDROID_JDK_HOME}" 2>/dev/null || echo unknown)). Set JAVA_HOME or ANDROID_STUDIO_JDK_HOME to Java 21-24." >&2
		exit 1
	fi
	ANDROID_JDK_HOME="${REQUESTED_ANDROID_JDK_HOME}"
fi
if [[ -z "${ANDROID_JDK_HOME}" ]]; then
	for candidate in "/usr/lib/jvm/java-21-openjdk" "/usr/lib/jvm/java-22-openjdk" "/usr/lib/jvm/java-23-openjdk" "/usr/lib/jvm/java-24-openjdk" "/usr/lib/jvm/default" "/usr/lib/jvm/default-runtime" "/opt/android-studio/jbr" "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
		if compatible_android_jdk "${candidate}"; then ANDROID_JDK_HOME="${candidate}"; break; fi
	done
fi
if [[ -z "${ANDROID_JDK_HOME}" && "${HOST_OS}" = "Darwin" && -x "/usr/libexec/java_home" ]]; then
	MACOS_JDK_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
	if compatible_android_jdk "${MACOS_JDK_HOME}"; then ANDROID_JDK_HOME="${MACOS_JDK_HOME}"; fi
fi
if [[ -z "${ANDROID_JDK_HOME}" ]] && command -v java >/dev/null 2>&1 && command -v readlink >/dev/null 2>&1; then
	JAVA_BINARY="$(readlink -f "$(command -v java)" 2>/dev/null || true)"
	if [[ -n "${JAVA_BINARY}" ]]; then
		PATH_JDK_HOME="$(cd "$(dirname "${JAVA_BINARY}")/.." && pwd -P)"
		if compatible_android_jdk "${PATH_JDK_HOME}"; then ANDROID_JDK_HOME="${PATH_JDK_HOME}"; fi
	fi
fi
if [[ -z "${ANDROID_JDK_HOME}" ]]; then
	echo "Compatible Android JDK not found. Install JDK 21 or set JAVA_HOME/ANDROID_STUDIO_JDK_HOME to Java 21-24." >&2
	exit 1
fi

ANDROID_SDK_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "${ANDROID_SDK_HOME}" ]]; then
	for candidate in "${HOME}/Android/Sdk" "${HOME}/Library/Android/sdk"; do
		if [[ -d "${candidate}/platforms" && -d "${candidate}/build-tools" ]]; then ANDROID_SDK_HOME="${candidate}"; break; fi
	done
fi
if [[ -z "${ANDROID_SDK_HOME}" || ! -d "${ANDROID_SDK_HOME}/platforms" || ! -d "${ANDROID_SDK_HOME}/build-tools" ]]; then
	echo "Android SDK not found. Install it with Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT." >&2
	exit 1
fi
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_SDK_HOME}/ndk/${NDK_VERSION}}}"
NDK_HOST="linux-x86_64"
if [[ "${HOST_OS}" = "Darwin" ]]; then NDK_HOST="darwin-x86_64"; fi
NDK_BIN="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/${NDK_HOST}/bin"
if [[ ! -x "${NDK_BIN}/aarch64-linux-android24-clang" || ! -x "${NDK_BIN}/x86_64-linux-android24-clang" || ! -x "${NDK_BIN}/llvm-ar" ]]; then
	echo "Android NDK ${NDK_VERSION} not found at ${ANDROID_NDK_HOME}. Install NDK (Side by side) ${NDK_VERSION} with Android Studio's SDK Manager or set ANDROID_NDK_HOME/ANDROID_NDK_ROOT." >&2
	exit 1
fi
AAB_PATH="${ANDROID_DIR}/app/build/outputs/bundle/release/app-release.aab"

if ! release_signing_configured || [ ! -f "${TYPERELAY_ANDROID_KEYSTORE_PATH:-}" ]; then
	echo "Release signing is not configured or the keystore is missing. Set TYPERELAY_ANDROID_KEYSTORE_PATH, TYPERELAY_ANDROID_KEYSTORE_PASSWORD, TYPERELAY_ANDROID_KEY_ALIAS, and TYPERELAY_ANDROID_KEY_PASSWORD (or HELPMONKS_ANDROID_*)." >&2
	exit 1
fi
export JAVA_HOME="${ANDROID_JDK_HOME}"
export ANDROID_HOME="${ANDROID_SDK_HOME}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_HOME}"
export ANDROID_NDK_HOME
export ANDROID_NDK_ROOT="${ANDROID_NDK_HOME}"
export PATH="${JAVA_HOME}/bin:${PATH}"
export NODE_ENV=production
export VITE_ENABLE_LOCAL_SERVER=false

cd "${REPO_ROOT}"
pnpm --filter @typerelay/mobile native:android
pnpm --filter @typerelay/mobile assets
pnpm --filter @typerelay/mobile build
pnpm --filter @typerelay/mobile exec cap sync android

cd "${ANDROID_DIR}"
./gradlew :app:bundleRelease

VERIFY_STATUS=0
VERIFY_OUTPUT="$(LC_ALL=C "${JAVA_HOME}/bin/jarsigner" -verify "${AAB_PATH}" 2>&1)" || VERIFY_STATUS=$?
if [[ "${VERIFY_OUTPUT}" == *"jar is unsigned"* ]]; then
	echo "${VERIFY_OUTPUT}" >&2
	echo "Release bundle is unsigned: ${AAB_PATH}" >&2
	exit 1
fi
if [ "${VERIFY_STATUS}" -ne 0 ] || [[ "${VERIFY_OUTPUT}" != *"jar verified."* ]]; then
	echo "${VERIFY_OUTPUT}" >&2
	echo "Could not verify release bundle signature: ${AAB_PATH}" >&2
	exit 1
fi

echo "Signed Android App Bundle: ${AAB_PATH}"
