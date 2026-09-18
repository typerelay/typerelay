import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = relativePath => readFileSync(`${root}/${relativePath}`, 'utf8');

describe('mobile release packaging', () => {
	it('uses one root pnpm workspace and exposes Android release there', () => {
		const packageJson = JSON.parse(source('package.json'));
		const workspace = source('pnpm-workspace.yaml');
		assert.equal(packageJson.private, true);
		assert.equal(packageJson.packageManager, 'pnpm@12.0.0');
		assert.equal(packageJson.scripts['android:release'], 'pnpm --filter @typerelay/mobile android:release');
		assert.match(workspace, /- "apps\/\*"/);
		assert.match(workspace, /- "docs"/);
		for (const path of ['apps/server/pnpm-lock.yaml', 'apps/mcp/pnpm-lock.yaml', 'apps/mobile/pnpm-lock.yaml', 'apps/desktop/pnpm-lock.yaml', 'docs/pnpm-lock.yaml', 'apps/server/pnpm-workspace.yaml', 'apps/mcp/pnpm-workspace.yaml', 'apps/mobile/pnpm-workspace.yaml', 'docs/pnpm-workspace.yaml']) assert.equal(existsSync(`${root}/${path}`), false, `${path} must be owned by the root workspace`);
	});

	it('discovers and exports the exact Android NDK required by Gradle', () => {
		const releaseScript = source('apps/mobile/scripts/android-release-bundle.sh');
		const nativeScript = source('apps/mobile/scripts/build-native.mjs');
		assert.match(releaseScript, /NDK_VERSION="28\.2\.13676358"/);
		assert.match(releaseScript, /ANDROID_NDK_HOME="\$\{ANDROID_NDK_HOME:-\$\{ANDROID_NDK_ROOT:-\$\{ANDROID_SDK_HOME\}\/ndk\/\$\{NDK_VERSION\}\}\}"/);
		assert.match(releaseScript, /export ANDROID_NDK_HOME/);
		assert.match(releaseScript, /export ANDROID_NDK_ROOT="\$\{ANDROID_NDK_HOME\}"/);
		assert.match(nativeScript, /process\.env\.ANDROID_NDK_HOME \|\| process\.env\.ANDROID_NDK_ROOT/);
	});

	it('requires signing, verifies signatures with the selected JDK, and rejects stale assets', () => {
		const releaseScript = source('apps/mobile/scripts/android-release-bundle.sh');
		const gradle = source('apps/mobile/android/app/build.gradle');
		assert.match(releaseScript, /if ! release_signing_configured/);
		assert.match(releaseScript, /"\$\{JAVA_HOME\}\/bin\/jarsigner" -verify/);
		assert.match(releaseScript, /"jar is unsigned"/);
		assert.match(gradle, /tasks\.register\('verifyFreshWebAssets'\)/);
		assert.match(gradle, /packagedWebIndex\.lastModified\(\) < latestSource\.lastModified\(\)/);
		assert.match(gradle, /preReleaseBuild.*dependsOn\('verifyFreshWebAssets'\)/);
		assert.match(gradle, /src\/main\/jniLibs\/\$\{abi\}\/libtyperelay_mobile\.so/);
	});
});
