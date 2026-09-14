import { operations, scopes } from './catalog.js';

const string = { type: 'string' };
const revision = { type: 'integer', minimum: 1, example: 1 };
const value = { example: { title: 'Greeting', trigger: 'hello', content: { version: 1, type: 'plain_text', text: 'Hello!' } }, type: 'object', required: ['content'], properties: { title: string, trigger: { type: ['string', 'null'] }, content: { type: 'object', required: ['version', 'type', 'text'], properties: { version: { const: 1 }, type: { enum: ['plain_text', 'code'] }, text: string, language: string } } } };
const target = { type: 'object', required: ['type', 'id', 'library', 'revision'], properties: { type: { enum: ['library', 'snippet'] }, id: string, library: string, revision } };
const item = { type: 'object', required: ['id', 'base_revision'], properties: { id: string, base_revision: revision, value } };
const properties = { operation_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{16,128}$', example: '5cfdde92-55f8-4bcc-a142-62456f04d308', description: 'Persist a unique operation ID before sending; reuse only for an identical retry.' }, base_revision: revision, snippet_revision: revision, id: { ...string, example: '58748170-dd84-4dd4-bcd1-0d3991922805' }, name: string, shared: { type: 'boolean' }, editable: { type: 'boolean' }, members: { type: 'array', items: string }, groups: { type: 'array', items: string }, users: { type: 'array', items: string }, role: { enum: ['admin', 'member'] }, deleted: { type: 'boolean' }, snippets: { type: 'array', items: value }, yaml: string, value, base: value, target, targets: { type: 'array', items: target }, action: { enum: ['move', 'trash', 'restore'] }, source_library: string, destination_library: string, items: { type: 'array', items: item }, source: { description: 'Export text, or a parsed JSON export. Maximum 8 MiB.' }, filename: string, selected: { type: 'array', items: { type: 'object', required: ['key'], properties: { key: string, trigger: { type: ['string', 'null'] } } } }, triggers: { type: 'object', additionalProperties: { type: ['string', 'null'] } }, choice: { enum: ['local', 'server', 'merged'] } };
const snippet = { ...value, properties: { ...value.properties, id: string, library: string, account: string, position: { type: 'number' }, revision, state: { enum: ['active', 'trashed', 'purged'] } } };
const library = { type: 'object', properties: { id: string, name: string, account: string, creator: string, revision, shared: { type: 'boolean' }, editable: { type: 'boolean' }, members: { type: 'array', items: string }, groups: { type: 'array', items: string }, state: { enum: ['active', 'trashed', 'purged'] }, permissions: { type: 'object', properties: { read: { type: 'boolean' }, edit: { type: 'boolean' }, manage: { type: 'boolean' } } } } };
export class ApiSchema {
	static body(operation) {
		const fields = {
			create_library: ['name', 'snippets', 'yaml'], update_library: ['base_revision', 'name', 'shared', 'editable', 'members', 'groups'],
			create_snippet: ['base_revision', 'id', 'value'], update_snippet: ['base_revision', 'snippet_revision', 'value', 'base'],
			batch_snippets: ['action', 'source_library', 'destination_library', 'items'], preview_import: ['source', 'filename'], commit_import: ['source', 'filename', 'selected'],
			change_trash: ['target', 'action'], purge_item: ['target'], empty_trash: ['targets'], resolve_conflict: ['base_revision', 'choice', 'value'],
			create_group: ['name', 'users'], update_group: ['name', 'users', 'deleted'], update_member: ['role'], revoke_device: [],
		}[operation.id] || [];
		const optional = new Set(['yaml', 'snippets', 'base', 'destination_library', 'filename', 'triggers', 'role', 'deleted']);
		if (operation.id === 'resolve_conflict') optional.add('value');
		if (operation.id === 'update_group') { optional.add('name'); optional.add('users'); }
		return { type: 'object', additionalProperties: false, properties: Object.fromEntries([...(operation.mutation ? ['operation_id'] : []), ...fields].map(key => [key, key === 'action' ? { enum: operation.id === 'batch_snippets' ? ['move', 'trash'] : ['trash', 'restore'] } : properties[key]])), required: [...(operation.mutation ? ['operation_id'] : []), ...fields.filter(key => !optional.has(key))] };
	}
	static example(operation) {
		const samples = { operation_id: '5cfdde92-55f8-4bcc-a142-62456f04d308', base_revision: 1, snippet_revision: 1, id: '58748170-dd84-4dd4-bcd1-0d3991922805', name: 'My snippets', shared: false, editable: false, members: [], groups: [], users: [], snippets: [], value: { title: 'Greeting', trigger: 'hello', content: { version: 1, type: 'plain_text', text: 'Hello!' } }, target: { type: 'snippet', id: '58748170-dd84-4dd4-bcd1-0d3991922805', library: '507f1f77bcf86cd799439011', revision: 1 }, action: operation.id === 'batch_snippets' ? 'move' : 'trash', source_library: '507f1f77bcf86cd799439011', destination_library: '507f1f77bcf86cd799439012', items: [{ id: '58748170-dd84-4dd4-bcd1-0d3991922805', base_revision: 1 }], source: 'matches: [{trigger: hello, replace: Hello}]', filename: 'snippets.yml', selected: [{ key: '0:0', trigger: 'hello' }], choice: 'server' };
		samples.targets = [samples.target];
		return Object.fromEntries(Object.keys(ApiSchema.body(operation).properties).filter(key => samples[key] !== undefined && !(operation.id === 'resolve_conflict' && key === 'value')).map(key => [key, samples[key]]));
	}
	static response(operation) {
		const page = items => ({ type: 'object', required: ['items', 'next_cursor'], properties: { items: { type: 'array', items }, next_cursor: { type: ['string', 'null'] } } });
		if (operation.id === 'list_libraries') return page(library);
		if (['list_snippets', 'search_snippets'].includes(operation.id)) return page(snippet);
		if (operation.id === 'get_library') return library;
		if (operation.id === 'get_snippet') return snippet;
		if (operation.id === 'list_trash') return page({ ...target, properties: { ...target.properties, name: string, expires_at: { type: 'string', format: 'date-time' }, can_restore: { type: 'boolean' }, can_purge: { type: 'boolean' } } });
		if (operation.id === 'get_identity') return { type: 'object', properties: { user: string, account: string, scopes: { type: 'array', items: string } } };
		if (operation.id === 'export_library') return { type: 'object', properties: { yaml: string } };
		if (operation.id === 'list_conflicts') return page({ type: 'object', properties: { id: string, library: string, snippet: string, local: value, base: value, server: snippet } });
		if (operation.id === 'list_devices') return page({ type: 'object', properties: { id: string, name: string, createdAt: { type: 'string', format: 'date-time' } } });
		if (operation.id === 'preview_import') return { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { key: string, name: string, title: string, trigger: { type: ['string', 'null'] }, original_trigger: { type: ['string', 'null'] }, content: value.properties.content, warnings: { type: 'array', items: string }, error: string } } }, warnings: { type: 'array', items: string } } };
		return { type: 'object', properties: { library, libraries: { type: 'array', items: library }, conflicts: { type: 'array', items: string }, moved: { type: 'array', items: string }, trashed: { type: 'array', items: string }, purged: { type: 'array', items: string }, found: { type: 'boolean' } }, additionalProperties: true };
	}
	static specification() {
		const paths = {};
		for (const operation of operations) {
			const path = operation.path.replace(/:([a-z_]+)/g, '{$1}');
			const parameters = [...operation.path.matchAll(/:([a-z_]+)/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: match[1] === 'format' ? { enum: ['yaml', 'snippetslab', 'textexpander', 'textblaze', 'typeit4me'] } : string }));
			if (operation.id.startsWith('list_') || operation.id === 'search_snippets') parameters.push({ in: 'query', name: 'cursor', schema: string }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } });
			if (operation.id === 'search_snippets') parameters.push({ in: 'query', name: 'q', required: true, schema: string });
			(paths[path] ||= {})[operation.method] = { operationId: operation.id, summary: operation.summary, description: `Requires ${operation.scope} and current account/library permission.${operation.mutation ? ' Persist operation_id before sending. Reuse it only for an identical retry. Ordinary deletion uses Trash with 30-day retention.' : ''}`, tags: [operation.tag], security: [{ PersonalToken: [] }, { OAuth: [operation.scope] }], parameters, ...(operation.method !== 'get' ? { requestBody: { required: true, content: { 'application/json': { schema: { ...ApiSchema.body(operation), example: ApiSchema.example(operation) }, example: ApiSchema.example(operation) } } } } : {}), responses: Object.fromEntries([200, 400, 401, 403, 404, 409, 410, 422, 429].map(status => [status, { description: ({ 200: 'Success. Lists return items and next_cursor. Mutations return current library metadata and conflict IDs when applicable.', 400: 'Invalid input', 401: 'Authentication invalid or expired', 403: 'Insufficient scope or permission', 404: 'Resource unavailable', 409: 'Revision conflict or operation ID reused', 410: 'Permanently removed or expired', 422: 'Content validation failed', 429: 'Rate limit exceeded' })[status], content: { 'application/json': { schema: status === 200 ? ApiSchema.response(operation) : { type: 'object', properties: { error: string } } } } }])) };
		}
		return { openapi: '3.1.0', info: { title: 'TypeRelay API', version: '3.0.0', description: 'Account-scoped snippet integrations. Desktop synchronization uses its separate protocol.' }, servers: [{ url: 'http://localhost:3040/api/v3', description: 'Local development' }, { url: 'https://your-instance.example.com/api/v3', description: 'Your deployment' }], paths, components: { securitySchemes: { PersonalToken: { type: 'apiKey', in: 'header', name: 'Authorization', description: '`Token <personal-access-token>`' }, OAuth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: '/integrations/authorize', tokenUrl: '/integrations/token', scopes: Object.fromEntries(scopes.map(scope => [scope, scope])) } } } } } };
	}
}
export default ApiSchema.specification();
