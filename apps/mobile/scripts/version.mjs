import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class MobileVersion {
	static root = fileURLToPath(new URL('../../../', import.meta.url));
	static async version() {
		const { version_mobile: version, build_mobile: build } = JSON.parse(await readFile(path.join(MobileVersion.root, 'package.json'), 'utf8'));
		if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Root version_mobile must contain three version integers');
		if (!Number.isInteger(build) || build < 1 || build > 2100000000) throw new Error('Root build_mobile must be an integer from 1 to 2100000000');
		return { version, build };
	}
	static async prepare({ check = false } = {}) {
		const { version, build } = await MobileVersion.version();
		const file = path.join(MobileVersion.root, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
		const source = await readFile(file, 'utf8');
		if ([...source.matchAll(/MARKETING_VERSION = [^;]+;/g)].length !== 4 || [...source.matchAll(/CURRENT_PROJECT_VERSION = [^;]+;/g)].length !== 4) throw new Error('Expected iOS app and keyboard Debug/Release version settings');
		const prepared = source.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
		if (check && prepared !== source) throw new Error('iOS versions are stale. Run pnpm mobile:build, mobile:sync, or native:ios before packaging.');
		if (!check && prepared !== source) await writeFile(file, prepared);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await MobileVersion.prepare({ check: process.argv.includes('--check') });
