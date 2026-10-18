import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Assets } from '../services/assets.js';

test('animated GIF normalization and sync acceptance use per-frame height and preserve frames', async t => {
	t.mock.method(Assets, 'save', async (ctx, asset) => asset);
	const raw = Buffer.alloc(100 * 100 * 30 * 3);
	for (let frame = 0; frame < 30; frame++) raw.fill(frame * 8, frame * 100 * 100 * 3, (frame + 1) * 100 * 100 * 3);
	const input = await sharp(raw, { raw: { width: 100, height: 3000, channels: 3, pageHeight: 100 } }).gif().toBuffer();
	const normalized = await Assets.normalize(input);
	assert.equal(normalized.height, 100);
	assert.equal(normalized.width, 100);
	assert.equal(normalized.animated, true);
	assert.deepEqual(normalized.data, input);
	const accepted = await Assets.accept({}, normalized.data, normalized.id);
	assert.deepEqual(accepted, normalized);
	assert.equal((await sharp(accepted.data, { animated: true }).metadata()).pages, 30);
	await assert.rejects(Assets.accept({}, input, '0'.repeat(64)), /hash does not match/);
});

test('oversized GIF frames are rejected before saving on normalization and sync', async () => {
	for (const [width, height] of [[2049, 1], [1, 2049]]) {
		const raw = Buffer.alloc(width * height * 2 * 3); raw.fill(255, width * height * 3);
		const input = await sharp(raw, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif().toBuffer();
		await assert.rejects(Assets.normalize(input), /Animated image dimensions/);
		await assert.rejects(Assets.accept({}, input), /Invalid normalized image dimensions/);
	}
});
