import { AccountAccess } from './account_access.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { parseDocument } from 'htmlparser2';
import { DOMParser } from '@xmldom/xmldom';
import { Abbreviation } from '../public/abbreviation.js';
import { randomUUID } from 'node:crypto';
import { mongoose, Library, Snippet, SnippetAsset, Operation, Conflict, Account, Change, Member, Group } from '../model/index.js';
import { Support, Yaml } from './support.js';
import { Billing } from './billing.js';
import { RichText } from './rich_text.js';

export class Libraries {
	static retention = 30 * 86400000;
	static trashFields(actor, now = new Date()) { return { state: 'trashed', trashed_at: now, expires_at: new Date(+now + Libraries.retention), trashed_by: actor }; }
	static content(value) {
		const content = value?.content || (value?.type === 'rich_text' ? { version: 2, type: 'rich_text', markdown: value?.replace, variables: value?.variables || {} } : { version: 1, type: value?.type || 'plain_text', language: value?.language || 'plain_text', text: value?.replace, variables: value?.variables });
		if (content.version === 2 && content.type === 'rich_text') return RichText.content(content);
		Support.assert(content.version === 1 && ['plain_text', 'code', 'template'].includes(content.type) && typeof content.text === 'string', 'Unsupported snippet content');
		Support.assert(content.type !== 'code' || (typeof content.language === 'string' && content.language.length > 0 && content.language.length <= 100 && !/[\x00-\x1f\x7f]/.test(content.language)), 'Invalid language');
		return { version: 1, type: content.type, text: content.text.replaceAll('\r\n', '\n'), ...(content.type === 'code' ? { language: content.language } : {}), ...(content.type === 'template' ? { variables: content.variables || {} } : {}) };
	}
	static value(entry, previous = null) {
		Support.assert(previous?.type !== 'template' || entry?.content?.type !== 'template' || Object.hasOwn(entry.content, 'variables'), 'Template variables are required when editing a template; update or reload your client.');
		Support.assert(entry?.title == null || (typeof entry.title === 'string' && Buffer.byteLength(entry.title) <= 500 && !/[\x00-\x1f\x7f]/.test(entry.title)), 'Invalid title');
		Support.assert(entry?.trigger == null || typeof entry.trigger === 'string', 'Invalid abbreviation');
		return { trigger: Abbreviation.normalize(entry?.trigger) || null, title: entry?.title || '', content: Libraries.content(entry) };
	}
	static async prepared(ctx,entry){if(entry?.content?.type==='rich_text')return{...entry,content:await RichText.prepare(ctx,entry.content)};if(entry?.type==='rich_text')return{...entry,content:await RichText.prepare(ctx,{version:2,type:'rich_text',markdown:entry.replace,variables:entry.variables||{}})};return entry;}
	static yaml(entry) { const value = Libraries.value(entry); return { trigger: value.trigger, title: value.title, replace: value.content.text, type: value.content.type === 'rich_text' ? 'plain_text' : value.content.type, language: value.content.language || 'plain_text', variables: value.content.type === 'rich_text' ? {} : (value.content.variables || {}) }; }
	static exportEntry(entry){const value=Libraries.value(entry);if(value.content.type==='rich_text'){Support.assert(!value.content.assets.length,'Export rich text with images as a TypeRelay bundle',409);return{trigger:value.trigger,title:value.title,replace:value.content.markdown,type:'rich_text',variables:value.content.variables};}return Libraries.yaml(value);}
	static entry(snippet) { if(snippet.content?.type==='rich_text'){const assets=Object.fromEntries((snippet.content.assets||[]).map(id=>[id,`/snippet-assets/${snippet.account}/${id}`]));return{...snippet,replace:snippet.content.markdown,rich_html:RichText.render({...snippet.content,assets}).html};}return { ...snippet, replace: snippet.content?.text }; }
	static view(ctx, library) { return { ...library, _id: String(library._id), deleted: library.state !== 'active', permissions: Support.access(ctx, library) }; }
	static async hydrate(library, session) {
		const entries = await Snippet.find({ library: library._id, state: { $ne: 'purged' } }).sort({ position: 1, id: 1 }).session(session || null).lean();
		return { ...library, snippets: entries.filter(entry => entry.state === 'active').sort((a, b) => (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))).map(Libraries.entry), records: entries.map(Libraries.entry) };
	}
	static async get(ctx, id, session, includeTrash = false) {
		const library = await Library.findOne({ _id: Support.id(id), account: ctx.account }).session(session || null).lean();
		Support.assert(library && Support.access(ctx, library).read && (includeTrash || library.state === 'active'), 'Library not found', 404);
		return Libraries.hydrate(library, session);
	}
	static async list(ctx, session) {
		const libraries = await Library.find({ account: ctx.account, state: 'active' }).session(session || null).lean();
		return Promise.all(libraries.filter(library => Support.access(ctx, library).read).map(async library => Libraries.view(ctx, await Libraries.hydrate(library, session))));
	}
	static async validate(entries, ctx = null, session = null) {
		const values = entries.map(Libraries.value);
		await Yaml.validate(values.map(Libraries.yaml));
		if (!ctx) return;
		const ids = [...new Set(values.flatMap(value => value.content.type === 'rich_text' ? value.content.assets : []))];
		if (!ids.length) return;
		const assets = await SnippetAsset.find({ account: ctx.account, id: { $in: ids } }).select('id size').session(session || null).lean();
		Support.assert(assets.length === ids.length, 'Rich text references a missing image asset', 422);
		const sizes = new Map(assets.map(asset => [asset.id, asset.size]));
		for (const value of values.filter(value => value.content.type === 'rich_text')) {
			Support.assert(value.content.assets.reduce((total, id) => total + sizes.get(id), 0) <= 8 * 1048576, 'Rich-text images exceed 8 MiB', 422);
		}
		await SnippetAsset.updateMany({ account: ctx.account, id: { $in: ids } }, { $set: { last_referenced_at: new Date() } }, { session: session || null });
	}
	static importFormats = {
		typerelay: { name: 'TypeRelay bundle', accept: '.typerelay.zip,.zip', instructions: 'Choose a TypeRelay bundle containing snippets.yml and its deduplicated image assets.', beta: false },
		yaml: { name: 'TypeRelay YAML', accept: '.yml,.yaml', instructions: 'Choose a TypeRelay YAML export.', beta: false },
		snippetslab: { name: 'SnippetsLab', accept: '.json', instructions: 'In SnippetsLab, use Library → Export → JSON.', beta: false },
		textexpander: { name: 'TextExpander', accept: '.csv', instructions: 'On TextExpander.com, open Import/Export → Export and download a group as CSV. Native .textexpander files are not supported.', beta: true },
		textblaze: { name: 'Text Blaze', accept: '.json', instructions: 'Open the Text Blaze dashboard’s Import/Export page and export folders as JSON.', beta: true },
		typeit4me: { name: 'TypeIt4Me', accept: '.typeit4me', instructions: 'Choose a .typeit4me snippet set from Finder. Beta supports recognized XML set and XML property-list layouts; binary files are not supported.', beta: true },
	};
	static htmlText(html) {
		Support.assert(typeof html === 'string', 'Invalid HTML content');
		const document = parseDocument(html);
		const render = (node, depth = 0) => {
			Support.assert(depth < 100, 'HTML nesting is too deep');
			if (node.type === 'text') return node.data;
			if (['script', 'style', 'iframe', 'object', 'img', 'head'].includes(node.name)) return '';
			if (node.name === 'br') return '\n';
			const text = (node.children || []).map(child => render(child, depth + 1)).join('');
			return text + (['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3'].includes(node.name) && !text.endsWith('\n') ? '\n' : '');
		};
		return render(document);
	}
	static xmlSet(source) {
		Support.assert(typeof source === 'string', 'Choose a TypeIt4Me XML set');
		// Recognize the standard plist declaration without resolving its external DTD.
		source = source.replace(/<!DOCTYPE plist PUBLIC "-\/\/Apple(?: Computer)?\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>/g, '');
		Support.assert(!/<!DOCTYPE|<!ENTITY/i.test(source), 'XML declarations with DTDs/entities are not supported');
		let invalid = false;
		const document = new DOMParser({ onError: () => { invalid = true; } }).parseFromString(source, 'application/xml');
		Support.assert(!invalid && document.documentElement, 'Malformed TypeIt4Me XML');
		const children = node => Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
		const decode = (node, depth = 0) => {
			Support.assert(depth < 30, 'XML nesting is too deep');
			if (node.tagName === 'dict') {
				const items = children(node); const result = Object.create(null);
				Support.assert(items.length % 2 === 0, 'Malformed property-list dictionary');
				for (let index = 0; index < items.length; index += 2) { Support.assert(items[index].tagName === 'key', 'Invalid property-list key'); result[items[index].textContent] = decode(items[index + 1], depth + 1); }
				return result;
			}
			if (node.tagName === 'array') return children(node).map(child => decode(child, depth + 1));
			if (node.tagName === 'string') return node.textContent;
			if (node.tagName === 'true' || node.tagName === 'false') return node.tagName === 'true';
			return null;
		};
		const root = document.documentElement;
		if (root.tagName === 'plist') { const nodes = children(root); Support.assert(nodes.length === 1, 'Invalid property list'); return decode(nodes[0]); }
		Support.assert(['typeit4me', 'snippets', 'clippings'].includes(root.tagName.toLowerCase()), 'Unrecognized TypeIt4Me XML layout');
		const records = children(root);
		Support.assert(records.every(node => ['snippet', 'clipping'].includes(node.tagName.toLowerCase())), 'Unrecognized TypeIt4Me record layout');
		return { name: root.getAttribute('name'), snippets: records.map(node => Object.fromEntries(children(node).map(field => [field.tagName, field.textContent]))) };
	}
	static async previewImport(format, body) {
		Support.assert(Object.hasOwn(Libraries.importFormats, format), 'Unknown import format');
		Support.assert(body && Buffer.byteLength(JSON.stringify(body.source) || '') <= 8 * 1048576, 'Import exceeds 8 MiB');
		if (format === 'snippetslab') {
			let source = body.source;
			if (typeof source === 'string') { try { source = JSON.parse(source); } catch { Support.assert(false, 'Invalid SnippetsLab JSON'); } }
			const preview = await Libraries.snippetsLab(source);
			Support.assert(preview.entries.length > 0, 'No snippets found in this export');
			return preview;
		}
		const filename = typeof body.filename === 'string' ? body.filename : Libraries.importFormats[format].name;
		const name = filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').slice(0, 85) || 'Imported snippets';
		let groups;
		if (format === 'yaml') {
			const parsed = await Yaml.run(body.source);
			groups = [{ name, snippets: parsed.matches }];
		} else if (format === 'textexpander') {
			Support.assert(typeof body.source === 'string', 'Choose a CSV export');
			let records;
			try { records = parseCsv(body.source, { bom: true, columns: headers => { Support.assert(new Set(headers).size === headers.length, 'Duplicate CSV headers'); return headers; }, skip_empty_lines: true, max_record_size: 1048576, to: 1001 }); } catch { Support.assert(false, 'Malformed CSV: check quoting and column counts'); }
			Support.assert(records.length > 0 && Object.hasOwn(records[0], 'abbreviation') && Object.hasOwn(records[0], 'snippet'), 'CSV requires abbreviation and snippet headers; label is optional');
			groups = [{ name, snippets: records.map(record => ({ trigger: record.abbreviation, title: record.label || '', text: record.snippet })) }];
		} else {
			let source;
			try { source = format === 'typeit4me' ? Libraries.xmlSet(body.source) : (typeof body.source === 'string' ? JSON.parse(body.source) : body.source); } catch (error) { Support.assert(false, error.status ? error.message : 'Invalid ' + Libraries.importFormats[format].name + ' export'); }
			Support.assert(source && typeof source === 'object', 'Unrecognized export structure');
			if (Array.isArray(source) && source.length && source.every(record => record && typeof record === 'object' && ['text', 'body', 'snippet', 'replace', 'plainText', 'content', 'clip'].some(key => typeof record[key] === 'string'))) source = { name, snippets: source };
			const rows = Array.isArray(source) ? source : source.folders || source.sets;
			if (rows) {
				Support.assert(Array.isArray(rows), 'Invalid folder/set collection');
				groups = []; const queue = rows.map(row => ({ row, path: [], depth: 0 }));
				while (queue.length) {
					const { row, path, depth } = queue.shift();
					Support.assert(row && typeof row === 'object' && depth < 20 && groups.length < 256, 'Invalid or excessive folder hierarchy');
					if (Array.isArray(row.snippets || row.clippings)) {
						const next = [...path, row.name || row.title || name];
						groups.push({ name: next.join(' › '), snippets: row.snippets || row.clippings });
						Support.assert(!row.children || Array.isArray(row.children), 'Invalid child folders');
						queue.push(...(row.children || []).map(child => ({ row: child, path: next, depth: depth + 1 })));
					} else { Support.assert(false, 'Unrecognized folder/set layout: expected a snippets or clippings array'); }
				}
			} else {
				Support.assert(Array.isArray(source.snippets || source.clippings), 'Unrecognized export layout: expected folders, sets, snippets or clippings');
				groups = [{ name: source.name || source.title || name, snippets: source.snippets || source.clippings }];
			}
		}
		const entries = []; const warnings = [];
		Support.assert(groups.length <= 256, 'Import exceeds 256 libraries');
		for (const [groupIndex, group] of groups.entries()) {
			Support.assert(typeof group.name === 'string', 'Invalid library name');
			for (const [index, record] of group.snippets.entries()) {
				Support.assert(entries.length < 1000 && record && typeof record === 'object', 'Invalid record or more than 1000 snippets');
				const original = record.trigger ?? record.shortcut ?? record.abbreviation ?? record.abbr ?? null;
				const entry = { key: groupIndex + ':' + index, folder: String(groupIndex), name: group.name.replaceAll('/', '∕').replaceAll('\\', '∖').slice(0, 85), title: record.title ?? record.name ?? record.label ?? '', original_trigger: original, trigger: Abbreviation.normalize(original) || null, warnings: [] };
				let text = record.text ?? record.body ?? record.snippet ?? record.replace ?? record.plainText ?? record.content ?? record.clip;
				if (record.html && format === 'textblaze') { const rich = RichText.content({ version: 2, type: 'rich_text', markdown: record.html, variables: {} }); text = rich.text; entry.content = rich; entry.warnings.push('Imported HTML as rich text; remote images are cached when the import is committed.'); }
				if (typeof text === 'string' && /^\{\\rtf/i.test(text)) { const rich = RichText.content({ version: 2, type: 'rich_text', markdown: RichText.rtf(text), variables: {} }); text = rich.text; entry.content = rich; entry.warnings.push('Imported RTF as rich text; embedded images are cached when committed.'); }
				if (typeof text !== 'string') { entry.error = 'No readable text found; images/binary content cannot be imported.'; text = ''; }
				const dynamic = format !== 'yaml' && (/\{(?:[a-z][a-z0-9_-]*(?=[:;}])|=)/i.test(text) || /%[A-Za-z]|%\{|[⊢⊣]|\{\{|\$\|\$/.test(text) || /script|macro/i.test(String(record.type || record.kind || '')));
				entry.review = dynamic;
				if (dynamic) { entry.title = (entry.title || original || 'Imported snippet') + ' (Needs review)'; entry.trigger = null; entry.warnings.push('Unsupported commands preserved literally. No abbreviation is assigned.'); }
				entry.content ||= format === 'yaml' ? Libraries.content(record) : { version: 1, type: dynamic ? 'code' : 'plain_text', text: text.replaceAll('\r\n', '\n'), ...(dynamic ? { language: 'plain_text' } : {}) };
				try { await Libraries.validate([{ ...entry, trigger: null }]); } catch (error) { entry.error ||= error.message; }
				if (entry.trigger && (typeof entry.trigger !== 'string' || !/^[a-z0-9-]{1,63}$/.test(entry.trigger))) entry.trigger_error = 'Correct or clear this abbreviation before importing.';
				entries.push(entry);
			}
		}
		Support.assert(entries.length > 0, 'No snippets found; this export layout may not be supported');
		return { entries, warnings };
	}
	static async snippetsLab(source) {
		Support.assert(source && typeof source === 'object' && source.contents && Array.isArray(source.contents.snippets), 'Choose a SnippetsLab JSON library export');
		Support.assert(Buffer.byteLength(JSON.stringify(source)) <= 8 * 1048576, 'Import exceeds 8 MiB');
		Support.assert(!source.contents.folders || Array.isArray(source.contents.folders), 'Invalid folder list');
		const folders = new Map();
		const queue = (source.contents.folders || []).map(folder => ({ folder, path: [], depth: 0 }));
		while (queue.length) {
			const { folder, path, depth } = queue.shift();
			Support.assert(depth < 20 && folders.size < 256 && typeof folder.uuid === 'string' && !folders.has(folder.uuid), 'Invalid or excessive folder hierarchy');
			const next = [...path, typeof folder.title === 'string' && folder.title ? folder.title : 'Untitled'];
			folders.set(folder.uuid, next.join(' › ').replaceAll('/', '∕').replaceAll('\\', '∖').slice(0, 100));
			Support.assert(!folder.children || Array.isArray(folder.children), 'Invalid folder children');
			queue.push(...(folder.children || []).map(child => ({ folder: child, path: next, depth: depth + 1 })));
		}
		const entries = [];
		const warnings = new Set();
		if (source.contents.tags?.length) warnings.add('Tags are not imported.');
		if (source.contents.smartGroups?.length) warnings.add('Smart groups are not imported.');
		if (source.contents.shortcuts?.length) warnings.add('Shortcuts are not imported.');
		for (const [index, snippet] of source.contents.snippets.entries()) {
			Support.assert(Array.isArray(snippet.fragments) && snippet.fragments.length, 'Snippet ' + (index + 1) + ' has no fragments');
			if (snippet.pinned) warnings.add('Pinned status is not imported.');
			if (snippet.tags?.length) warnings.add('Tags are not imported.');
			for (const [fragmentIndex, fragment] of snippet.fragments.entries()) {
				Support.assert(entries.length < 1000, 'Import at most 1000 fragments at a time');
				if (fragment.note || fragment.noteAttributes?.length) warnings.add('Fragment notes and note formatting are not imported.');
				const title = [snippet.title || 'Untitled', snippet.fragments.length > 1 ? fragment.title || 'Fragment ' + (fragmentIndex + 1) : null].filter(Boolean).join(' — ');
				if (snippet.folder && !folders.has(snippet.folder)) warnings.add('Missing folder references are placed in SnippetsLab.');
				const entry = { key: index + ':' + fragmentIndex, folder: snippet.folder || '', name: folders.get(snippet.folder) || 'SnippetsLab', title, trigger: null, content: { version: 1, type: 'code', text: fragment.content, language: fragment.language || 'plain_text' } };
				try { await Libraries.validate([entry]); } catch (error) { entry.error = error.message; }
				entries.push(entry);
			}
		}
		return { entries, warnings: [...warnings] };
	}
	static async importSnippetsLab(ctx, body, session) { return Libraries.commitImport(ctx, 'snippetslab', body, session); }
	static async commitImport(ctx, format, body, session) {
		const preview = await Libraries.previewImport(format, body);
		Support.assert(Array.isArray(body.selected) && body.selected.length > 0 && new Set(body.selected.map(item => item.key)).size === body.selected.length, 'Select valid fragments first');
		const groups = new Map();
		for (const selected of body.selected) {
			const entry = preview.entries.find(entry => entry.key === selected.key);
			Support.assert(entry && !entry.error, 'Selected fragment is invalid');
			const key = entry.folder;
			if (!groups.has(key)) groups.set(key, { name: entry.name, snippets: [] });
			groups.get(key).snippets.push({ ...Libraries.value(entry), trigger: entry.review ? null : Abbreviation.normalize(selected.trigger === undefined ? entry.trigger : selected.trigger) || null });
		}
		const libraries = [];
		const used = new Set((await Library.find({ account: ctx.account, creator: ctx.user }).session(session).select('name').lean()).map(item => item.name));
		for (const group of groups.values()) {
			const base = group.name.slice(0, 85); let name = base; let suffix = 2;
			while (used.has(name)) name = base + ' (' + suffix++ + ')';
			used.add(name);
			libraries.push(await Libraries.create(ctx, { name, snippets: group.snippets }, session));
		}
		await Libraries.validateVisible(ctx, session);
		return { libraries };
	}
	static async create(ctx, body, session) {
		const sourceEntries = body.yaml !== undefined ? (await Yaml.run(body.yaml)).matches : (body.snippets || []);
		const entries=[];for(const entry of sourceEntries)entries.push(await Libraries.prepared(ctx,entry));
		await Libraries.validate(entries, ctx, session);
		await Billing.assertResourceIncrease(ctx, 'libraries', 1, session);
		await Billing.assertResourceIncrease(ctx, 'snippets', entries.length, session);
		const [library] = await Library.create([{ account: ctx.account, creator: ctx.user, name: Support.text(body.name), shared: false, editable: false, members: [], groups: [], revision: 1, state: 'active' }], { session });
		for (const entry of entries) if (entry.id !== undefined) Support.assert(typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(entry.id), 'Invalid snippet ID');
		for (const [position, entry] of entries.entries()) await Snippet.create([{ account: ctx.account, library: library._id, id: entry.id || randomUUID(), ...Libraries.value(entry), position, revision: 1, state: 'active' }], { session });
		await Support.change(ctx.account, library._id, 'library', session);
		return Libraries.view(ctx, await Libraries.hydrate(library.toObject(), session));
	}
	static async receipt(ctx, stored, session) {
		const result = { ...stored };
		if (stored.library_ids) {
			result.libraries = [];
			for (const id of stored.library_ids) {
				const library = await Library.findOne({ _id: id, account: ctx.account }).session(session || null).lean();
				if (library && Support.access(ctx, library).read) result.libraries.push(Libraries.view(ctx, await Libraries.hydrate(library, session)));
			}
		}
		if (stored.library_id) {
			const raw = await Library.findOne({ _id: stored.library_id, account: ctx.account }).session(session).lean();
			if (raw?.state === 'purged') result.purged = [stored.library_id];
			else result.library = Libraries.view(ctx, await Libraries.get(ctx, stored.library_id, session, true));
		}
		return result;
	}
	static async mutate(ctx, operation, body, action) {
		Support.assert(typeof operation === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(operation), 'Stable operation ID required');
		const fingerprint = Support.hash(JSON.stringify(body));
		let result;
		await mongoose.connection.transaction(async session => {
			await Account.updateOne({ _id: ctx.account }, { $inc: { sequence: 1 } }, { session });
			ctx = await Support.context(ctx.user, ctx.account, session);
			const prior = await Operation.findOne({ account: ctx.account, user: ctx.user, operation }).session(session).lean();
			if (prior) {
				Support.assert(prior.fingerprint === fingerprint, 'Operation ID already used with different content', 409);
				result = await Libraries.receipt(ctx, prior.result, session);
				return;
			}
			result = await action(ctx, session);
			const stored = { ...result };
			if (result.library) { stored.library_id = result.library._id; delete stored.library; }
			if (stored.libraries) { stored.library_ids = stored.libraries.map(library => library._id); delete stored.libraries; }
			delete stored.html;
			if (stored.affected) stored.affected = stored.affected.map(({ id, type, library, revision }) => ({ id, type, library, revision }));
			await Operation.create([{ account: ctx.account, user: ctx.user, operation, fingerprint, result: stored }], { session });
		});
		return result;
	}
	static async settings(ctx, id, body, session) {
		const library = await Libraries.get(ctx, id, session);
		Support.assert(Support.access(ctx, library).manage, 'Only creator and account admins manage this library', 403);
		Support.assert(library.revision === body.base_revision, 'Library changed; refresh before saving', 409);
		if (body.deleted === true) return Libraries.trashAction(ctx, { type: 'library', id, library: id, revision: library.revision }, 'trash', session);
		Support.assert(typeof body.shared === 'boolean' && typeof body.editable === 'boolean', 'Sharing and editing must be booleans');
		Support.assert(Array.isArray(body.members) && Array.isArray(body.groups) && body.members.length <= 1000 && body.groups.length <= 1000, 'Invalid grants');
		if (body.shared || body.members.length || body.groups.length) Billing.assertTeam(ctx, 'sharing');
		const members = [...new Set(body.members.map(Support.id))];
		const groups = [...new Set(body.groups.map(Support.id))];
		Support.assert(await Member.countDocuments({ account: ctx.account, user: { $in: members } }).session(session) === members.length, 'Member belongs to another account');
		Support.assert(await Group.countDocuments({ account: ctx.account, _id: { $in: groups } }).session(session) === groups.length, 'Group belongs to another account');
		await Library.updateOne({ _id: library._id }, { $set: { name: Support.text(body.name), shared: body.shared, editable: body.editable, members, groups }, $inc: { revision: 1 } }, { session });
		await Support.change(ctx.account, library._id, 'permissions', session);
		return { library: Libraries.view(ctx, await Libraries.get(ctx, id, session)) };
	}
	static same(a, b) { return a === b || (!!a && !!b && JSON.stringify(Libraries.value(a)) === JSON.stringify(Libraries.value(b))); }
	static async upload(ctx, id, body, session) {
		const before = Billing.enabled() ? await Billing.usage(ctx.account, session) : null;
		const library = await Libraries.get(ctx, id, session, true);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(Number.isInteger(body.base_revision) && body.base_revision >= 1 && body.base_revision <= library.revision, 'Invalid base revision', 409);
		Support.assert(Array.isArray(body.changes) && body.changes.length <= 10000, 'Invalid changes');
		const conflicts = [];
		const seen = new Set();
		for (const change of body.changes) {
			Support.assert(typeof change.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(change.id) && !seen.has(change.id), 'Invalid or repeated snippet ID');
			seen.add(change.id);
			const server = await Snippet.findOne({ account: ctx.account, id: change.id }).session(session).lean();
			Support.assert(!server || Support.equal(server.library, library._id), 'Snippet moved to another library; review your changes', 409);
			Support.assert(server?.state !== 'purged', 'Snippet was permanently purged; it cannot be restored', 410);
			const local = change.value === null ? null : Libraries.value(await Libraries.prepared(ctx,change.value), server?.content);
			if (local) await Libraries.validate([local], ctx, session);
			if (server?.state === 'active' && library.state === 'active' && Libraries.same(server, local)) continue;
			if (server?.state === 'trashed' && local === null) continue;
			if (library.state !== 'active' || server?.state === 'trashed' || (server?.revision ?? null) !== (change.base_revision ?? null)) {
				const [conflict] = await Conflict.create([{ account: ctx.account, library: library._id, user: ctx.user, snippet: change.id, local, base: change.base || null, server: server ? Libraries.entry(server) : null }], { session });
				conflicts.push(String(conflict._id));
				continue;
			}
			if (!server && !local) continue;
			if (local) {
				await Snippet.updateOne({ library: library._id, id: change.id }, { $set: { account: ctx.account, ...local, state: 'active', revision: (server?.revision || 0) + 1 }, ...(!server ? { $setOnInsert: { position: library.records.reduce((maximum, entry) => Math.max(maximum, entry.position ?? -1), -1) + seen.size } } : {}) }, { upsert: !server, session });
			} else {
				const now = new Date();
				await Snippet.updateOne({ _id: server._id }, { $set: Libraries.trashFields(ctx.user, now), $inc: { revision: 1 } }, { session });
			}
		}
		await Libraries.validate(await Snippet.find({ library: library._id, state: 'active' }).session(session).lean(), ctx, session);
		if (before) {
			const after = await Billing.usage(ctx.account, session);
			Billing.assertLimit(ctx, 'snippets', before.snippets, Math.max(0, after.snippets - before.snippets));
		}
		await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
		await Support.change(ctx.account, library._id, 'snippets', session);
		return { library: Libraries.view(ctx, await Libraries.get(ctx, id, session, true)), conflicts };
	}
	static async batch(ctx, body, session) {
		Support.assert(['move', 'trash'].includes(body.action) && Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 10000, 'Invalid bulk action');
		const source = await Libraries.get(ctx, body.source_library, session);
		Support.assert(Support.access(ctx, source).edit, 'Source library is read-only', 403);
		const destination = body.action === 'move' ? await Libraries.get(ctx, body.destination_library, session) : source;
		Support.assert(Support.access(ctx, destination).edit, 'Destination library is read-only', 403);
		Support.assert(body.action !== 'move' || !Support.equal(source._id, destination._id), 'Choose another library');
		const ids = body.items.map(item => item.id);
		Support.assert(new Set(ids).size === ids.length, 'Repeated snippet selection');
		const selected = source.snippets.filter(entry => ids.includes(entry.id));
		Support.assert(selected.length === ids.length, 'Selection changed; select the snippets again', 409);
		for (const record of selected) {
			const item = body.items.find(item => item.id === record.id);
			Support.assert(item.base_revision === record.revision, 'A selected snippet changed; review the selection', 409);
			Support.assert(item.value === undefined || (body.action === 'move' && selected.length === 1), 'Edits are supported only for a single-snippet move');
		}
		if (body.action === 'trash') {
			await Snippet.updateMany({ account: ctx.account, library: source._id, id: { $in: ids }, state: 'active' }, { $set: Libraries.trashFields(ctx.user), $inc: { revision: 1 } }, { session });
			await Library.updateOne({ _id: source._id }, { $inc: { revision: 1 } }, { session });
			await Support.change(ctx.account, source._id, 'trash', session);
		} else {
			const last = await Snippet.findOne({ library: destination._id }).sort({ position: -1 }).session(session).lean();
			let position = (last?.position ?? -1) + 1;
			for (const record of selected) {
				const item = body.items.find(item => item.id === record.id);
				const change = item.value === undefined ? {} : Libraries.value(await Libraries.prepared(ctx,item.value), record.content);
				await Snippet.updateOne({ _id: record._id }, { $set: { library: destination._id, position: position++, ...change }, $inc: { revision: 1 } }, { session });
				await Conflict.updateMany({ account: ctx.account, library: source._id, snippet: record.id }, { $set: { library: destination._id } }, { session });
			}
			const entries = await Snippet.find({ library: destination._id, state: 'active' }).session(session).lean();
			await Libraries.validate(entries, ctx, session);
			Support.assert(Buffer.byteLength(JSON.stringify(entries)) <= 1048576, 'Destination exceeds the library size limit');
			for (const library of [source, destination]) {
				await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
				const sequence = await Support.change(ctx.account, library._id, 'move', session);
				if (Support.equal(library._id, source._id)) await Change.updateOne({ account: ctx.account, sequence }, { $set: { departures: ids } }, { session });
			}
		}
		const changed = body.action === 'move' ? [source, destination] : [source];
		return { libraries: await Promise.all(changed.map(async library => Libraries.view(ctx, await Libraries.get(ctx, String(library._id), session)))), moved: body.action === 'move' ? ids : [], trashed: body.action === 'trash' ? ids : [] };
	}
	static async trash(ctx, session) {
		const rows = [];
		const now = new Date();
		const libraries = await Library.find({ account: ctx.account, state: { $ne: 'purged' } }).session(session || null).lean();
		for (const library of libraries) {
			const access = Support.access(ctx, library);
			if (!access.read) continue;
			if (library.state === 'trashed' && library.expires_at > now && access.manage) rows.push({ type: 'library', id: String(library._id), library: String(library._id), name: library.name, revision: library.revision, expires_at: library.expires_at, can_restore: true, can_purge: true });
			if (library.state !== 'active' || !access.edit) continue;
			for (const entry of await Snippet.find({ library: library._id, state: 'trashed', expires_at: { $gt: now } }).session(session || null).lean()) rows.push({ type: 'snippet', id: entry.id, library: String(library._id), name: entry.title || entry.trigger || 'Untitled snippet', library_name: library.name, revision: entry.revision, expires_at: entry.expires_at, can_restore: true, can_purge: access.manage });
		}
		return rows;
	}
	static async validateVisible(ctx, session) {
		const libraries = await Libraries.list(ctx, session);
		Support.assert(libraries.length <= 256, 'Active libraries exceed the engine limit', 409);
		const entries = libraries.flatMap(library => library.snippets);
		await Libraries.validate(entries, ctx, session);
		Support.assert(Buffer.byteLength(JSON.stringify(entries)) <= 8 * 1048576, 'Active snippets exceed the engine limit', 409);
		for (const library of libraries) Support.assert(Buffer.byteLength(JSON.stringify(library.snippets)) <= 1048576, 'Library exceeds the engine limit', 409);
	}
	static async purge(library, entry, session) {
		const filter = entry ? { library: library._id, id: entry.id } : { library: library._id };
		const ids = (await Snippet.find(filter).select('id').session(session).lean()).map(row => row.id);
		await Snippet.updateMany(filter, { $set: { state: 'purged' }, $inc: { revision: 1 }, $unset: { title: 1, trigger: 1, content: 1, position: 1, trashed_by: 1, trashed_at: 1, expires_at: 1 } }, { session });
		await Conflict.deleteMany({ library: library._id, ...(entry ? { snippet: { $in: ids } } : {}) }, { session });
		if (!entry) {
			const readers = [];
			for (const member of await Member.find({ account: library.account }).session(session).lean()) if (Support.access(await Support.context(String(member.user), String(library.account), session), library).read) readers.push(member.user);
			await Library.updateOne({ _id: library._id }, { $set: { state: 'purged', purge_readers: readers }, $unset: { name: 1, members: 1, groups: 1, shared: 1, editable: 1, creator: 1, trashed_at: 1, trashed_by: 1, expires_at: 1 } }, { session });
		}
		await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
		await Support.change(library.account, library._id, 'purge', session);
	}
	static async trashAction(ctx, target, action, session) {
		Support.assert(['library', 'snippet'].includes(target.type) && ['trash', 'restore', 'purge'].includes(action), 'Invalid Trash action');
		const library = await Libraries.get(ctx, target.library, session, true);
		const access = Support.access(ctx, library);
		Support.assert((target.type === 'library' || action === 'purge') ? access.manage : access.edit, 'Not permitted to change this Trash item', 403);
		const record = target.type === 'library' ? library : await Snippet.findOne({ library: library._id, id: target.id }).session(session).lean();
		Support.assert(record && record.state !== 'purged', 'Item permanently removed', 410);
		Support.assert(record.revision === target.revision, 'Item changed; review Trash again', 409);
		Support.assert(action === 'trash' ? record.state === 'active' : record.state === 'trashed', 'Item is no longer in the expected state', 409);
		if (action === 'restore') {
			Support.assert(record.expires_at > new Date(), 'Trash retention expired', 410);
			Support.assert(target.type === 'library' || library.state === 'active', 'Restore the library first', 409);
			await Billing.assertResourceIncrease(ctx, target.type === 'library' ? 'libraries' : 'snippets', 1, session);
			if (target.type === 'library') await Billing.assertResourceIncrease(ctx, 'snippets', library.snippets.length, session);
		}
		if (action === 'purge') await Libraries.purge(library, target.type === 'snippet' ? record : null, session);
		else {
			const model = target.type === 'library' ? Library : Snippet;
			const now = new Date();
			await model.updateOne({ _id: record._id }, { $set: { state: action === 'trash' ? 'trashed' : 'active', ...(action === 'trash' ? { trashed_at: now, expires_at: new Date(+now + Libraries.retention), trashed_by: ctx.user } : {}) }, ...(action === 'restore' ? { $unset: { trashed_at: 1, expires_at: 1, trashed_by: 1 } } : {}), $inc: { revision: 1 } }, { session });
			if (target.type === 'snippet') await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
			if (action === 'restore') await Libraries.validateVisible(ctx, session);
			await Support.change(ctx.account, library._id, action, session);
		}
		const current = await Library.findById(library._id).session(session).lean();
		return { ...(current.state === 'purged' ? { purged: [String(library._id)] } : { library: Libraries.view(ctx, await Libraries.hydrate(current, session)) }), affected: [target] };
	}
	static async empty(ctx, targets, session) {
		Support.assert(Array.isArray(targets) && targets.length <= 10000, 'Invalid Trash selection');
		const affected = [];
		for (const target of targets) {
			await Libraries.trashAction(ctx, target, 'purge', session);
			affected.push(target);
		}
		return { affected };
	}
	static async cleanup() {
		const summary = { libraries: 0, snippets: 0 };
		for (const account of await Account.find(AccountAccess.available).select('_id').lean()) {
			const purged = await mongoose.connection.transaction(async session => {
				const locked = await Account.updateOne({ _id: account._id, ...AccountAccess.available }, { $inc: { sequence: 1 } }, { session });
				if (!locked.matchedCount) return { libraries: 0, snippets: 0 };
				const now = new Date();
				const libraries = await Library.find({ account: account._id, state: 'trashed', expires_at: { $lte: now } }).session(session).lean();
				for (const library of libraries) await Libraries.purge(library, null, session);
				let snippets = 0;
				for (const entry of await Snippet.find({ account: account._id, state: 'trashed', expires_at: { $lte: now } }).session(session).lean()) {
					const library = await Library.findById(entry.library).session(session).lean();
					if (library && library.state !== 'purged') {
						await Libraries.purge(library, entry, session);
						snippets++;
					}
				}
				const referenced=new Set();const collect=value=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)collect(item);return;}if(value.type==='rich_text'&&Array.isArray(value.assets))for(const id of value.assets)referenced.add(id);for(const item of Object.values(value))collect(item);};for(const record of await Snippet.find({account:account._id,state:{$ne:'purged'}}).select('content').session(session).lean())collect(record.content);for(const conflict of await Conflict.find({account:account._id,resolved:false}).select('local base server').session(session).lean())collect(conflict);await SnippetAsset.deleteMany({account:account._id,id:{$nin:[...referenced]},updatedAt:{$lte:new Date(+now-Libraries.retention)}}).session(session);
				return { libraries: libraries.length, snippets };
			});
			summary.libraries += purged.libraries;
			summary.snippets += purged.snippets;
		}
		return summary;
	}
	static async download(ctx, cursor) {
		Support.assert(Number.isSafeInteger(cursor) && cursor >= 0, 'Invalid cursor');
		let result;
		await mongoose.connection.transaction(async session => {
			ctx = await Support.context(ctx.user, ctx.account, session);
			const account = await Account.findById(ctx.account).session(session).lean();
			const changes = await Change.find({ account: ctx.account, sequence: { $gt: cursor, $lte: account.sequence } }).session(session).lean();
			const all = await Library.find({ account: ctx.account, state: { $ne: 'purged' } }).session(session).lean();
			const visible = all.filter(library => Support.access(ctx, library).read);
			const changed = new Set(changes.map(change => String(change.library)));
			const permissions = changes.some(change => change.kind === 'membership');
			const libraries = await Promise.all(visible.filter(library => cursor === 0 || permissions || changed.has(String(library._id))).map(async library => Libraries.view(ctx, await Libraries.hydrate(library, session))));
			const tombstones = await Snippet.find({ account: ctx.account, library: { $in: visible.map(row => row._id) }, state: 'purged' }).select('library id revision state').session(session).lean();
			const conflicts = await Conflict.find({ account: ctx.account, resolved: false, library: { $in: visible.filter(library => Support.access(ctx, library).edit).map(library => library._id) } }).session(session).lean();
			const purged = (await Library.find({ account: ctx.account, state: 'purged', purge_readers: ctx.user }).select('_id').session(session).lean()).map(row => String(row._id));
			const visibleIds = new Set(visible.map(library => String(library._id)));
			const candidates = changes.filter(change => visibleIds.has(String(change.library))).flatMap(change => (change.departures || []).map(id => ({ library: String(change.library), id })));
			const locations = new Map((await Snippet.find({ account: ctx.account, id: { $in: [...new Set(candidates.map(item => item.id))] } }).select('id library').session(session).lean()).map(record => [record.id, String(record.library)]));
			const departures = [...new Map(candidates.filter(item => locations.has(item.id) && locations.get(item.id) !== item.library).map(item => [item.library + ':' + item.id, item])).values()];
			const assetIds = [...new Set([...libraries.flatMap(library => library.records || []).flatMap(record => record.content?.type === 'rich_text' ? record.content.assets : []), ...conflicts.flatMap(conflict => [conflict.local, conflict.base, conflict.server].flatMap(value => value?.content?.type === 'rich_text' ? value.content.assets : []))])];
			const assets = assetIds.length ? await SnippetAsset.find({ account: ctx.account, id: { $in: assetIds } }).select('id mime_type size width height animated source_urls').session(session).lean() : [];
			result = { protocol: 6, departures, purged, cursor: account.sequence, accessible: visible.map(library => String(library._id)), libraries, assets, tombstones, conflicts, trash: await Libraries.trash(ctx, session) };
		}, { readConcern: { level: 'snapshot' } });
		return result;
	}
	static async resolve(ctx, id, body, session) {
		const conflict = await Conflict.findOne({ _id: Support.id(id), account: ctx.account, resolved: false }).session(session).lean();
		Support.assert(conflict, 'Conflict no longer exists', 404);
		const library = await Libraries.get(ctx, String(conflict.library), session, true);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(body.base_revision === library.revision, 'Library changed; review latest version', 409);
		Support.assert(['local', 'server', 'merged'].includes(body.choice), 'Choose a resolution');
		let result = { library: Libraries.view(ctx, library) };
		if (body.choice !== 'server') {
			Support.assert(library.state === 'active', 'Restore the library before resolving this edit', 409);
			let current = await Snippet.findOne({ library: library._id, id: conflict.snippet }).session(session).lean();
			Support.assert(current?.state !== 'purged', 'Snippet permanently removed', 410);
			const value = body.choice === 'local' ? conflict.local : body.value;
			if (current?.state === 'trashed' && value) {
				await Libraries.trashAction(ctx, { type: 'snippet', id: current.id, library: String(library._id), revision: current.revision }, 'restore', session);
				current = await Snippet.findById(current._id).session(session).lean();
			}
			const fresh = await Library.findById(library._id).session(session).lean();
			result = await Libraries.upload(ctx, String(library._id), { base_revision: fresh.revision, changes: [{ id: conflict.snippet, base_revision: current?.revision ?? null, value }] }, session);
		}
		await Conflict.updateOne({ _id: conflict._id }, { $set: { resolved: true } }, { session });
		return { ...result, resolved: id };
	}
}
