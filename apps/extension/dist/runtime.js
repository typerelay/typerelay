let module;

async function call(name, value) {
	module ||= WebAssembly.instantiateStreaming(fetch(chrome.runtime.getURL('template.wasm')), {}).then(result => result.instance.exports);
	const wasm = await module;
	const input = new TextEncoder().encode(JSON.stringify(value));
	const pointer = wasm.template_alloc(input.length);
	new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
	let output;
	try {
		const packed = wasm[name](pointer, input.length);
		const address = Number(packed >> 32n);
		const length = Number(packed & 0xffffffffn);
		try { output = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, address, length))); }
		finally { wasm.template_free(address, length); }
	} finally { wasm.template_free(pointer, input.length); }
	if (output?.error) throw new Error(output.error);
	return output;
}

export class Runtime {
	static match(before, prefix, triggers) { return call('abbreviation_match', { before: before.slice(-128), prefix, triggers }); }
	static template(content, values, preview) { const now = new Date(); return call('template_render', { template: { text: content.text, variables: content.variables || {} }, values, preview, now_ms: now.getTime(), offset_minutes: -now.getTimezoneOffset() }); }
	static rich(content, values, preview, assets) { const now = new Date(); return call('rich_text_render', { markdown: content.markdown, variables: content.variables || {}, values, preview, assets, now_ms: now.getTime(), offset_minutes: -now.getTimezoneOffset() }); }
}
