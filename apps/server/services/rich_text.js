import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Parser } from 'htmlparser2';
import { Assets } from './assets.js';
import { Support } from './support.js';

export class RichText {
	static instance;
	static wasmPath() {
		const local = fileURLToPath(new URL('../../../target/wasm32-unknown-unknown/debug/typerelay_template_wasm.wasm', import.meta.url));
		return process.env.TYPERELAY_WASM || (existsSync('/data/editor/template.wasm') ? '/data/editor/template.wasm' : local);
	}
	static load() {
		if (!RichText.instance) RichText.instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(RichText.wasmPath())), {}).exports;
		return RichText.instance;
	}
	static render(input) { return RichText.call('rich_text_render', { markdown: input.markdown || '', variables: input.variables || {}, values: input.values || {}, assets: Array.isArray(input.assets) ? {} : (input.assets || {}), now_ms: input.now_ms ?? Date.now(), offset_minutes: input.offset_minutes ?? 0, preview: input.preview ?? true }); }
	static call(name, input) {
		const wasm = RichText.load();
		const bytes = new TextEncoder().encode(JSON.stringify(input));
		const pointer = wasm.template_alloc(bytes.length);
		new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
		let output;
		try {
			const packed = wasm[name](pointer, bytes.length);
			const address = Number(packed >> 32n); const length = Number(packed & 0xffffffffn);
			try { output = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, address, length))); }
			finally { wasm.template_free(address, length); }
		} finally { wasm.template_free(pointer, bytes.length); }
		if (output.error) throw new Error(output.error);
		return output;
	}
	static content(content) {
		const result = RichText.render({ markdown: content.markdown, variables: content.variables || {} });
		return { version: 2, type: 'rich_text', markdown: result.markdown, text: result.text, assets: result.assets, variables: result.variables };
	}
	static async prepare(ctx, content, session = null, budget = Assets.budget()) {
		if (content?.version !== 2 || content?.type !== 'rich_text') return content;
		const markdown = String(content.markdown || ''); const parts = []; const sources = new Map();
		for (const part of RichText.call('rich_text_images', markdown)) { const previous = parts.at(-1); if (previous && part.block != null && previous.block === part.block) { previous.end = part.end; previous.html += part.html; previous.pieces.push(part); } else parts.push({ ...part, pieces: [part] }); }
		const input = Buffer.from(markdown);
		// Parsed HTML omits Markdown container prefixes; map each line back to the original source.
		const sourcePosition = (part, index) => { let offset = 0; for (const piece of part.pieces) { if (index < offset + piece.html.length) { const before = piece.html.slice(0, index - offset).split('\n'); const line = before.length - 1; const logical = piece.html.split('\n')[line].replace(/\r$/, ''); const raw = input.subarray(piece.start, piece.end).toString().split('\n'); const physical = raw[line].replace(/\r$/, ''); Support.assert(physical.endsWith(logical), 'Invalid image source position', 422); return piece.start + Buffer.byteLength(raw.slice(0, line).map(value => value + '\n').join('') + physical.slice(0, physical.length - logical.length + before.at(-1).length)); } offset += piece.html.length; } throw new Error('Invalid image source position'); };
		for (const part of parts) {
			part.images = [];
			const parser = new Parser({ onopentag: (name, attributes) => {
				const source = attributes.src;
				if (name !== 'img' || !source) return;
				let url; try { url = new URL(source.trim().startsWith('//') ? 'https:' + source.trim() : source); } catch {}
				const remote = ['http:', 'https:'].includes(url?.protocol) ? url.href : null;
				if (!remote && !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(source.trim())) return;
				part.images.push({ start: part.label !== undefined ? part.start : sourcePosition(part, parser.startIndex), end: part.label !== undefined ? part.end : sourcePosition(part, parser.endIndex) + 1, attributes, source }); sources.set(source, remote);
			} }, { decodeEntities: true });
			parser.end(part.html);
		}
		Support.assert(!session || !sources.size, 'Prepare snippet images before starting the transaction', 422);
		Support.assert([...sources.values()].filter(Boolean).length <= 16, 'Rich text supports at most 16 remote images', 422);
		const cached = new Map();
		for (const [source, remote] of sources) {
			const key = remote || source; let asset = budget.assets.get(key);
			if (!asset) {
				Support.assert(Date.now() < budget.deadline, 'Fetching images took too long; import fewer images at a time', 422);
				if (remote) { Support.assert(++budget.remote <= Assets.maximumRemote, `A request can fetch at most ${Assets.maximumRemote} different remote images`, 422); asset = await Assets.remote(ctx, remote, session, budget.deadline); }
				else { Support.assert(++budget.embedded <= Assets.maximumEmbedded, `A request can embed at most ${Assets.maximumEmbedded} different images`, 422); const bytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64'); Support.assert(bytes.length <= Assets.maximumInput, 'Embedded image exceeds 5 MiB', 413); asset = await Assets.put(ctx, bytes, '', session); }
				budget.assets.set(key, asset);
			}
			cached.set(source, `typerelay-asset:${asset.id}`);
		}
		const edits = [];
		for (const part of parts) {
			if (!part.images.length) continue;
			if (part.label !== undefined) { const image = part.images[0]; const title = image.attributes.title; const value = `![${part.label}](${cached.get(image.source)}${part.title ? ' ' + part.title : title ? ' "' + title.replaceAll('&', '&amp;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"' : ''})`; edits.push({ start: part.start, end: part.end, value }); }
			else for (const image of part.images) { const attributes = { ...image.attributes, src: cached.get(image.source) }; const value = '<img' + Object.entries(attributes).map(([key, value]) => ` ${key}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"`).join('') + '>'; edits.push({ start: image.start, end: image.end, value }); }
		}
		const output = []; let position = 0;
		for (const edit of edits.sort((a, b) => a.start - b.start)) { output.push(input.subarray(position, edit.start), Buffer.from(edit.value)); position = edit.end; }
		output.push(input.subarray(position));
		return { ...content, markdown: Buffer.concat(output).toString() };
	}
	static async styled(value) {
		let bytes;
		if (typeof value === 'string') bytes = Buffer.from(value);
		else {
			Support.assert(typeof value?.base64 === 'string', 'Expected RTF or RTFD data');
			const encoded = value.base64.replace(/\s/g, '');
			Support.assert(encoded.length > 0 && encoded.length <= 12 * 1048576 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'Invalid base64 styled data');
			bytes = Buffer.from(encoded, 'base64');
			Support.assert(bytes.toString('base64') === encoded, 'Invalid base64 styled data');
		}
		Support.assert(bytes.length > 0 && bytes.length <= 8 * 1048576, 'Styled content exceeds 8 MiB');
		const files = new Map(); const warnings = []; const images = []; const used = new Set();
		if (bytes.subarray(0, 4).toString() === 'rtfd') {
			let offset = 4;
			const integer = () => { Support.assert(offset + 4 <= bytes.length, 'Truncated RTFD container'); const value = bytes.readUInt32LE(offset); offset += 4; return value; };
			Support.assert(integer() === 0 && integer() === 3, 'Unsupported RTFD container version');
			const count = integer(); const names = [];
			Support.assert(count > 0 && count <= 256, 'Invalid RTFD file count');
			for (let index = 0; index < count; index++) {
				const size = integer();
				Support.assert(size > 0 && size <= 1024 && offset + size <= bytes.length, 'Invalid RTFD filename length');
				const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size)); offset += size;
				Support.assert(!names.includes(name) && !/[\\/\x00-\x1f]/.test(name) && name !== '..', 'Invalid or duplicate RTFD filename');
				names.push(name);
			}
			const sizes = names.map(() => integer());
			for (const [index, name] of names.entries()) {
				const end = offset + sizes[index];
				Support.assert(sizes[index] >= 8 && end <= bytes.length && integer() === 1, 'Invalid RTFD file block');
				const size = integer();
				Support.assert(size === end - offset, 'Invalid RTFD data length');
				if (name !== '.') files.set(name, bytes.subarray(offset, end));
				offset = end;
			}
			Support.assert(offset === bytes.length && files.has('TXT.rtf'), 'RTFD must contain TXT.rtf with no trailing data');
			bytes = files.get('TXT.rtf');
		}
		let source = typeof value === 'string' ? value : new TextDecoder('windows-1252').decode(bytes);
		Support.assert(/^\{\\rtf/i.test(source), 'Unsupported styled content; expected RTF or RTFD');
		// Apple emits each attachment as a NeXTGraphic group followed by a replacement byte.
		for (const match of [...source.matchAll(/\{\\NeXTGraphic\s+((?:\\[{}]|[^{}])*)\}[\xac\ufffc]?/g)]) {
			const name = match[1].split(/\\(?:width|height|apple)\b|\\(?:width|height|apple)[a-z\d-]/)[0].trim().replace(/\\u(-?\d+)\?? ?/g, (_, number) => String.fromCharCode(Number(number) & 65535)).replace(/\\'([a-f0-9]{2})/gi, (_, hex) => new TextDecoder('windows-1252').decode(Buffer.from(hex, 'hex'))).replace(/\\([{}\\])/g, '$1');
			const data = files.get(name); used.add(name);
			let replacement = '';
			if (!data) warnings.push('Missing RTFD attachment omitted: ' + name);
			else {
				try { const asset = await Assets.normalize(data); replacement = 'TYPERELAYATTACHMENT' + images.length + 'TOKEN'; images.push(`<img src="data:${asset.mime_type};base64,${asset.data.toString('base64')}">`); }
				catch (error) { warnings.push('Attachment omitted: ' + name + ' (' + error.message + ').'); }
			}
			Support.assert(images.reduce((total, image) => total + image.length, 0) <= 8 * 1048576, 'Styled images exceed 8 MiB');
				source = source.replace(match[0], '{' + replacement + '}');
		}
		for (const name of files.keys()) if (name !== 'TXT.rtf' && !used.has(name)) warnings.push('Unreferenced attachment omitted: ' + name);
		if (/\{\\pict\b(?![^{}]*\\(?:pngblip|jpegblip)\b)/i.test(source)) warnings.push('Unsupported RTF picture format omitted; PNG and JPEG pictures are supported.');
		let html = RichText.rtf(source);
		for (const match of [...html.matchAll(/<img src="data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)">/g)]) {
			try { const asset = await Assets.normalize(Buffer.from(match[1], 'base64')); html = html.replace(match[0], `<img src="data:${asset.mime_type};base64,${asset.data.toString('base64')}">`); }
			catch (error) { warnings.push('RTF picture omitted: ' + error.message); html = html.replace(match[0], ''); }
		}
		for (const [index, image] of images.entries()) html = html.replace('TYPERELAYATTACHMENT' + index + 'TOKEN', image);
		Support.assert(Buffer.byteLength(html) <= 8 * 1048576, 'Styled content exceeds 8 MiB');
		warnings.push('Imported supported rich-text formatting and images. Fonts, colors and advanced layout are not preserved.');
		return { html, warnings };
	}
	static rtf(source) {
		Support.assert(typeof source === 'string' && source.length <= 8 * 1048576 && /^\{\\rtf/i.test(source), 'Invalid RTF content', 422);
		const images = []; source = source.replace(/\{\\pict\b([^{}]+)\}/gis, (group, body) => { const mime = /\\pngblip/i.test(body) ? 'image/png' : /\\jpegblip/i.test(body) ? 'image/jpeg' : ''; if (!mime) return ''; const hex = body.replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[^a-f0-9]/gi, ''); if (!hex || hex.length % 2) return ''; const marker = `TYRELAYRTFIMAGE${images.length}TOKEN`; images.push(`<img src="data:${mime};base64,${Buffer.from(hex, 'hex').toString('base64')}">`); return '{' + marker + '}'; });
		const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); const decoder = new TextDecoder('windows-1252');

		const base = { bold: false, italic: false, underline: false, strike: false, skip: false, unicodeFallback: 1 }; const stack = []; let state = { ...base }; let open = { ...base }; let html = '<p>'; let index = 0; let skipFallback = 0;
		const tags = [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's']];
		const sync = (close = false) => {
			if (!close && tags.every(([key]) => open[key] === state[key])) return;
			for (const [key, tag] of [...tags].reverse()) if (open[key]) html += '</' + tag + '>';
			open = { ...base };
			if (!close) for (const [key, tag] of tags) if (state[key]) { html += '<' + tag + '>'; open[key] = true; }
		};
		const append = value => { if (skipFallback) { skipFallback--; return; } if (!state.skip) { sync(); html += escape(value); } };
		while (index < source.length) {
			const character = source[index++];
			if (character === '{') { Support.assert(stack.length < 100, 'RTF nesting is too deep'); stack.push(state); state = { ...state }; skipFallback = 0; continue; }
			if (character === '}') { Support.assert(stack.length > 0, 'Malformed RTF groups'); state = stack.pop(); skipFallback = 0; continue; }
			if (character !== '\\') { if (character !== '\r' && character !== '\n') append(character); continue; }
			const escaped = source[index];
			if (escaped === '*') { index++; state.skip = true; continue; }
			if (escaped === '\n' || escaped === '\r') { index++; if (escaped === '\r' && source[index] === '\n') index++; if (!state.skip) { sync(); html += '<br>'; } continue; }
			if (['\\', '{', '}'].includes(escaped)) { index++; append(escaped); continue; }
			if (escaped === "'") { const hex = source.slice(index + 1, index + 3); Support.assert(/^[a-f0-9]{2}$/i.test(hex), 'Invalid RTF hex escape'); index += 3; append(decoder.decode(Buffer.from(hex, 'hex'))); continue; }
			if (['~', '_', '-'].includes(escaped)) { index++; append(({ '~': '\u00a0', '_': '\u2011', '-': '\u00ad' })[escaped]); continue; }
			const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(index));
			if (!match) continue;
			index += match[0].length;
			const word = match[1].toLowerCase(); const number = match[2] === undefined ? null : Number(match[2]);
			if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'object'].includes(word)) state.skip = true;
			else if (word === 'b') state.bold = number !== 0;
			else if (word === 'i') state.italic = number !== 0;
			else if (word === 'ul') state.underline = number !== 0;
			else if (word === 'ulnone') state.underline = false;
			else if (word === 'strike') state.strike = number !== 0;
			else if (word === 'plain') { for (const [key] of tags) state[key] = false; }
			else if (word === 'par') { if (!state.skip) { sync(true); html += '</p><p>'; } }
			else if (word === 'line') { if (!state.skip) { sync(); html += '<br>'; } }
			else if (word === 'tab') append('\t');
			else if (word === 'bin') Support.assert(false, 'Binary RTF payloads are not supported');
			else if (word === 'uc' && number !== null) { Support.assert(number >= 0 && number <= 16, 'Invalid RTF Unicode fallback'); state.unicodeFallback = number; }
			else if (word === 'u' && number !== null) { skipFallback = 0; append(String.fromCharCode(number & 65535)); skipFallback = state.unicodeFallback; }
		}
		Support.assert(stack.length === 0, 'Malformed RTF groups');
		sync(true); html += '</p>';
		for (const [image, value] of images.entries()) html = html.replace(`TYRELAYRTFIMAGE${image}TOKEN`, value);
		return html;
	}
}
