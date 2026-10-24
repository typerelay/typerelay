import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { AccountAccess } from './account_access.js';
import { mongoose, SnippetAsset, Library, Snippet, Conflict } from '../model/index.js';
import { Support } from './support.js';

export class Assets {
	static maximumInput = 5 * 1048576;
	static maximumStored = 2 * 1048576;
	static maximumDimension = 2048;
	static types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
	static id(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
	static metadata(asset) { return { id: asset.id, mime_type: asset.mime_type, size: asset.size, width: asset.width, height: asset.height, animated: asset.animated, source_urls: asset.source_urls || [] }; }
	static async normalize(input) {
		Support.assert(Buffer.isBuffer(input) && input.length > 0 && input.length <= Assets.maximumInput, 'Choose an image up to 5 MiB', 400);
		const detected = await fileTypeFromBuffer(input);
		Support.assert(detected && Assets.types.has(detected.mime), 'Upload a PNG, JPG, WebP, or GIF image', 415);
		const image = sharp(input, { animated: true, limitInputPixels: 4096 * 4096 * 4 });
		const metadata = await image.metadata();
		Support.assert(metadata.width && metadata.height && metadata.width <= 16384 && (metadata.pageHeight || metadata.height) <= 16384, 'Invalid image dimensions', 400);
		const animated = detected.mime === 'image/gif' && Number(metadata.pages || 1) > 1;
		let data; let mimeType;
		if (animated) { Support.assert(metadata.width <= Assets.maximumDimension && (metadata.pageHeight || metadata.height) <= Assets.maximumDimension, 'Animated image dimensions exceed 2048', 400); data = input; mimeType = 'image/gif'; }
		else {
			const pipeline = sharp(input, { limitInputPixels: 4096 * 4096 * 4 }).rotate().resize({ width: Assets.maximumDimension, height: Assets.maximumDimension, fit: 'inside', withoutEnlargement: true });
			if (metadata.hasAlpha) { data = await pipeline.png({ compressionLevel: 9 }).toBuffer(); mimeType = 'image/png'; }
			else { data = await pipeline.jpeg({ quality: 86, mozjpeg: true }).toBuffer(); mimeType = 'image/jpeg'; }
		}
		Support.assert(data.length <= Assets.maximumStored, 'Normalized image exceeds 2 MiB', 413);
		const normalized = await sharp(data, { animated }).metadata();
		return { id: Assets.id(data), data, mime_type: mimeType, size: data.length, width: normalized.width, height: normalized.pageHeight || normalized.height, animated };
	}
	static async put(ctx, input, sourceUrl = '', session = null) {
		const asset = await Assets.normalize(input);
		return Assets.save(ctx, asset, sourceUrl, session);
	}
	static async accept(ctx,input,expectedId='',sourceUrl='') {
		Support.assert(Buffer.isBuffer(input)&&input.length>0&&input.length<=Assets.maximumStored,'Asset exceeds 2 MiB',413);const detected=await fileTypeFromBuffer(input);Support.assert(detected&&Assets.types.has(detected.mime),'Invalid image asset',415);const metadata=await sharp(input,{animated:true,limitInputPixels:4096*4096*4}).metadata();const height=metadata.pageHeight||metadata.height;Support.assert(metadata.width&&height&&metadata.width<=Assets.maximumDimension&&height<=Assets.maximumDimension,'Invalid normalized image dimensions',400);const asset={id:Assets.id(input),data:input,mime_type:detected.mime,size:input.length,width:metadata.width,height,animated:detected.mime==='image/gif'&&Number(metadata.pages||1)>1};Support.assert(!expectedId||asset.id===expectedId,'Asset hash does not match its URL',409);return Assets.save(ctx,asset,sourceUrl);
	}
	static quota = { assets: 1000, bytes: 256 * 1048576 };
	static maxSources = 10;
	// Client-supplied source URLs are untrusted: bound their number and length.
	static sources(list) {
		Support.assert(Array.isArray(list) && list.length <= Assets.maxSources && list.every(source => typeof source === 'string' && source.length <= 2048 && /^https?:\/\//i.test(source) && URL.canParse(source)), `Image sources must be at most ${Assets.maxSources} http(s) URLs of up to 2048 characters`, 422);
		return list;
	}
	// shortcut: concurrent first saves may overshoot the quota slightly, enforce atomically with an account counter if that matters.
	static async admit(ctx, id, session) {
		if (await SnippetAsset.exists({ account: ctx.account, id }).session(session)) return;
		const [used] = await SnippetAsset.aggregate([{ $match: { account: new mongoose.Types.ObjectId(ctx.account) } }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$size' } } }]).session(session);
		Support.assert(!used || (used.count < Assets.quota.assets && used.bytes < Assets.quota.bytes), `Image storage is full (${Assets.quota.assets} images or ${Assets.quota.bytes / 1048576} MiB per account); remove unused images or snippets first`, 413);
	}
	// Merges into the capped list in one update; $addToSet cannot bound the array.
	static async addSources(account, id, sources, session) {
		const existing = { $ifNull: ['$source_urls', []] };
		return SnippetAsset.updateOne({ account, id }, [{ $set: { source_urls: { $slice: [{ $concatArrays: [existing, { $filter: { input: { $literal: [...new Set(sources)] }, cond: { $not: [{ $in: ['$$this', existing] }] } } }] }, Assets.maxSources] } } }], { session, updatePipeline: true });
	}
	static async save(ctx,asset,sourceUrl='',session=null) {
		const sources = Assets.sources(Array.isArray(sourceUrl) ? sourceUrl : sourceUrl ? [sourceUrl] : []);
		const update = { $setOnInsert: { account: ctx.account, ...asset, last_referenced_at: new Date() }, $addToSet: { staged_by: ctx.user } };
		const write = async transaction => {
			await Assets.admit(ctx, asset.id, transaction);
			await SnippetAsset.updateOne({ account: ctx.account, id: asset.id }, update, { upsert: true, session: transaction });
			if (sources.length) await Assets.addSources(ctx.account, asset.id, sources, transaction);
		};
		if (session) await write(session); else await AccountAccess.write(ctx.account, write);
		return Assets.metadata({ ...asset, source_urls: sources });
	}
	static async visible(ctx, ids, session = null) {
		Support.assert(Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)), 'Invalid asset IDs', 400);
		const libraries = await Library.find({ account: ctx.account, state: { $ne: 'purged' } }).session(session).lean();
		const readable = new Set(libraries.filter(library => Support.access(ctx, library).read).map(library => String(library._id)));
		const editable = new Set(libraries.filter(library => Support.access(ctx, library).edit).map(library => String(library._id)));
		const allowed = new Set();
		const snippets = await Snippet.find({ account: ctx.account, state: { $ne: 'purged' }, 'content.assets': { $in: ids } }).select('library content.assets').session(session).lean();
		for (const snippet of snippets) for (const id of snippet.content.assets) { if (readable.has(String(snippet.library))) allowed.add(id); }
		const conflicts = await Conflict.find({ account: ctx.account, resolved: false, $or: ['local', 'base', 'server'].map(key => ({ [key + '.content.assets']: { $in: ids } })) }).select('library resolved local.content.assets base.content.assets server.content.assets').session(session).lean();
		for (const conflict of conflicts) for (const value of [conflict.local, conflict.base, conflict.server]) for (const id of value?.content?.assets || []) { if (!conflict.resolved && editable.has(String(conflict.library))) allowed.add(id); }
		// Uploading bytes grants temporary access; validation consumes the grant in the write transaction.
		const staged = await SnippetAsset.find({ account: ctx.account, id: { $in: ids }, staged_by: ctx.user }).select('id').session(session).lean();
		for (const asset of staged) allowed.add(asset.id);
		return ids.filter(id => allowed.has(id));
	}
	static async get(ctx, id, includeData = false) {
		Support.assert(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id), 'Invalid asset ID', 400);
		Support.assert((await Assets.visible(ctx, [id])).length, 'Asset not found', 404);
		let query = SnippetAsset.findOne({ account: ctx.account, id });
		if (includeData) query = query.select('+data');
		const asset = await query.lean();
		Support.assert(asset, 'Asset not found', 404);
		if (includeData) { const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data?.buffer || asset.data || []); asset.data = data; asset.size = data.length; }
		return asset;
	}
	static async presence(ctx, ids) {
		Support.assert(Array.isArray(ids) && ids.length <= 1000 && ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)), 'Invalid asset IDs', 400);
		const assets = await SnippetAsset.find({ account: ctx.account, id: { $in: await Assets.visible(ctx, [...new Set(ids)]) } }).lean();
		const found = new Set(assets.map(asset => asset.id));
		return { assets: assets.map(Assets.metadata), missing: [...new Set(ids)].filter(id => !found.has(id)) };
	}
	static async mergeSources(ctx, id, sources) {
		Assets.sources(sources);
		await AccountAccess.write(ctx.account, async session => {
			Support.assert((await Assets.visible(ctx, [id], session)).includes(id), 'Image not found', 404);
			const result = await Assets.addSources(ctx.account, id, sources, session);
			Support.assert(result.matchedCount === 1, 'Image not found', 404);
		});
		return { saved: true };
	}
	// IPv4-compatible ::/96, discard 100::/64 and Teredo 2001::/32 can all tunnel to private IPv4 hosts.
	static blocked = new BlockList();
	static { for (const [ip, prefix] of [['::', 96], ['100::', 64], ['2001::', 32]]) Assets.blocked.addSubnet(ip, prefix, 'ipv6'); }
	static privateIp(address) {
		if (isIP(address) === 4) {
			const bytes = address.split('.').map(Number);
			return bytes[0] === 10 || bytes[0] === 127 || bytes[0] === 0 || bytes[0] >= 224 || (bytes[0] === 169 && bytes[1] === 254) || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) || (bytes[0] === 192 && bytes[1] === 168) || (bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 0) || (bytes[0] === 192 && bytes[1] === 88 && bytes[2] === 99) || (bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19)) || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127);
		}
		const normalized = address.toLowerCase();
		return Assets.blocked.check(normalized, 'ipv6') || ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'fec', 'fed', 'fee', 'fef', 'ff', '::ffff:', '64:ff9b:', '2002:'].some(prefix => normalized.startsWith(prefix));
	}
	static async publicHost(url) {
		Support.assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Use a public HTTP or HTTPS image URL', 400);
		// URL keeps the brackets of IPv6 literals; DNS lookup and isIP need the bare address.
		const addresses = await lookup(url.hostname.replace(/^\[(.*)\]$/, '$1'), { all: true, verbatim: true });
		Support.assert(addresses.length && addresses.every(item => !Assets.privateIp(item.address)), 'Remote image host is not public', 400);
		return addresses.map(item => item.address).sort();
	}
	// One budget per request: a shared URL cache, distinct fetch limits and a wall-clock deadline.
	static budget() { return { assets: new Map(), remote: 0, embedded: 0, deadline: Date.now() + 60000 }; }
	static maximumRemote = 32;
	static maximumEmbedded = 64;
	static async remote(ctx, value, session = null, deadline = Infinity) {
		let url; try { url = new URL(value); } catch { Support.assert(false, 'Invalid remote image URL', 400); }
		for (let redirects = 0; redirects <= 3; redirects++) {
			const addresses = await Assets.publicHost(url);
			// Pin the socket lookup to validated addresses; keep the URL hostname for Host and TLS.
			const response = await new Promise((resolve, reject) => {
				const request = (url.protocol === 'https:' ? https : http).get(url, { agent: false, signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))), lookup: (hostname, options, callback) => options.all ? callback(null, addresses.map(address => ({ address, family: isIP(address) }))) : callback(null, addresses[0], isIP(addresses[0])), headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'User-Agent': 'TypeRelay/1.0 image cache' } }, resolve);
				request.on('error', reject);
			});
			try {
				if ([301, 302, 303, 307, 308].includes(response.statusCode)) { Support.assert(redirects < 3 && response.headers.location, 'Too many image redirects', 400); url = new URL(response.headers.location, url); continue; }
				Support.assert(response.statusCode >= 200 && response.statusCode < 300, 'Remote image could not be downloaded', 422);
				const length = Number(response.headers['content-length'] || 0);
				Support.assert(!length || length <= Assets.maximumInput, 'Remote image exceeds 5 MiB', 413);
				const chunks = []; let total = 0;
				for await (const chunk of response) { total += chunk.length; Support.assert(total <= Assets.maximumInput, 'Remote image exceeds 5 MiB', 413); chunks.push(chunk); }
				return await Assets.put(ctx, Buffer.concat(chunks), url.href.length <= 2048 ? url.href : '', session);
			} finally { response.destroy(); }
		}
		Support.assert(false, 'Remote image could not be downloaded', 422);
	}
}
