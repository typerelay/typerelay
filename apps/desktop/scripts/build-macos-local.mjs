#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopVersion } from '../../../scripts/sync-desktop-version.mjs';

export class LocalMacBuild {
	static root = fileURLToPath(new URL('../../../', import.meta.url));
	static working = path.join(LocalMacBuild.root, 'apps/desktop');
	static target(architecture = process.arch) { if (architecture === 'arm64') return { triple: 'aarch64-apple-darwin', artifact: 'aarch64' }; if (architecture === 'x64') return { triple: 'x86_64-apple-darwin', artifact: 'x64' }; throw new Error('Local macOS builds require Apple Silicon or Intel'); }
	static run(command, args, cwd = LocalMacBuild.root) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, stdio: 'inherit' }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(command + ' failed with exit code ' + code))); }); }
	static output(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', data => { output += data; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(command + ' failed with exit code ' + code))); }); }
	static async signingIdentity(environment = process.env) { const output = await LocalMacBuild.output('security', ['find-identity', '-v', '-p', 'codesigning']); const identities = [...output.matchAll(/"(Developer ID Application:[^"]+)"/g)].map(match => match[1]); const requested = environment.APPLE_SIGNING_IDENTITY; if (requested && identities.includes(requested)) return requested; if (identities.length === 1) return identities[0]; throw new Error('Set APPLE_SIGNING_IDENTITY to one installed Developer ID Application identity'); }
	static async main(platform = process.platform) {
		if (platform !== 'darwin') throw new Error('Run the local macOS build on a Mac');
		await DesktopVersion.sync();
		const target = LocalMacBuild.target(); const config = await DesktopVersion.config(); const identity = await LocalMacBuild.signingIdentity();
		await LocalMacBuild.run('pnpm', ['tauri', 'build', '--target', target.triple, '--bundles', 'app', '--no-sign', '--', '--locked'], LocalMacBuild.working);
		const release = path.join(LocalMacBuild.working, 'src-tauri/target', target.triple, 'release/bundle'); const app = path.join(release, 'macos/TypeRelay.app'); const tui = path.join(app, 'Contents/MacOS/typerelay-tui');
		await LocalMacBuild.run('codesign', ['--force', '--sign', identity, '--identifier', 'com.typerelay.tui', '--options', 'runtime', '--timestamp=none', tui]);
		await LocalMacBuild.run('codesign', ['--force', '--sign', identity, '--identifier', config.identifier, '--options', 'runtime', '--timestamp=none', app]);
		await LocalMacBuild.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-local-dmg-')); const dmg = path.join(release, 'dmg', `TypeRelay_${config.version}_${target.artifact}.dmg`);
		try { await fs.mkdir(path.dirname(dmg), { recursive: true }); await LocalMacBuild.run('ditto', [app, path.join(temporary, 'TypeRelay.app')]); await fs.symlink('/Applications', path.join(temporary, 'Applications')); await LocalMacBuild.run('hdiutil', ['create', '-volname', 'TypeRelay', '-srcfolder', temporary, '-ov', '-format', 'UDZO', dmg]); }
		finally { await fs.rm(temporary, { recursive: true, force: true }); }
		console.log('Built Developer ID-signed TypeRelay app and DMG for local testing: ' + dmg);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) LocalMacBuild.main().catch(error => { console.error(error.message); process.exitCode = 1; });
