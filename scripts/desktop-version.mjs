import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}
