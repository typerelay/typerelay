import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PanelRelease } from '../../../scripts/release-panel.mjs';

test('completed release cleanup verifies retained artifacts and preserves incomplete or active runs', async t => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-release-cleanup-'));
	t.after(() => fs.rm(temp, { recursive: true, force: true }));
	const root = await fs.realpath(temp);
	const releases = path.join(root, 'target/desktop-releases');
	const commit = '123456789abcde';
	const version = '1.2.3';
	const targets = {
		macos: ['aarch64-apple-darwin', 'dmg/test.dmg'],
		linux: ['x86_64-unknown-linux-gnu', 'appimage/test.AppImage'],
		windows: ['x86_64-pc-windows-msvc', 'nsis/test.exe'],
	};
	const build = async (name, { platform = 'macos', completed = true, verified = true } = {}) => {
		const [target, bundle] = targets[platform];
		const run = path.join(releases, platform, '123456789abc-' + name);
		const artifact = path.join(target, 'release/bundle', bundle);
		const binary = path.join(run, target, 'release/typerelay-panel');
		for (const directory of ['release/deps', path.join(target, 'release/build'), path.dirname(artifact), 'notarized/TypeRelay.app']) await fs.mkdir(path.join(run, directory), { recursive: true });
		await fs.writeFile(path.join(run, artifact), 'signed');
		await fs.writeFile(binary, 'binary');
		const provenance = { version, commit, target };
		if (verified) await fs.writeFile(path.join(run, 'release-verification.json'), JSON.stringify({ ...provenance, product: 'TypeRelay', platform, directory: run, verified, artifacts: [{ file: artifact, size: 6, sha256: createHash('sha256').update('signed').digest('hex') }] }));
		if (platform === 'macos') await fs.writeFile(path.join(run, 'notarization.json'), JSON.stringify({ ...provenance, completed, status: 'Accepted' }));
		await fs.writeFile(path.join(run, 'notarization-upload.zip'), 'notary submission');
		return { run, binary, artifact: path.join(run, artifact), cache: path.join(run, 'release/deps'), build: path.join(run, target, 'release/build') };
	};
	const current = await build('abcdef');
	const older = await build('fedcba', { platform: 'linux' });
	const windows = await build('123456', { platform: 'windows' });
	const pending = await build('defabc', { completed: false });
	const failed = await build('aaabcd', { verified: false });
	const active = await build('bbabcd');
	const changed = await build('ccabcd');
	const symlink = await build('ddabcd');
	const stale = await build('ffabcd');
	await fs.writeFile(path.join(stale.run, 'release.lock'), '2147483647');
	const lock = await PanelRelease.lockRun(active.run);
	await fs.writeFile(changed.artifact, 'broken');
	await fs.rm(symlink.cache, { recursive: true });
	await fs.symlink(active.cache, symlink.cache, 'dir');
	await fs.symlink(older.run, path.join(releases, 'macos/123456789abc-eeabcd'), 'dir');

	const originalRoot = PanelRelease.root; PanelRelease.root = root; t.after(() => { PanelRelease.root = originalRoot; });
	const alias = path.join(root, 'report-alias');
	await fs.symlink(stale.cache, alias, 'dir');
	for (const cache of [stale.cache, alias]) {
		await assert.rejects(PanelRelease.main(['macos', '--dry-run', '--report', path.join(cache, 'new', 'receipt.json')]), /outside Cargo compiler caches/);
	}
	for (const name of ['first.json', 'second.json']) {
		const report = path.join(root, name);
		await PanelRelease.validateReportPath(report);
		await fs.copyFile(path.join(current.run, 'release-verification.json'), report);
		await PanelRelease.pruneCompletedRuns(root);
	}
	assert.equal(await fs.readFile(path.join(root, 'first.json'), 'utf8'), await fs.readFile(path.join(root, 'second.json'), 'utf8'));
	for (const fixture of [current, older, windows, stale]) {
		await assert.rejects(fs.access(fixture.cache), { code: 'ENOENT' });
		await assert.rejects(fs.access(fixture.build), { code: 'ENOENT' });
		assert.equal(await fs.readFile(fixture.artifact, 'utf8'), 'signed');
		assert.equal(await fs.readFile(fixture.binary, 'utf8'), 'binary');
		assert.equal(await fs.readFile(path.join(fixture.run, 'notarization-upload.zip'), 'utf8'), 'notary submission');
		await fs.access(path.join(fixture.run, 'release-verification.json'));
		await fs.access(path.join(fixture.run, 'notarized/TypeRelay.app'));
	}
	for (const fixture of [pending, failed, active, changed, symlink]) await fs.access(fixture.cache);
	assert.ok((await fs.lstat(symlink.cache)).isSymbolicLink());
	assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
});
