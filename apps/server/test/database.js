import assert from 'node:assert/strict';

export class TestDatabase {
	static uri(source, name) {
		assert.match(name, /^typerelay_[a-z0-9_]+_test$/);
		assert.equal(typeof source, 'string', 'MONGO_URI is required');
		const match = source.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/);
		assert.ok(match, 'Invalid MongoDB URI');
		return match[1] + '/' + name + (match[2] || '');
	}
	static async drop(connection, name) {
		assert.match(name, /^typerelay_[a-z0-9_]+_test$/);
		if (!connection.readyState) return;
		assert.equal(connection.name, name, 'Refusing to drop a non-test database');
		await connection.dropDatabase();
	}
}
