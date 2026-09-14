import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeTools } from '../scripts/stage-native-tools.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Windows CLI and TUI use one native staging plan', () => {
	const native = NativeTools.plan('x86_64-pc-windows-msvc', { platform: 'win32', environment: {}, root });
	const cross = NativeTools.plan('x86_64-pc-windows-msvc', { platform: 'linux', environment: { CARGO_TARGET_DIR: '/tmp/typerelay-release' }, root });
	assert.equal(native.command, 'cargo');
	assert.equal(cross.command, 'cargo-xwin');
	assert.deepEqual(native.args.slice(-4), ['--bin', 'typerelay', '--bin', 'typerelay-tui']);
	assert.deepEqual(native.files.map(file => path.basename(file.destination)), ['typerelay-x86_64-pc-windows-msvc.exe', 'typerelay-tui-x86_64-pc-windows-msvc.exe']);
	assert.ok(cross.files.every(file => file.source.startsWith(path.resolve(root, '/tmp/typerelay-release') + path.sep)));
	assert.equal(NativeTools.environment({})[NativeTools.rustflags], '-C target-feature=+crt-static');
	assert.equal(NativeTools.environment({ [NativeTools.rustflags]: '-C opt-level=2' })[NativeTools.rustflags], '-C opt-level=2 -C target-feature=+crt-static');
	assert.throws(() => NativeTools.plan('aarch64-pc-windows-msvc'), /Unsupported/);
});

test('Windows bundle embeds both tools and owns its TUI shortcut', async () => {
	const config = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/tauri.windows.conf.json'), 'utf8'));
	const hooks = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/installer-hooks.nsh'), 'utf8');
	const windows = await fs.readFile(path.join(root, 'apps/desktop/src-tauri/src/platform_windows.rs'), 'utf8');
	assert.deepEqual(config.bundle.externalBin, ['binaries/typerelay', 'binaries/typerelay-tui']);
	assert.match(windows, /keys_down\(\)[\s\S]*0x20/);
	assert.match(hooks, /NSIS_HOOK_POSTINSTALL[\s\S]*CreateShortCut "\$SMPROGRAMS\\TypeRelay TUI\.lnk" "\$INSTDIR\\typerelay-tui\.exe"/);
	assert.match(hooks, /NSIS_HOOK_PREUNINSTALL[\s\S]*Delete "\$SMPROGRAMS\\TypeRelay TUI\.lnk"/);
});
