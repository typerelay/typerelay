import crypto from 'node:crypto';

export class RateLimitSupport {
	static boolean(name, component) {
		const value = process.env[name];
		if (value === undefined || value === null || value === '') throw new Error(`${component}.getConfig(), missing required env '${name}'`);
		return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
	}
	static integer(name, component, minimum = 0) {
		const value = process.env[name];
		if (value === undefined || value === null || value === '') throw new Error(`${component}.getConfig(), missing required env '${name}'`);
		const normalized = String(value).trim();
		if (!/^\d+$/.test(normalized)) throw new Error(`${component}.getConfig(), env '${name}' must be an integer >= ${minimum}`);
		const parsed = Number(normalized);
		if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${component}.getConfig(), env '${name}' must be an integer >= ${minimum}`);
		return parsed;
	}
	static requestPath(request, prefix = '') {
		const path = (request.originalUrl || request.url || request.path || '').split('?')[0] || '/';
		return prefix ? path.replace(new RegExp(`^${prefix}(?=/|$)`), '') || '/' : path;
	}
	static clientIp(request) {
		const headers = request.headers || {};
		let ip = RateLimitSupport.firstHeader(headers['cf-connecting-ip'] || headers['fastly-client-ip'] || headers['true-client-ip'] || headers['x-real-ip'] || headers['x-forwarded-for'] || request.ip || request.connection?.remoteAddress || request.socket?.remoteAddress || '127.0.0.1');
		if (ip.startsWith('::ffff:')) ip = ip.slice(7);
		if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') === -1 ? undefined : ip.indexOf(']'));
		if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
		return ip || '127.0.0.1';
	}
	static firstHeader(value) {
		if (Array.isArray(value)) return value[0] || '';
		return String(value || '').split(',')[0].trim();
	}
	static credential(request) {
		const authorization = request.headers?.authorization || '';
		if (!/^(Bearer|Token)\s+/i.test(authorization)) return null;
		return authorization.replace(/^(Bearer|Token)\s+/i, '').trim() || null;
	}
	static key(product, type, value) {
		const hash = crypto.createHash('sha256').update(`${product}:${type}:${value}`).digest('hex');
		return `${product}:${type}:${hash}`;
	}
	static credentialOrIpKey(product, request) {
		const credential = RateLimitSupport.credential(request);
		return credential ? RateLimitSupport.key(product, 'bearer', credential) : RateLimitSupport.key(product, 'ip', RateLimitSupport.clientIp(request));
	}
	static cacheServers() {
		return [...new Set(String(process.env.MEMCACHED_SERVERS || 'localhost:11211').split(',').map(value => value.trim()).filter(Boolean))];
	}
}
