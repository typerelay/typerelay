import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../plugins/typerelay/', import.meta.url);
test('portable submission package has bounded listing text, real assets and complete reviewer cases', async () => {
	const manifest = JSON.parse(await readFile(new URL('plugin.json', root), 'utf8'));
	const mcp = JSON.parse(await readFile(new URL('mcp.json', root), 'utf8'));
	const openai = manifest.extensions['com.openai'];
	assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
	assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
	assert.equal(openai.interface.displayName, 'Typerelay');
	assert.equal(openai.interface.developerName, 'Helpmonks');
	assert.ok(openai.interface.shortDescription.length <= 30);
	assert.ok(openai.interface.longDescription.length <= 4000);
	assert.ok(!/[\t\n]/.test(openai.interface.shortDescription));
	for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) assert.equal(new URL(openai.interface[field]).protocol, 'https:');
	for (const field of ['composerIcon', 'logo']) { const asset = openai.interface[field]; assert.ok(asset.startsWith('./assets/')); const bytes = await readFile(new URL(asset, root)); assert.equal(bytes.subarray(1, 4).toString(), 'PNG'); assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20)); assert.ok(bytes.readUInt32BE(16) >= 48); }
	assert.equal(openai.review.test_cases.positive.length, 5);
	assert.equal(openai.review.test_cases.negative.length, 3);
	for (const testcase of openai.review.test_cases.positive) for (const field of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) assert.ok(testcase[field]?.trim());
	for (const testcase of openai.review.test_cases.negative) assert.ok(testcase.description.includes(': '));
	assert.ok(openai.publication.release_notes.trim());
	assert.equal(new URL(openai.review.demo_recording_url).protocol, 'https:');
	assert.equal(openai.review.test_credentials, undefined);
	assert.equal(openai.review.reviewer_instructions, undefined);
	assert.equal(openai.apps, undefined);
	assert.equal(openai.hooks, undefined);
	assert.deepEqual(Object.keys(mcp.mcpServers), ['typerelay']);
	const server = mcp.mcpServers.typerelay;
	assert.equal(server.type, 'streamable-http'); assert.equal(server.url, 'https://mcp.typerelay.com/mcp/app');
	assert.equal(server.extensions['com.openai'].auth.resource, server.url);
	assert.deepEqual(server.extensions['com.openai'].auth.client, { mode: 'dcr' });
	assert.equal(server.extensions['com.openai'].auth.oidcEnabled, false);
	assert.ok(!JSON.stringify(mcp).includes('clientSecret'));
});
