import { readFileSync, existsSync } from 'node:fs';
import spec from '../.vitepress/data/openapi.json' with { type: 'json' };
const ids = new Set();
for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) {
 if (ids.has(operation.operationId)) throw new Error('Duplicate operationId'); ids.add(operation.operationId);
 const path = '.vitepress/dist/api/operations/' + operation.operationId + '.html';
 if (!existsSync(path)) throw new Error('Missing operation page: ' + path);
 const html = readFileSync(path, 'utf8');
 if (!html.includes('<title>') || !html.includes('name="description"')) throw new Error('Missing metadata: ' + path);
}
console.log('Verified ' + ids.size + ' generated API pages');
