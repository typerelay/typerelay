import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('production Swift bridge preserves the App Group root and enforces read-only keyboard access', { skip: process.platform !== 'darwin' }, () => {
 const temporary = mkdtempSync(join(tmpdir(), 'typerelay-storage-'));
 const root = fileURLToPath(new URL('../../../', import.meta.url));
 const executable = join(temporary, 'storage-check');
 try {
  const compile = spawnSync('swiftc', ['-import-objc-header', 'apps/mobile/ios/App/Shared/TypeRelayCore.h', 'apps/mobile/ios/App/Shared/TypeRelayCore.swift', 'apps/mobile/test/ios-storage.swift', '-o', executable], { cwd: root, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const run = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  assert.match(run.stdout, /storage policy checks passed/);
 } finally { rmSync(temporary, { recursive: true, force: true }); }
});
