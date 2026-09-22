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

	it('keeps Android and iOS release versions aligned', () => {
		const mobile = JSON.parse(source('apps/mobile/package.json'));
		const gradle = source('apps/mobile/android/app/build.gradle');
		const xcode = source('apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
		const androidVersion = gradle.match(/versionName "([^"]+)"/)?.[1];
		const androidBuild = gradle.match(/versionCode (\d+)/)?.[1];
		const iosVersions = [...xcode.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
		const iosBuilds = [...xcode.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
		assert.equal(androidVersion, mobile.version);
		assert.ok(Number(androidBuild) > 1);
		assert.deepEqual([...new Set(iosVersions)], [mobile.version]);
		assert.deepEqual([...new Set(iosBuilds)], [androidBuild]);
	});

	it('keeps both native keyboards aligned to platform-sized keycaps', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		const ios = source('apps/mobile/ios/App/Keyboard/KeyboardViewController.swift');
		assert.match(android, /setBackgroundColor\(palette\.surface\)/);
		assert.match(android, /if \(label == "⇧"\) 26f else if \(special\) 17f else 24f/);
		assert.match(android, /LinearLayout\.LayoutParams\(0, dp\(52\), weight\)/);
		assert.match(android, /key\("⌫", true\)/);
		assert.match(ios, /row\.heightAnchor\.constraint\(equalToConstant: 44\)/);
		assert.match(ios, /systemFont\(ofSize: special \? 16 : 22/);
		assert.match(ios, /key\("⌫", special: true\)/);
		assert.match(ios, /view\.backgroundColor = color/);
	});

	it('keeps the Android suggestion strip and system palette visually aligned', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		assert.match(android, /LinearLayout\.LayoutParams\(0, dp\(48\), 1f\)/);
		assert.match(android, /LinearLayout\.LayoutParams\(dp\(82\), dp\(44\)\)/);
		assert.match(android, /allButton\.text = "All"/);
		assert.doesNotMatch(android, /All \(\$matchCount\)/);
		assert.match(android, /"\$matchCount matches\. Tap to preview or browse All\."/);
		assert.match(android, /allButton\.background = rounded\(palette\.surface\)/);
		assert.match(android, /allButton\.elevation = 0f/);
		assert.match(android, /allButton\.setTextColor\(palette\.muted\)/);
		assert.match(android, /bars\.bottom \+ dp\(22\)/);
		assert.match(android, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S/);
		for (const color of ['system_neutral1_900', 'system_neutral1_100', 'system_accent2_700', 'system_accent2_100']) assert.match(android, new RegExp(`android\\.R\\.color\\.${color}`));
		assert.match(android, /Color\.rgb\(232, 234, 238\)/);
		assert.match(android, /Color\.rgb\(40, 42, 46\)/);
		assert.match(android, /onConfigurationChanged\(newConfig: Configuration\).*palette = keyboardPalette\(\)/);
		assert.match(android, /KeyboardMode\.FIELD_EDITING -> editingField\?\.let \{ showFieldEditing/);
		assert.match(android, /setTextColor\(palette\.muted\)/);
		assert.match(android, /overlayLayer = column\(\).*visibility = View\.GONE/);
	});

	it('keeps keyboard search contextual with inset-safe layered results', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		const ios = source('apps/mobile/ios/App/Keyboard/KeyboardViewController.swift');
		for (const nativeKeyboard of [android, ios]) {
			assert.doesNotMatch(nativeKeyboard, /button\("Libraries"\)/);
			assert.doesNotMatch(nativeKeyboard, /button\("Back"\)/);
		}
		assert.match(android, /input\("Snippet search"\)\.apply \{ visibility = View\.GONE \}/);
		assert.match(android, /WindowInsetsCompat\.Type\.navigationBars\(\) or WindowInsetsCompat\.Type\.mandatorySystemGestures\(\)/);
		assert.match(android, /enum class KeyboardMode \{ TYPING, RESULTS, PREVIEW, FIELD_EDITING \}/);
		assert.match(android, /resultListScroll = ScrollView/);
		assert.match(android, /previewScroll = ScrollView/);
		assert.doesNotMatch(android, /dp\(92\)/);
		assert.match(ios, /queryButton = button\(""\)/);
		assert.match(ios, /enum KeyboardMode \{ case typing, results, preview, fieldEditing \}/);
		assert.match(ios, /resultListScroll = UIScrollView\(\)/);
		assert.match(ios, /previewScroll = UIScrollView\(\)/);
		assert.match(ios, /case \.results, \.preview: target = 360/);
		assert.doesNotMatch(ios, /resultHeight: CGFloat|resultHeight =|\? 0 : 80/);
		for (const nativeKeyboard of [android, ios]) assert.match(nativeKeyboard, /overlayFooter/);
	});
});
