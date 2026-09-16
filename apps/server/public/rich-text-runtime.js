export class RichTextRuntime {
	static module;
	static async render(content, values = {}, preview = false, now = new Date(), assets = {}) {
		RichTextRuntime.module ||= WebAssembly.instantiateStreaming(fetch('/assets/generated/template.wasm'), {}).then(result => result.instance.exports);
		const wasm = await RichTextRuntime.module;
		const input = new TextEncoder().encode(JSON.stringify({ markdown: content.markdown || '', variables: content.variables || {}, values, assets, preview, now_ms: now.getTime(), offset_minutes: -now.getTimezoneOffset() }));
		const pointer = wasm.template_alloc(input.length);
		new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
		let output;
		try {
			const packed = wasm.rich_text_render(pointer, input.length);
			const address = Number(packed >> 32n); const length = Number(packed & 0xffffffffn);
			try { output = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, address, length))); }
			finally { wasm.template_free(address, length); }
		} finally { wasm.template_free(pointer, input.length); }
		if (output.error) throw new Error(output.error);
		return output;
	}
}
