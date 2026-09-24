#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class DesktopVersion {
	static root = fileURLToPath(new URL('../', import.meta.url));
	static async version() {
		const desktop = JSON.parse(await fs.readFile(path.join(DesktopVersion.root, 'apps/desktop/package.json'), 'utf8'));
		if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(desktop.version)) throw new Error('Desktop package.json must contain a SemVer version');
		return desktop.version;
	}
	static async config() {
		const config = JSON.parse(await fs.readFile(path.join(DesktopVersion.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
		if (config.version !== '../package.json') throw new Error('Tauri version must reference ../package.json');
		return { ...config, version: await DesktopVersion.version() };
	}
	static async sync(check = false) {
		const version = await DesktopVersion.version();
		const files = [
			['package.json', /("version": ")[^"]+(")/, 1],
			['Cargo.toml', /(\[workspace\.package\]\s*version = ")[^"]+(")/, 1],
			['apps/desktop/src-tauri/Cargo.toml', /(\[package\]\s*name = "typerelay-panel"\s*version = ")[^"]+(")/, 1],
			['Cargo.lock', /(\[\[package\]\]\s*name = "typerelay-(?:client|core|mobile|template-wasm)"\s*version = ")[^"]+(")/g, 4],
			['apps/desktop/src-tauri/Cargo.lock', /(\[\[package\]\]\s*name = "typerelay-(?:client|core|panel)"\s*version = ")[^"]+(")/g, 3],
		];
		const stale = [];
		const updates = [];
		for (const [name, pattern, expected] of files) {
			const file = path.join(DesktopVersion.root, name);
			const original = await fs.readFile(file, 'utf8');
			let count = 0;
			const updated = original.replace(pattern, (_, before, after) => { count++; return before + version + after; });
			if (count !== expected) throw new Error('Expected ' + expected + ' version field(s) in ' + name + '; found ' + count);
			if (updated !== original) { stale.push(name); updates.push([file, updated]); }
		}
		await DesktopVersion.config();
		if (check && stale.length) throw new Error('Run pnpm desktop:version to sync ' + stale.join(', '));
		if (!check) for (const [file, updated] of updates) await fs.writeFile(file, updated);
		return { version, stale };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) DesktopVersion.sync(process.argv[2] === '--check').then(({ version, stale }) => console.log('Desktop version ' + version + ': ' + (stale.length ? stale.join(', ') : 'already in sync'))).catch(error => { console.error(error.message); process.exitCode = 1; });
