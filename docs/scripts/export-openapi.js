// Adapted from Mailtwine docs/scripts/export-openapi.js (AGPL-3.0).
import { mkdirSync, writeFileSync } from 'node:fs';
import spec from '../../apps/server/api/openapi.js';
for (const directory of ['public', '.vitepress/data']) { mkdirSync(new URL('../' + directory, import.meta.url), { recursive: true }); writeFileSync(new URL('../' + directory + '/openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n'); }

import { operations } from '../../apps/server/api/catalog.js';
writeFileSync(new URL('../mcp/tools.md', import.meta.url), '# Tools\n\nTools call the public API and preserve its permissions and revisions.\n\n' + operations.filter(operation => operation.mcp).map(operation => '- [' + operation.id + '](/api/operations/' + operation.id + ') — ' + operation.summary + ' (`' + operation.scope + '`).').join('\n') + '\n');
