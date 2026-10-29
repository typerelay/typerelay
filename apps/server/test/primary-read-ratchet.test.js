import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lower when removing primary reads; never raise it.
const BASELINE = 0;
const PRIMARY_READ = /read\(['"]primary|primaryQuery|readPreference['"]?\s*:\s*['"]primary|ReadPreference\.PRIMARY/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'dist', 'build', 'target', 'output', 'coverage', 'docs-dist', 'docs-dist-root', '.vitepress', '.pnpm-store']);
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (SKIP_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name))) : /\.(?:[cm]?js|[jt]sx?|vue|pug)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [join(dir, entry.name)] : []);

test('primary reads outside transactions do not grow', () => {
	const files = walk(fileURLToPath(new URL('../../..', import.meta.url)));
	assert.ok(files.some(file => file.endsWith('services/libraries.js')), 'source walk found no server files');
	const hits = files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => PRIMARY_READ.test(line) && !line.includes('session')).map(line => `${file}: ${line.trim().slice(0, 160)}`));
	assert.ok(hits.length <= BASELINE, `Primary reads above baseline ${BASELINE}:\n${hits.join('\n')}`);
});
