import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MobileVersion } from '../scripts/version.mjs';

test('root mobile values prepare every iOS configuration, reject invalid metadata and block stale packaging', async () => {
	const original = MobileVersion.root;
	const root = await mkdtemp(path.join(tmpdir(), 'typerelay-mobile-version-'));
	try {
		const project = path.join(root, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
		await mkdir(path.dirname(project), { recursive: true });
		await writeFile(project, await readFile(path.join(original, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj')));
		MobileVersion.root = root;
		const metadata = { version_mobile: '9.8.7', build_mobile: 123 };
		const save = async data => writeFile(path.join(root, 'package.json'), JSON.stringify(data));
		await save(metadata);
		await assert.rejects(MobileVersion.prepare({ check: true }), /stale/);
		await MobileVersion.prepare();
		await MobileVersion.prepare({ check: true });
		const prepared = await readFile(project, 'utf8');
		assert.equal([...prepared.matchAll(/MARKETING_VERSION = 9.8.7;/g)].length, 4);
		assert.equal([...prepared.matchAll(/CURRENT_PROJECT_VERSION = 123;/g)].length, 4);
		for (const version of [null, 123, '', '1.2', '01.2.3', '1.2.3-beta', '1.2.3\n']) {
			await save({ ...metadata, version_mobile: version });
			await assert.rejects(MobileVersion.prepare(), /version_mobile/);
		}
		for (const build of [null, '123', 0, -1, 1.5, 2100000001]) {
			await save({ ...metadata, build_mobile: build });
			await assert.rejects(MobileVersion.prepare(), /build_mobile/);
		}
		assert.equal(await readFile(project, 'utf8'), prepared);
	} finally {
		MobileVersion.root = original;
		await rm(root, { recursive: true, force: true });
	}
});
