import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeTools } from '../scripts/stage-native-tools.mjs';
import { LocalMacBuild } from '../scripts/build-macos-local.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('macOS bundle stages the TUI for native and universal targets', async () => {
	const native = NativeTools.plan('aarch64-apple-darwin', { platform: 'darwin', environment: {}, root }); const universal = NativeTools.plans('universal-apple-darwin', { platform: 'darwin', environment: {}, root });
	assert.equal(native.command, 'cargo');
	assert.deepEqual(native.args.slice(-2), ['--bin', 'typerelay-tui']);
	assert.equal(path.basename(native.files[0].destination), 'typerelay-tui-aarch64-apple-darwin');
	assert.deepEqual(universal.map(plan => plan.args[plan.args.indexOf('--target') + 1]), ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
	const config = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/tauri.macos.conf.json'), 'utf8'));
	assert.deepEqual(config.bundle.externalBin, ['binaries/typerelay-tui']);
	assert.equal(config.build.beforeBundleCommand, 'node scripts/stage-native-tools.mjs');
	assert.equal(config.app.windows[0].windowEffects.effects[0], 'popover');
	assert.equal(config.app.windows[0].decorations, true);
	assert.equal(config.app.windows[0].titleBarStyle, 'Overlay');
});

test('macOS startup requests Accessibility and offers settings and TUI launchers', async () => {
	const main = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/main.rs'), 'utf8'); const shared = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/platform.rs'), 'utf8'); const platform = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/platform_macos.rs'), 'utf8'); const smoke = await fs.readFile(path.join(root, 'scripts/macos-typing-smoke.swift'), 'utf8'); const tray = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/tray.rs'), 'utf8');
	assert.match(main, /platform::accessibility\(true\)/);
	assert.match(main, /platform::accessibility\(false\)\{message\}else\{Runtime::ACCESSIBILITY_MESSAGE/);
	assert.match(main, /--accessibility-status/);
	assert.match(platform, /Enigo::new/);
	assert.match(platform, /Privacy_Accessibility/);
	assert.match(platform, /with_file_name\("typerelay-tui"\)/);
	assert.match(platform, /CGEvent::new_keyboard_event/);
	assert.match(platform, /KeyCode::ANSI_V/);
	assert.match(platform, /KeyCode::COMMAND,true/);
	assert.match(platform, /KeyCode::COMMAND,false/);
	assert.match(platform, /post_to_pid\(target\.pid\)/);
	assert.match(platform, /CGEventTap::with_enabled/);
	assert.match(platform, /CGEventTapOptions::Default/);
	assert.match(platform, /CallbackResult::Drop/);
	assert.match(main, /deferred\.finish\(&target\)/);
	assert.match(platform, /CGEventTapLocation::HID/);
	assert.match(platform, /CGEventType::KeyDown/);
	assert.match(platform, /event\.location\(\)\.x\+27469/);
	assert.match(platform, /expansion\.erase\+=1/);
	assert.match(platform, /release_modifiers/);
	assert.match(main, /--repair-input/);
	assert.doesNotMatch(shared, /enigo\.key/);
	assert.match(main, /TypeRelay insertion failed/);
	assert.match(smoke, /immediateFollow/);
	assert.match(smoke, /releaseTimeout/);
	assert.match(smoke, /Be right back\.x/);
	assert.match(tray, /Open TypeRelay TUI/);
});

test('local macOS build uses the configured Developer ID identity', async () => {
	assert.deepEqual(LocalMacBuild.target('arm64'), { triple: 'aarch64-apple-darwin', artifact: 'aarch64' });
	assert.deepEqual(LocalMacBuild.target('x64'), { triple: 'x86_64-apple-darwin', artifact: 'x64' });
	assert.throws(() => LocalMacBuild.target('unsupported'), /Apple Silicon or Intel/);
	const source = await fs.readFile(path.join(root, 'apps/desktop/scripts/build-macos-local.mjs'), 'utf8');
	assert.match(source, /Developer ID Application/);
	assert.match(source, /APPLE_SIGNING_IDENTITY/);
	assert.match(source, /'--options', 'runtime'/);
});
