#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ANDROID_DIR="${REPO_ROOT}/apps/mobile/android"
HOST_OS="$(uname -s)"
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

if [ "${HOST_OS}" = "Darwin" ]; then
	DEFAULT_JDK_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
	DEFAULT_JDK_HOME="${DEFAULT_JDK_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
	DEFAULT_ANDROID_SDK_HOME="${HOME}/Library/Android/sdk"
else
	DEFAULT_JDK_HOME="/usr/lib/jvm/java-21-openjdk"
	DEFAULT_ANDROID_SDK_HOME="${HOME}/Android/Sdk"
fi
ANDROID_STUDIO_JDK_HOME="${ANDROID_STUDIO_JDK_HOME:-${JAVA_HOME:-${DEFAULT_JDK_HOME}}}"
ANDROID_SDK_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${DEFAULT_ANDROID_SDK_HOME}}}"
AAB_PATH="${ANDROID_DIR}/app/build/outputs/bundle/release/app-release.aab"

if [ ! -x "${ANDROID_STUDIO_JDK_HOME}/bin/javac" ] || [ ! -x "${ANDROID_STUDIO_JDK_HOME}/bin/jarsigner" ]; then
	echo "JDK not found at ${ANDROID_STUDIO_JDK_HOME}. Set JAVA_HOME or ANDROID_STUDIO_JDK_HOME to JDK 21." >&2
	exit 1
fi
JAVA_MAJOR="$("${ANDROID_STUDIO_JDK_HOME}/bin/java" -XshowSettings:properties -version 2>&1 | awk -F= '/^[[:space:]]*java\.specification\.version[[:space:]]*=/ { gsub(/[[:space:]]/, "", $2); print $2 }')"
if [[ ! "${JAVA_MAJOR}" =~ ^(21|22|23|24)$ ]]; then
	echo "Java ${JAVA_MAJOR:-unknown} cannot run this Android build. Set JAVA_HOME or ANDROID_STUDIO_JDK_HOME to JDK 21 (supported: 21-24)." >&2
	exit 1
fi
if ! release_signing_configured || [ ! -f "${TYPERELAY_ANDROID_KEYSTORE_PATH:-}" ]; then
	echo "Release signing is not configured or the keystore is missing. Set TYPERELAY_ANDROID_KEYSTORE_PATH, TYPERELAY_ANDROID_KEYSTORE_PASSWORD, TYPERELAY_ANDROID_KEY_ALIAS, and TYPERELAY_ANDROID_KEY_PASSWORD (or HELPMONKS_ANDROID_*)." >&2
	exit 1
fi
if [ ! -d "${ANDROID_SDK_HOME}/platforms" ] || [ ! -d "${ANDROID_SDK_HOME}/build-tools" ]; then
	echo "Android SDK not found at ${ANDROID_SDK_HOME}. Set ANDROID_HOME or ANDROID_SDK_ROOT to a valid SDK." >&2
	exit 1
fi

export JAVA_HOME="${ANDROID_STUDIO_JDK_HOME}"
export ANDROID_HOME="${ANDROID_SDK_HOME}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_HOME}"
export PATH="${JAVA_HOME}/bin:${PATH}"
export NODE_ENV=production
export VITE_ENABLE_LOCAL_SERVER=false

cd "${REPO_ROOT}"
pnpm --dir apps/mobile native:android
pnpm --dir apps/mobile assets
pnpm --dir apps/mobile build
pnpm --dir apps/mobile exec cap sync android

cd "${ANDROID_DIR}"
./gradlew :app:bundleRelease

VERIFY_STATUS=0
VERIFY_OUTPUT="$(LC_ALL=C jarsigner -verify "${AAB_PATH}" 2>&1)" || VERIFY_STATUS=$?
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
