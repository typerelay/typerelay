import { TestDatabase } from './database.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import express from 'express';
import { Account, mongoose } from '../model/index.js';
import { WhiteLabel } from '../services/white_label.js';

process.env.NODE_ENV = 'test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

class Fixture {
	static environment = {};
	static directory = '';
	static server;
	static base = '';
	static team;
	static free;
	static async tempFiles(accountId) {
		try { return await readdir(WhiteLabel.temporaryRoot(accountId)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
	}
	static async post(account, kind, parts) {
		Fixture.account = String(account);
		const form = new FormData();
		for (const [name, filename] of parts) form.append(name, new Blob([PNG], { type: 'image/png' }), filename);
		return fetch(`${Fixture.base}/api/v2/white-label/assets/${kind}`, { method: 'POST', body: form });
	}
}

before(async () => {
	for (const key of ['TYPERELAY_HOSTED_EDITION', 'BILLING_ENABLED', 'WHITE_LABEL_ENABLED', 'WHITE_LABEL_ASSETS_DIR']) Fixture.environment[key] = process.env[key];
	Fixture.directory = await mkdtemp('/tmp/typerelay-white-label-upload-');
	Object.assign(process.env, { TYPERELAY_HOSTED_EDITION: 'true', BILLING_ENABLED: 'true', WHITE_LABEL_ENABLED: 'true', WHITE_LABEL_ASSETS_DIR: Fixture.directory });
	const uri = TestDatabase.uri(process.env.MONGO_URI, 'typerelay_white_label_upload_test');
	await mongoose.connect(uri);
	await TestDatabase.drop(mongoose.connection, 'typerelay_white_label_upload_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	Fixture.team = await Account.create({ name: 'White-label upload team', plan: 'team', billing: { status: 'active' } });
	Fixture.free = await Account.create({ name: 'White-label upload free', plan: 'free', billing: { status: 'active' } });
	const { Server } = await import('../app.js');
	const app = express();
	app.use((req, res, next) => { req.ctx = { account: Fixture.account }; next(); });
	app.post('/api/v2/white-label/assets/:kind', Server.whiteLabelAssetUpload);
	app.use((error, req, res, next) => {
		if (res.headersSent) return next(error);
		res.status(error.status || 500).json({ error: error.message || 'Request failed; please retry', ...(typeof error.code === 'string' && error.code ? { code: error.code } : {}) });
	});
	Fixture.server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => Fixture.server.once('listening', resolve));
	Fixture.base = `http://127.0.0.1:${Fixture.server.address().port}`;
});

after(async () => {
	await new Promise(resolve => Fixture.server.close(resolve));
	await TestDatabase.drop(mongoose.connection, 'typerelay_white_label_upload_test');
	await mongoose.disconnect();
	await rm(Fixture.directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(Fixture.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('upload writes a valid image and leaves no temporary file', async () => {
	const response = await Fixture.post(Fixture.team._id, 'logo', [['file', 'logo.png']]);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.match(body.settings.logo_url, new RegExp(`/white-label-assets/${Fixture.team._id}/logo/logo-`));
	assert.equal((await stat(`${Fixture.directory}/${body.settings.logo_url.replace('/white-label-assets/', '')}`)).isFile(), true);
	assert.deepEqual(await Fixture.tempFiles(Fixture.team._id), []);
});

test('unexpected file field is rejected and leaves no temporary file', async () => {
	const response = await Fixture.post(Fixture.team._id, 'logo', [['image', 'logo.png']]);
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, 'Choose an image');
	assert.deepEqual(await Fixture.tempFiles(Fixture.team._id), []);
});

test('two files are rejected and leave no temporary files', async () => {
	const response = await Fixture.post(Fixture.team._id, 'logo', [['file', 'one.png'], ['image', 'two.png']]);
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, 'Choose an image');
	assert.deepEqual(await Fixture.tempFiles(Fixture.team._id), []);
});

test('ineligible account writes no file before parsing', async () => {
	const response = await Fixture.post(Fixture.free._id, 'logo', [['file', 'logo.png']]);
	assert.equal(response.status, 403);
	assert.equal((await response.json()).code, 'plan_required');
	assert.deepEqual(await Fixture.tempFiles(Fixture.free._id), []);
});