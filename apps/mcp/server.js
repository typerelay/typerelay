// Streamable HTTP and API adapter pattern adapted from Mailtwine (AGPL-3.0).
import express from 'express';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { operations } from '../server/api/catalog.js';
import { ApiSchema } from '../server/api/openapi.js';
import { McpCache } from './cache.js';
import { McpRateLimit } from './rate_limit.js';
import { recordException, shutdownObservability } from '@typerelay/observability';

export class McpApi {
	constructor(base, authorization) { this.base = base; this.authorization = authorization; }
	async request(path, method = 'GET', body, headers = {}) {
		const response = await fetch(this.base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Authorization: this.authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const result = await response.json();
		if (!response.ok) { const error = new Error(result.error || 'API request failed'); error.status = response.status; throw error; }
		return result;
	}
}
export class TypeRelayMcp {
	static catalog = operations.filter(operation => operation.mcp);
	static tool(operation) {
		const schema = operation.method === 'get' ? { type: 'object', properties: {}, required: [], additionalProperties: false } : structuredClone(ApiSchema.body(operation));
		// Path arguments are nested so a new snippet's ID cannot shadow its library ID.
		const path = [...operation.path.matchAll(/:([a-z_]+)/g)].map(match => match[1]);
		if (path.length) { schema.properties.path = { type: 'object', properties: Object.fromEntries(path.map(name => [name, { type: 'string' }])), required: path, additionalProperties: false }; schema.required.push('path'); }
		if (operation.id.startsWith('list_') || operation.id === 'search_snippets') Object.assign(schema.properties, { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } });
		if (operation.id === 'search_snippets') { schema.properties.q = { type: 'string', minLength: 1 }; schema.required.push('q'); }
		return { name: operation.id, description: operation.summary + '. Requires ' + operation.scope + '. ' + (operation.mutation ? 'Persist operation_id for identical retries; supply current revisions. Check returned conflicts before treating edits as accepted.' : ''), inputSchema: schema, annotations: { readOnlyHint: !operation.mutation, destructiveHint: operation.mutation, idempotentHint: true, openWorldHint: false }, _meta: { securitySchemes: [{ type: 'oauth2', scopes: [operation.scope] }] } };
	}
	static async call(api, name, args) {
		const operation = TypeRelayMcp.catalog.find(operation => operation.id === name);
		if (!operation) throw new Error('Unknown tool');
		const body = { ...args }; delete body.path;
		const path = operation.path.replace(/:([a-z_]+)/g, (match, key) => { if (typeof args.path?.[key] !== 'string' || !args.path[key]) throw new Error('Missing path.' + key); return encodeURIComponent(args.path[key]); });
		const query = operation.method === 'get' ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : null;
		return api.request('/api/v3' + path + (query?.size ? '?' + query : ''), operation.method.toUpperCase(), operation.method === 'get' ? undefined : body);
	}
	static app({ apiBase = process.env.API_BASE_URL || 'http://localhost:3040', resource = (process.env.MCP_BASE_URL || 'http://localhost:3041').replace(/\/$/, '') + '/mcp', issuer = process.env.APP_URL || 'http://localhost:3040', secret = () => process.env.JWT_SECRET || 'change-me', applyRateLimits = true } = {}) {
		const app = express();
		if (process.env.IS_DOCKER === 'true') app.set('trust proxy', 1);
		app.disable('x-powered-by');
		const origin = new URL(resource).origin;
		const metadata = origin + '/.well-known/oauth-protected-resource' + new URL(resource).pathname;
		app.use((req, res, next) => {
			if (req.headers.origin && ![origin, issuer, ...(process.env.MCP_ALLOWED_ORIGINS || '').split(',')].includes(req.headers.origin)) return res.status(403).json({ error: 'Invalid Origin' });
			res.set('Cache-Control', 'no-store'); next();
		});
		app.get('/health', (req, res) => res.json({ ok: true, transport: 'streamable-http' }));
		app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json({ resource, authorization_servers: [issuer], scopes_supported: [...new Set(TypeRelayMcp.catalog.map(operation => operation.scope))], bearer_methods_supported: ['header'] }));
		if (applyRateLimits) { app.use(McpRateLimit.createIpFloodLimiter()); app.use(McpRateLimit.createUnauthLimiter()); }
		const authenticatedRequestLimiter = applyRateLimits ? McpRateLimit.createAuthenticatedRequestLimiter() : null;
		app.use(express.json({ limit: '12mb' }));
		app.post('/mcp', async (req, res) => {
			let server; let transport;
			try {
				if (!/^(Bearer|Token) [^ ]+$/.test(req.headers.authorization || '')) { const error = new Error('Authentication required'); error.status = 401; throw error; }
				const upstream = new McpApi(apiBase, req.headers.authorization);
				const delegated = await upstream.request('/integrations/delegate', 'POST', {}, { 'X-MCP-Secret': secret() });
				if (applyRateLimits && !await McpRateLimit.consumeAuthenticatedRequest(authenticatedRequestLimiter, req, res)) return;
				const rateLimitKey = applyRateLimits ? McpRateLimit.getCredentialOrIpKey(req) : null;
				const api = new McpApi(apiBase, 'Bearer ' + delegated.access_token);
				const identity = await api.request('/api/v3/me');
				server = new Server({ name: 'typerelay', version: '0.1.0' }, { capabilities: { tools: {} } });
				server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TypeRelayMcp.catalog.filter(operation => identity.scopes.includes(operation.scope)).map(TypeRelayMcp.tool) }));
				server.setRequestHandler(CallToolRequestSchema, async request => {
					try {
						const operation = TypeRelayMcp.catalog.find(operation => operation.id === request.params.name);
						if (!operation || !identity.scopes.includes(operation.scope)) throw new Error('Unknown tool or insufficient scope');
						const args = request.params.arguments || {};
						const run = () => TypeRelayMcp.call(api, request.params.name, args);
						const result = applyRateLimits ? await McpRateLimit.runToolWithLimits({ toolName: request.params.name, args, rateLimitKey, run }) : await run();
						if (result?.isError) return result;
						return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
					} catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
				});
				transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
				res.on('close', () => { transport?.close(); server?.close(); });
				await server.connect(transport);
				// JSON-only clients need not advertise SSE, matching Mailtwine.
				req.headers.accept = 'application/json, text/event-stream';
				await transport.handleRequest(req, res, req.body);
			} catch (error) {
				if (res.headersSent) return;
				if (!error.status || error.status >= 500) recordException(error);
				if (error.status === 401) res.set('WWW-Authenticate', 'Bearer resource_metadata="' + metadata + '"');
				res.status(error.status || 500).json({ error: error.status ? error.message : 'MCP request failed' });
			}
		});
		app.all('/mcp', (req, res) => res.set('Allow', 'POST').status(405).json({ error: 'Use POST with Streamable HTTP' }));
		app.use((error, req, res, next) => { if (!error.status || error.status >= 500) recordException(error); res.status(error.status || 500).json({ error: error.status === 413 ? 'Request too large' : 'Invalid request' }); });
		return app;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (McpRateLimit.getConfig().enabled) await McpCache.connect();
		const port = Number(process.env.PORT || 3041);
		TypeRelayMcp.app().listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'service_started', service: process.env.OTEL_SERVICE_NAME || 'typerelay-mcp', mode: 'mcp', port, version: process.env.APP_VERSION || 'development' })));
	} catch (error) {
		recordException(error);
		console.error(JSON.stringify({ event: 'service_start_failed', service: process.env.OTEL_SERVICE_NAME || 'typerelay-mcp', error: error.message || String(error) }));
		await shutdownObservability();
		process.exit(1);
	}
}
