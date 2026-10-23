import crypto from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export class RateLimitSupport {
	static cloudflare = new BlockList();
	static {
		// https://www.cloudflare.com/ips/; update when Cloudflare changes its published ranges.
		for (const cidr of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']) { const [ip, prefix] = cidr.split('/'); RateLimitSupport.cloudflare.addSubnet(ip, Number(prefix), isIP(ip) === 6 ? 'ipv6' : 'ipv4'); }
	}
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
		let ip = RateLimitSupport.firstHeader(request.ip || request.connection?.remoteAddress || request.socket?.remoteAddress || '127.0.0.1');
		if (ip.startsWith('::ffff:')) ip = ip.slice(7);
		if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') === -1 ? undefined : ip.indexOf(']'));
		if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
		const cloudflareIp = RateLimitSupport.firstHeader(headers['cf-connecting-ip']);
		if (isIP(ip) && RateLimitSupport.cloudflare.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4') && isIP(cloudflareIp)) ip = cloudflareIp;
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

export class RateLimitLogger {
	constructor(component) { this.component = component; }
	debug(context, message) { this.write('debug', context, message); }
	info(context, message) { this.write('info', context, message); }
	warn(context, message) { this.write('warn', context, message); }
	error(context, message) { this.write('error', context, message); }
	write(level, context, message) {
		const details = typeof context === 'object' && context !== null ? context : {};
		const text = typeof context === 'string' ? context : message;
		const output = { event: 'rate_limit_dependency', component: this.component, level, message: text || '', ...(details.err ? { error: details.err.message || String(details.err) } : {}) };
		(console[level] || console.log)(JSON.stringify(output));
	}
}
