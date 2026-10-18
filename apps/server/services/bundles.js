import { inflateRaw } from 'node:zlib';
import { strFromU8, strToU8, Unzip, unzipSync, zipSync } from 'fflate';
import { Libraries } from './libraries.js';
import { Assets } from './assets.js';
import { Support, Yaml } from './support.js';
import { SnippetAsset } from '../model/index.js';

export class Bundles {
	static entry(snippet) { if (snippet.content?.type === 'rich_text') return { trigger: snippet.trigger, title: snippet.title, replace: snippet.content.markdown, type: 'rich_text', variables: snippet.content.variables || {} }; return Libraries.yaml(snippet); }
	static async export(ctx, id) {
		const library = await Libraries.get(ctx, id);
		const manifest = await Yaml.export(library.snippets.map(Bundles.entry));
		const ids = [...new Set(library.snippets.flatMap(snippet => snippet.content?.assets || []))]; const assetMetadata = {}; const files = { 'snippets.yml': strToU8(manifest.yaml) };
		Support.assert(ids.length <= 998, 'Bundle has too many images; export smaller libraries', 413);
		let total = files['snippets.yml'].length;
		if (ids.length) {
			Support.assert((await Assets.visible(ctx, ids)).length === ids.length, 'Asset not found', 404);
			const cursor = SnippetAsset.find({ account: ctx.account, id: { $in: ids } }).select('+data').lean().cursor({ batchSize: 16 });
			let found = 0;
			try { for await (const asset of cursor) { const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data?.buffer || asset.data || []); total += data.length; Support.assert(total <= 24 * 1048576, 'Expanded bundle is too large; export a smaller library', 413); files[`assets/${asset.id}`] = new Uint8Array(data); assetMetadata[asset.id] = Assets.metadata({ ...asset, size: data.length }); found++; } }
			finally { await cursor.close(); }
			Support.assert(found === ids.length, 'Asset not found', 404);
		}
		files['bundle.json'] = strToU8(JSON.stringify({ version: 1, name: library.name, assets: ids, asset_metadata: assetMetadata }));
		const bytes = Buffer.from(zipSync(files, { level: 6 }));
		Support.assert(bytes.length <= 16 * 1048576, 'Bundle exceeds 16 MiB; export a smaller library', 413);
		let expanded = 0;
		unzipSync(bytes, { filter: entry => { expanded += Math.max(entry.size, entry.originalSize); return false; } });
		Support.assert(expanded <= 24 * 1048576, 'Expanded bundle is too large; export a smaller library', 413);
		return { name: `${library.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'snippets'}.typerelay.zip`, bytes };
	}
	static async import(ctx, input) {
		Support.assert(Buffer.isBuffer(input) && input.length > 0 && input.length <= 16 * 1048576, 'Choose a TypeRelay bundle up to 16 MiB', 400);
		let files;
		try {
			let total = 0; const entries = new Map();
			unzipSync(input, { filter: entry => { total += Math.max(entry.size, entry.originalSize); Support.assert(!entries.has(entry.name), 'Duplicate bundle entry', 422); entries.set(entry.name, entry); Support.assert(entries.size <= 1000 && Number.isSafeInteger(total) && total <= 24 * 1048576, 'Expanded bundle is too large', 413); return false; } });
			// Native inflation enforces actual output size, even when ZIP headers lie.
			class BoundedInflate {
				static compression = 8;
				constructor(name) { this.entry = entries.get(name); this.chunks = []; this.size = 0; }
				push(chunk, final) {
					this.size += chunk.length;
					Support.assert(this.size <= this.entry.size, 'Invalid compressed bundle size', 422);
					this.chunks.push(chunk);
					if (final) inflateRaw(Buffer.concat(this.chunks), { maxOutputLength: Math.max(1, this.entry.originalSize) }, (error, bytes) => this.ondata(error, bytes, true));
				}
			}
			files = await new Promise((resolve, reject) => {
				const result = Object.create(null); const seen = new Set(); let pending = 0; let parsed = false;
				const complete = () => { if (parsed && !pending) resolve(result); };
				const archive = new Unzip(file => {
					const entry = entries.get(file.name);
					Support.assert(entry && !seen.has(file.name) && entry.compression === file.compression, 'Invalid bundle entry', 422);
					seen.add(file.name); pending++;
					const chunks = []; let size = 0;
					file.ondata = (error, bytes, final) => {
						if (error) { reject(error); return; }
						size += bytes.length;
						if (size > entry.originalSize || (final && size !== entry.originalSize)) { reject(new Error('Invalid expanded bundle size')); return; }
						chunks.push(bytes);
						if (final) { result[file.name] = Buffer.concat(chunks); pending--; complete(); }
					};
					file.start();
				});
				archive.register(BoundedInflate);
				archive.push(input, true);
				Support.assert(seen.size === entries.size, 'Missing bundle entry', 422);
				parsed = true; complete();
			});
		} catch (error) { if (error.status) throw error; Support.assert(false, 'Invalid TypeRelay bundle', 422); }
		Support.assert(Object.keys(files).length <= 1000 && Object.values(files).reduce((total, value) => total + value.length, 0) <= 24 * 1048576, 'Expanded bundle is too large', 413);
		Support.assert(files['bundle.json'] && files['snippets.yml'], 'Bundle requires bundle.json and snippets.yml', 422);
		let metadata; try { metadata = JSON.parse(strFromU8(files['bundle.json'])); } catch { Support.assert(false, 'Invalid bundle metadata', 422); }
		Support.assert(metadata.version === 1 && typeof metadata.name === 'string' && Array.isArray(metadata.assets) && metadata.assets.length <= 998 && new Set(metadata.assets).size === metadata.assets.length, 'Unsupported bundle metadata', 422);
		for (const id of metadata.assets) { Support.assert(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) && files[`assets/${id}`], `Bundle asset ${id} is missing`, 422); let saved = metadata.asset_metadata?.[id]; if (!saved && files[`metadata/${id}.json`]) { try { saved = JSON.parse(strFromU8(files[`metadata/${id}.json`])); } catch { Support.assert(false, 'Invalid image metadata', 422); } } const sources = saved?.source_urls || []; Support.assert(Array.isArray(sources) && sources.every(source => typeof source === 'string'), 'Invalid image sources', 422); await Assets.accept(ctx, Buffer.from(files[`assets/${id}`]), id, sources); }
		const parsed = await Yaml.run(strFromU8(files['snippets.yml']));
		return { name: metadata.name, snippets: parsed.matches };
	}
}
