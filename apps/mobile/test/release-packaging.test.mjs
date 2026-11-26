import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = relativePath => readFileSync(`${root}/${relativePath}`, 'utf8');

describe('mobile release packaging', () => {
	it('uses one root pnpm workspace and exposes Android release there', () => {
		const packageJson = JSON.parse(source('package.json'));
		const workspace = source('pnpm-workspace.yaml');
		assert.equal(packageJson.private, true);
		assert.equal(packageJson.packageManager, 'pnpm@12.18.0');
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

	it('prunes once after signing and protects every Android release Cargo profile', { skip: process.platform === 'win32' }, t => {
		const fixture = mkdtempSync(join(tmpdir(), 'typerelay-android-release-'));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		const write = (relative, content, mode = 0o644) => {
			const path = join(fixture, relative);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content, { mode });
		};
		const tool = (relative, script) => write(relative, '#!/usr/bin/env bash\nset -eu\n' + script, 0o755);
		write('package.json', source('package.json'));
		write('apps/mobile/ios/App/App.xcodeproj/project.pbxproj', source('apps/mobile/ios/App/App.xcodeproj/project.pbxproj'));
		for (const name of ['android-release-bundle.sh', 'build-native.mjs', 'build-renderer.mjs', 'build-targets.mjs', 'prune-android-release-cache.mjs', 'version.mjs']) {
			const path = `apps/mobile/scripts/${name}`;
			write(path, source(path));
		}
		write('scripts/build-cache.mjs', source('scripts/build-cache.mjs'));
		write('release.jks', '');
		tool('jdk/bin/java', 'echo "java.specification.version = 21"');
		tool('jdk/bin/javac', ':');
		tool('jdk/bin/jarsigner', 'echo verify >> "$RELEASE_LOG"\necho "$SIGNATURE_RESULT"');
		mkdirSync(join(fixture, 'sdk/platforms'), { recursive: true });
		mkdirSync(join(fixture, 'sdk/build-tools'), { recursive: true });
		const ndkHost = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
		for (const name of ['aarch64-linux-android24-clang', 'x86_64-linux-android24-clang', 'llvm-ar']) tool(`ndk/toolchains/llvm/prebuilt/${ndkHost}/bin/${name}`, ':');
		tool('bin/pnpm', 'case "$3" in\n native:android) node apps/mobile/scripts/build-native.mjs android ;;\n build) node apps/mobile/scripts/build-renderer.mjs ;;\n esac');
		tool('bin/rustup', ':');
		tool('bin/cargo', `
if [[ "$1" = metadata ]]; then
	node -p "JSON.stringify({ target_directory: process.env.CARGO_TARGET_DIR })"
	exit
fi
while [[ "$1" != --target ]]; do shift; done
target="$2"
artifact=libtyperelay_mobile.so
if [[ "$target" = wasm32-unknown-unknown ]]; then artifact=typerelay_template_wasm.wasm; fi
mkdir -p "$CARGO_TARGET_DIR/$target/release"
touch "$CARGO_TARGET_DIR/$target/release/$artifact"
echo "$target" >> "$RELEASE_LOG"`);
		tool('bin/python3', 'shift\nprintf "%s\\n" prune "$@" >> "$RELEASE_LOG"');
		tool('apps/mobile/android/gradlew', 'echo bundle >> "$RELEASE_LOG"');
		const targets = ['aarch64-linux-android', 'x86_64-linux-android', 'wasm32-unknown-unknown'];
		const targetDirectory = join(fixture, 'custom-target');
		const log = join(fixture, 'release.log');
		const release = signature => {
			writeFileSync(log, '');
			return spawnSync('bash', [join(fixture, 'apps/mobile/scripts/android-release-bundle.sh')], {
				cwd: fixture,
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: [join(fixture, 'bin'), dirname(process.execPath), process.env.PATH].join(':'),
					ANDROID_STUDIO_JDK_HOME: join(fixture, 'jdk'),
					ANDROID_HOME: join(fixture, 'sdk'),
					ANDROID_NDK_HOME: join(fixture, 'ndk'),
					CARGO_TARGET_DIR: targetDirectory,
					RELEASE_LOG: log,
					SIGNATURE_RESULT: signature,
					TYPERELAY_ANDROID_KEYSTORE_PATH: join(fixture, 'release.jks'),
					TYPERELAY_ANDROID_KEYSTORE_PASSWORD: 'test',
					TYPERELAY_ANDROID_KEY_ALIAS: 'test',
					TYPERELAY_ANDROID_KEY_PASSWORD: 'test'
				}
			});
		};
		const success = release('jar verified.');
		assert.equal(success.status, 0, success.stderr);
		const events = [...targets, 'bundle', 'verify'];
		assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [...events, 'prune', join(targetDirectory, 'release'), ...targets.map(target => join(targetDirectory, target, 'release'))]);
		const unsigned = release('jar is unsigned');
		assert.equal(unsigned.status, 1, unsigned.stderr);
		assert.match(unsigned.stderr, /Release bundle is unsigned/);
		assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), events);
	});

	it('keeps Android and iOS release versions aligned', () => {
		const mobile = JSON.parse(source('package.json'));
		const gradle = source('apps/mobile/android/app/build.gradle');
		const xcode = source('apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
		const iosVersions = [...xcode.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
		const iosBuilds = [...xcode.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
		assert.match(gradle, /versionName releaseVersion\.version_mobile/);
		assert.match(gradle, /versionCode releaseVersion\.build_mobile/);
		assert.match(gradle, /JsonSlurper.*package\.json/);
		assert.ok(Number.isInteger(mobile.build_mobile) && mobile.build_mobile > 1);
		assert.deepEqual([...new Set(iosVersions)], [mobile.version_mobile]);
		assert.deepEqual([...new Set(iosBuilds)], [String(mobile.build_mobile)]);
	});

	it('keeps both native keyboards aligned to platform-sized keycaps', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		const ios = source('apps/mobile/ios/App/Keyboard/KeyboardViewController.swift');
		assert.match(android, /setBackgroundColor\(palette\.surface\)/);
		assert.match(android, /LinearLayout\.LayoutParams\(0, dp\(52\), weight\)/);
		assert.match(android, /key\("⌫", true\)/);
		assert.match(android, /special && label != "Space"/);
		assert.match(ios, /row\.heightAnchor\.constraint\(equalToConstant: 44\)/);
		assert.match(ios, /systemFont\(ofSize: special \? 16 : 22/);
		assert.match(ios, /key\("⌫", special: true\)/);
		assert.match(ios, /view\.backgroundColor = color/);
	});

	it('keeps the Android suggestion strip and system palette visually aligned', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		assert.match(android, /LinearLayout\.LayoutParams\(0, dp\(48\), 1f\)/);
		assert.match(android, /LinearLayout\.LayoutParams\(dp\(64\), dp\(44\)\)/);
		assert.match(android, /allDivider = View\(this\)/);
		assert.match(android, /allButton\.text = "All"/);
		assert.doesNotMatch(android, /Showing 60 of|\$matchCount matches/);
		assert.match(android, /allButton\.background = rounded\(palette\.surface\)/);
		assert.match(android, /allButton\.elevation = 0f/);
		assert.match(android, /allButton\.setTextColor\(palette\.muted\)/);
		assert.match(android, /bars\.bottom \+ dp\(22\)/);
		assert.match(android, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S/);
		for (const color of ['system_neutral1_900', 'system_neutral1_50', 'system_accent2_700', 'system_accent2_100']) assert.match(android, new RegExp(`android\\.R\\.color\\.${color}`));
		assert.match(android, /isAppearanceLightNavigationBars/);
		assert.match(android, /Color\.rgb\(40, 42, 46\)/);
		assert.match(android, /onConfigurationChanged\(newConfig: Configuration\).*palette = keyboardPalette\(\)/);
		assert.match(android, /KeyboardMode\.FIELD_EDITING -> editingField\?\.let \{ showFieldEditing/);
		assert.match(android, /setTextColor\(palette\.muted\)/);
		assert.match(android, /overlayLayer = column\(\).*visibility = View\.GONE/);
	});

	it('types into host fields and keeps searchable results beside the keys', () => {
		const android = source('apps/mobile/android/app/src/main/java/com/typerelay/mobile/SnippetKeyboard.kt');
		const ios = source('apps/mobile/ios/App/Keyboard/KeyboardViewController.swift');
		const searchIcon = source('apps/mobile/android/app/src/main/res/drawable/ic_keyboard_search.xml');
		for (const nativeKeyboard of [android, ios]) assert.match(nativeKeyboard, /keyboard_matches/);
		assert.match(searchIcon, /<vector/);
		assert.match(searchIcon, /strokeWidth="2\.3"/);
		assert.match(android, /contentDescription = "Search snippets"/);
		assert.match(android, /setColor\(palette\.special\)/);
		assert.match(android, /showSearch\(false\)/);
		assert.match(android, /showSearch\(true\)/);
		assert.match(android, /query\.isEmpty\(\) && !browseAll/);
		assert.match(android, /stripRow\.visibility = View\.GONE; searchPanel\.visibility = View\.VISIBLE/);
		assert.match(android, /if \(blocked\).*stripRow\.visibility = View\.GONE/);
		assert.match(android, /searchBackButton = button\("Back"\)/);
		assert.doesNotMatch(android, /searchTitle/);
		assert.match(android, /text = "—"/);
		assert.match(android, /text = match\.preview/);
		assert.match(android, /maxLines = 1; ellipsize = TextUtils\.TruncateAt\.END/);
		assert.match(ios, /UIImage\(systemName: "magnifyingglass"\)/);
		assert.match(ios, /showSearch\(browse: false\)/);
		assert.match(ios, /showSearch\(browse: true\)/);
		assert.match(ios, /!query\.isEmpty \|\| browseAll/);
		assert.match(ios, /searchPanel\.isHidden = false; strip\.isHidden = true/);
		assert.match(ios, /if textDocumentProxy\.isSecureTextEntry.*strip\.isHidden = true/);
		assert.match(ios, /searchHeader\.addArrangedSubview\(searchBack\)/);
		assert.match(ios, /searchBack = button\("Back"\)/);
		assert.doesNotMatch(ios, /searchTitle/);
		assert.match(ios, /dash\.text = "—"/);
		assert.match(ios, /preview\.numberOfLines = 1/);
		assert.match(android, /connection\.commitText\(text, 1\)/);
		assert.match(android, /connection\.deleteSurroundingText\(anchorFragment\.length, 0\)/);
		assert.match(android, /WindowInsetsCompat\.Type\.navigationBars\(\) or WindowInsetsCompat\.Type\.mandatorySystemGestures\(\)/);
		assert.match(android, /enum class KeyboardMode \{ TYPING, SEARCH, PREVIEW, FIELD_EDITING \}/);
		assert.match(android, /searchPanel\.visibility = View\.VISIBLE/);
		assert.match(android, /resultListScroll = ScrollView/);
		assert.match(android, /previewScroll = ScrollView/);
		assert.match(ios, /textDocumentProxy\.insertText\(text\)/);
		assert.match(ios, /textDocumentProxy\.deleteBackward\(\)/);
		assert.match(ios, /enum KeyboardMode \{ case typing, search, preview, fieldEditing \}/);
		assert.match(ios, /searchPanel\.isHidden = false/);
		assert.match(ios, /resultListScroll = UIScrollView\(\)/);
		assert.match(ios, /previewScroll = UIScrollView\(\)/);
		for (const nativeKeyboard of [android, ios]) assert.match(nativeKeyboard, /overlayFooter/);
	});
});
