import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import { httpInstrumentationConfig, ignoreIncomingRequest, initializationOptions, initializeObservability, observabilityEnabled, safeRequestPath, serviceName, serviceRole } from '../index.js';

describe('TypeRelay observability configuration', () => {
	it('requires both the feature flag and API key', () => {
		assert.equal(observabilityEnabled({ ENABLE_OTEL: 'true', HYPERDX_API_KEY: 'key' }), true);
		assert.equal(observabilityEnabled({ ENABLE_OTEL: 'false', HYPERDX_API_KEY: 'key' }), false);
		assert.equal(observabilityEnabled({ ENABLE_OTEL: 'true' }), false);
	});

	it('uses stable service names for every backend role', () => {
		assert.equal(serviceRole({ TYPERELAY_APP: 'web' }), 'app');
		assert.equal(serviceName({ TYPERELAY_APP: 'web' }), 'typerelay-app');
		assert.equal(serviceName({ SERVER_MODE: 'scheduler' }), 'typerelay-scheduler');
		assert.equal(serviceName({ TYPERELAY_APP: 'mcp' }), 'typerelay-mcp');
		assert.equal(serviceName({ OTEL_SERVICE_NAME: 'custom' }), 'custom');
	});

	it('disables payload capture, redacts private queries and removes noise', () => {
		const options = initializationOptions({ HYPERDX_API_KEY: 'key', HYPERDX_API_URL: 'http://collector', OTEL_SERVICE_NAME: 'typerelay-app' });
		assert.equal(options.advancedNetworkCapture, false);
		assert.equal(options.consoleCapture, true);
		assert.equal(options.url, 'http://collector');
		const config = httpInstrumentationConfig();
		for (const key of ['token', 'code', 'state', 'invite', 'q', 'email', 'redirect_uri', 'code_challenge', 'session_id']) assert.ok(config.redactedQueryParams.includes(key));
		for (const path of ['/health', '/assets/app.js', '/docs/', '/vendor/webauthn/index.js', '/white-label-assets/logo.png']) assert.equal(ignoreIncomingRequest({ url: path }), true);
		assert.equal(ignoreIncomingRequest({ url: '/api/v3/snippets?q=private' }), false);
		assert.equal(safeRequestPath('/api/v3/snippets?q=private'), '/api/v3/snippets');
		assert.equal(config.startIncomingSpanHook({ url: '/auth/callback?token=private' })['url.query'], '[REDACTED]');
	});

	it('initializes once and stays non-fatal when disabled', () => {
		const first = initializeObservability({ ENABLE_OTEL: 'false', OTEL_SERVICE_NAME: 'disabled-test' });
		const second = initializeObservability({ ENABLE_OTEL: 'true', HYPERDX_API_KEY: 'late-key' });
		assert.deepEqual(second, first);
		assert.equal(first.enabled, false);
	});
});

describe('TypeRelay OpenTelemetry export', () => {
	let collector;
	after(async () => { if (collector?.listening) await new Promise(resolve => collector.close(resolve)); });

	it('exports logs, traces, exceptions and runtime metrics', { timeout: 15000 }, async () => {
		const payloads = [];
		collector = http.createServer((request, response) => {
			const chunks = [];
			request.on('data', chunk => chunks.push(chunk));
			request.on('end', () => { payloads.push({ path: request.url, body: Buffer.concat(chunks) }); response.writeHead(200); response.end(); });
		});
		await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
		const endpoint = `http://127.0.0.1:${collector.address().port}`;
		const script = `await import('./apps/server/observability/register.js'); const http = await import('node:http'); const runtime = await import('./apps/server/observability/index.js'); const server = http.createServer((request, response) => { console.log('typerelay-observability-log'); if (request.url.startsWith('/failure')) runtime.recordException(new Error('typerelay-observability-exception')); response.end('ok'); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await new Promise((resolve, reject) => { const request = http.get('http://127.0.0.1:' + server.address().port + '/failure?token=' + process.env.TEST_PRIVATE_QUERY_VALUE, response => { response.resume(); response.on('end', resolve); }); request.on('error', reject); }); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => setTimeout(resolve, 3500)); await runtime.shutdownObservability();`;
		const env = { ...process.env, ENABLE_OTEL: 'true', HDX_NODE_STOP_ON_TERMINATION_SIGNALS: 'false', HYPERDX_API_KEY: 'test-key', NODE_ENV: 'test', OTEL_BSP_SCHEDULE_DELAY: '250', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=test-key', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf', OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'otlp', OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_METRIC_EXPORT_TIMEOUT: '500', OTEL_SERVICE_NAME: 'typerelay-observability-test', OTEL_TRACES_EXPORTER: 'otlp', TEST_PRIVATE_QUERY_VALUE: 'private-value' };
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('../../../..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', chunk => stderr += chunk.toString());
		const exitCode = await new Promise(resolve => child.on('close', resolve));
		assert.equal(exitCode, 0, stderr);
		const includes = (path, value) => payloads.some(payload => payload.path === path && payload.body.includes(Buffer.from(value)));
		assert.equal(includes('/v1/logs', 'typerelay-observability-log'), true);
		assert.equal(includes('/v1/traces', 'typerelay-observability-test'), true);
		assert.equal(includes('/v1/traces', 'typerelay-observability-exception'), true);
		assert.equal(payloads.some(payload => payload.path === '/v1/metrics' && payload.body.includes(Buffer.from('nodejs.eventloop'))), true);
		const leakedPayloads = payloads.filter(payload => payload.body.includes(Buffer.from('private-value'))).map(payload => { const text = payload.body.toString('latin1'); const index = text.indexOf('private-value'); return { path: payload.path, excerpt: text.slice(Math.max(0, index - 80), index + 80) }; });
		assert.deepEqual(leakedPayloads, []);
	});
});
