#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeTools } from './stage-native-tools.mjs';
import { PanelRelease } from '../../../scripts/release-panel.mjs';
import { DesktopVersion } from '../../../scripts/desktop-version.mjs';

export class WindowsTestBuild {
	static async main() {
		if (process.platform !== 'linux') throw new Error('Run this Windows test build on Linux with cargo-xwin and NSIS installed');
		const target = 'x86_64-pc-windows-msvc'; const working = path.join(NativeTools.root, 'apps/desktop'); const directory = path.join(NativeTools.root, 'target/windows-test');
		const baseEnvironment = { ...PanelRelease.buildEnvironment(process.env), CARGO_TARGET_DIR: directory };
		for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'WINDOWS_SIGNING_PIN']) delete baseEnvironment[key];
		const environment = NativeTools.environment(baseEnvironment);
		await PanelRelease.requireCommands(['cargo-xwin', 'clang', 'cmake', 'ninja', 'llvm-rc', 'makensis', 'wine']);
		const config = await DesktopVersion.config();
		await PanelRelease.run('pnpm', ['build'], { cwd: working, environment });
		await NativeTools.stage(target, { environment: baseEnvironment });
		await PanelRelease.run('cargo', ['xwin', 'build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--target', target, '--locked'], { cwd: working, environment });
		await PanelRelease.run('pnpm', ['tauri', 'bundle', '--target', target, '--bundles', 'nsis', '--config', 'src-tauri/tauri.windows.conf.json', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), '--no-sign'], { cwd: working, environment });
		const installer = path.join(directory, target, 'release/bundle/nsis', `TypeRelay_${config.version}_x64-setup.exe`);
		await fs.access(installer);
		console.log('Unsigned Windows test installer: ' + installer);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) WindowsTestBuild.main().catch(error => { console.error(error.message); process.exitCode = 1; });
