import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sensitiveQueryParameters = ['sig', 'Signature', 'AWSAccessKeyId', 'X-Goog-Signature', 'token', 'code', 'state', 'invite', 'q', 'query', 'search', 'email', 'redirect_uri', 'code_challenge', 'session_id'];
let state = { attempted: false, enabled: false, reason: 'not initialized', service: null };
let hyperdx = null;

function truthy(value) {
	return value === true || ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function serviceRole(env = process.env) {
	const role = String(env.TYPERELAY_APP || env.SERVER_MODE || 'app').trim().toLowerCase();
	return role === 'web' ? 'app' : role;
}

export function serviceName(env = process.env) {
	return env.OTEL_SERVICE_NAME || `typerelay-${serviceRole(env)}`;
}

export function observabilityEnabled(env = process.env) {
	return truthy(env.ENABLE_OTEL) && Boolean(String(env.HYPERDX_API_KEY || '').trim());
}

export function ignoreIncomingRequest(request) {
	const path = String(request?.url || '/').split('?')[0];
	return path === '/favicon.ico' || path === '/health' || path.startsWith('/assets/') || path.startsWith('/docs') || path.startsWith('/vendor/') || path.startsWith('/white-label-assets/');
}

export function safeRequestPath(value) {
	const path = String(value || '/').split('?')[0];
	return path || '/';
}

function safeSpanAttributes(request) {
	const path = safeRequestPath(request?.url || request?.path);
	const protocol = request?.protocol || (request?.socket?.encrypted ? 'https:' : 'http:');
	const host = request?.host || request?.hostname || request?.headers?.host || 'localhost';
	return { 'http.target': path, 'http.url': `${protocol}//${host}${path}`, 'url.full': `${protocol}//${host}${path}`, 'url.path': path, 'url.query': '[REDACTED]' };
}

export function httpInstrumentationConfig() {
	return { ignoreIncomingRequestHook: ignoreIncomingRequest, redactedQueryParams: [...sensitiveQueryParameters], startIncomingSpanHook: safeSpanAttributes, startOutgoingSpanHook: safeSpanAttributes };
}

export function initializationOptions(env = process.env) {
	const options = { advancedNetworkCapture: false, apiKey: env.HYPERDX_API_KEY, consoleCapture: true, instrumentations: { '@opentelemetry/instrumentation-http': httpInstrumentationConfig() }, service: serviceName(env) };
	const url = env.HYPERDX_API_URL || env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (url) options.url = url;
	return options;
}

export function initializeObservability(env = process.env) {
	if (state.attempted) return { ...state };
	state = { attempted: true, enabled: false, reason: 'disabled', service: serviceName(env) };
	if (!observabilityEnabled(env)) return { ...state };
	try {
		process.env.OTEL_SERVICE_NAME = state.service;
		hyperdx = require('@hyperdx/node-opentelemetry');
		hyperdx.init(initializationOptions(env));
		const { registerInstrumentations } = require('@opentelemetry/instrumentation');
		const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');
		registerInstrumentations({ instrumentations: [new RuntimeNodeInstrumentation()] });
		state = { attempted: true, enabled: true, reason: null, service: state.service };
		console.log(JSON.stringify({ event: 'observability_initialized', service: state.service }));
	} catch (error) {
		state = { attempted: true, enabled: false, reason: error.message || String(error), service: state.service };
		console.warn(JSON.stringify({ event: 'observability_initialization_failed', service: state.service, error: state.reason }));
	}
	return { ...state };
}

export function observabilityState() {
	return { ...state };
}

export function recordException(error) {
	if (!state.enabled || !hyperdx || typeof hyperdx.recordException !== 'function') return false;
	hyperdx.recordException(error instanceof Error ? error : new Error(String(error)));
	return true;
}

export async function shutdownObservability() {
	if (!state.enabled || !hyperdx || typeof hyperdx.shutdown !== 'function') return false;
	try {
		await hyperdx.shutdown();
		return true;
	} catch (error) {
		console.warn(JSON.stringify({ event: 'observability_shutdown_failed', service: state.service, error: error.message || String(error) }));
		return false;
	}
}
