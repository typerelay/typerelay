import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { TestDatabase } from './database.js';

test('test database selection replaces arbitrary database names and preserves Mongo options', () => {
	for (const source of ['mongodb://localhost:27017/typerelay', 'mongodb://localhost:27017/custom?replicaSet=rs0', 'mongodb://a:27017,b:27018/real?authSource=admin', 'mongodb+srv://user:pass@example.test/?retryWrites=true', 'mongodb://localhost:27017']) {
		const target = TestDatabase.uri(source, 'typerelay_isolation_test');
		assert.match(target, /\/typerelay_isolation_test(?:\?|$)/);
		assert.equal(target.split('?')[1], source.split('?')[1]);
	}
	assert.throws(() => TestDatabase.uri('mongodb://localhost/real', 'real'));
	assert.match(TestDatabase.uri('mongodb://localhost/real', 'typerelay_e2e_test'), /typerelay_e2e_test$/);
	assert.throws(() => TestDatabase.uri(undefined, 'typerelay_isolation_test'));
});

test('database cleanup refuses a different connection and safely skips failed connections', async () => {
	let drops = 0;
	const connection = { readyState: 1, name: 'real', dropDatabase: async () => { drops++; } };
	await assert.rejects(TestDatabase.drop(connection, 'typerelay_isolation_test'), /Refusing/);
	assert.equal(drops, 0);
	connection.name = 'typerelay_isolation_test';
	await TestDatabase.drop(connection, 'typerelay_isolation_test');
	assert.equal(drops, 1);
	connection.readyState = 0;
	await TestDatabase.drop(connection, 'typerelay_isolation_test');
	assert.equal(drops, 1);
});

test('database fixtures cannot bypass guarded cleanup or use literal URI replacement', () => {
	for (const name of readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.js') && !['database.js', 'database.test.js'].includes(name))) {
		const source = readFileSync(new URL(name, import.meta.url), 'utf8');
		assert.doesNotMatch(source, /\.dropDatabase\(/, name);
		assert.doesNotMatch(source, /MONGO_URI\.replace\(/, name);
	}
});
