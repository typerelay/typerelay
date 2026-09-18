import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
	static render(input) {
		const wasm = RichText.load();
		const request = { markdown: input.markdown || '', variables: input.variables || {}, values: input.values || {}, assets: Array.isArray(input.assets) ? {} : (input.assets || {}), now_ms: input.now_ms ?? Date.now(), offset_minutes: input.offset_minutes ?? 0, preview: input.preview ?? true };
		const bytes = new TextEncoder().encode(JSON.stringify(request));
		const pointer = wasm.template_alloc(bytes.length);
		new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
		let output;
		try {
			const packed = wasm.rich_text_render(pointer, bytes.length);
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
	static async prepare(ctx, content) {
		if (content?.version !== 2 || content?.type !== 'rich_text') return content;
		let markdown = String(content.markdown || '');
		const matches = [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi)];
		const urls = [...new Set(matches.map(match => match[1] || match[2]))];
		Support.assert(urls.length <= 16, 'Rich text supports at most 16 remote images', 422);
		for (const url of urls) { const asset = await Assets.remote(ctx, url); markdown = markdown.split(url).join(`typerelay-asset:${asset.id}`); }
		for (const match of [...markdown.matchAll(/data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)/g)]) { const bytes = Buffer.from(match[2], 'base64'); Support.assert(bytes.length <= Assets.maximumInput, 'Embedded image exceeds 5 MiB', 413); const asset = await Assets.put(ctx, bytes); markdown = markdown.split(match[0]).join(`typerelay-asset:${asset.id}`); }
		return { ...content, markdown };
	}
	static rtf(source) {
		Support.assert(typeof source === 'string' && source.length <= 8 * 1048576 && /^\{\\rtf/i.test(source), 'Invalid RTF content', 422);
		const images = []; source = source.replace(/\{\\pict\b([^{}]+)\}/gis, (group, body) => { const mime = /\\pngblip/i.test(body) ? 'image/png' : /\\jpegblip/i.test(body) ? 'image/jpeg' : ''; if (!mime) return ''; const hex = body.replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[^a-f0-9]/gi, ''); if (!hex || hex.length % 2) return ''; const marker = `TYRELAYRTFIMAGE${images.length}TOKEN`; images.push(`<img src="data:${mime};base64,${Buffer.from(hex, 'hex').toString('base64')}">`); return marker; });
		const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); const decoder = new TextDecoder('windows-1252');
		const base = { bold: false, italic: false, underline: false, strike: false, skip: false }; const stack = [base]; let state = base; let open = { ...base }; let html = '<p>'; let index = 0; let skipFallback = false;
		const sync = () => { for (const [key, tag] of [['strike', 's'], ['underline', 'u'], ['italic', 'em'], ['bold', 'strong']]) if (open[key] && !state[key]) { html += `</${tag}>`; open[key] = false; } for (const [key, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's']]) if (state[key] && !open[key]) { html += `<${tag}>`; open[key] = true; } };
		while (index < source.length) { const character = source[index++]; if (character === '{') { stack.push({ ...state }); continue; } if (character === '}') { state = stack.pop() || base; sync(); continue; } if (character === '\\') { const escaped = source[index]; if (['\\', '{', '}'].includes(escaped)) { index++; if (!state.skip) { sync(); html += escape(escaped); } continue; } if (escaped === "'") { const hex = source.slice(index + 1, index + 3); index += 3; if (!state.skip) { sync(); html += escape(decoder.decode(Uint8Array.from([Number.parseInt(hex, 16)]))); } continue; } const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(index)); if (!match) continue; index += match[0].length; const word = match[1].toLowerCase(); const number = match[2] === undefined ? null : Number(match[2]); if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'object'].includes(word) || word === '*') state.skip = true; else if (word === 'b') state.bold = number !== 0; else if (word === 'i') state.italic = number !== 0; else if (word === 'ul') state.underline = number !== 0; else if (word === 'ulnone') state.underline = false; else if (word === 'strike') state.strike = number !== 0; else if (word === 'par') { if (!state.skip) { sync(); html += '</p><p>'; } } else if (word === 'line') { if (!state.skip) html += '<br>'; } else if (word === 'tab') { if (!state.skip) html += '\t'; } else if (word === 'u' && number !== null) { if (!state.skip) { sync(); html += escape(String.fromCharCode(number < 0 ? number + 65536 : number)); } skipFallback = true; } continue; } if (skipFallback) { skipFallback = false; continue; } if (!state.skip && character !== '\r' && character !== '\n') { sync(); html += escape(character); } }
		state = base; sync(); html += '</p>'; for (const [image, value] of images.entries()) html = html.replace(`TYRELAYRTFIMAGE${image}TOKEN`, value); return html;
	}
}
