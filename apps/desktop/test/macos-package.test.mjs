import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeTools } from '../scripts/stage-native-tools.mjs';

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
});

test('macOS startup requests Accessibility and offers settings and TUI launchers', async () => {
	const main = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/main.rs'), 'utf8'); const platform = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/platform_macos.rs'), 'utf8'); const tray = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/tray.rs'), 'utf8');
	assert.match(main, /platform::accessibility\(true\)/);
	assert.match(platform, /Enigo::new/);
	assert.match(platform, /Privacy_Accessibility/);
	assert.match(platform, /with_file_name\("typerelay-tui"\)/);
	assert.match(tray, /Open TypeRelay TUI/);
});
