// This adapter supplies browser-local time and answers to the shared Rust renderer.
export class TemplateRuntime {
	static module;
	static async render(template, values = {}, preview = false, now = new Date()) {
		TemplateRuntime.module ||= WebAssembly.instantiateStreaming(fetch('/assets/generated/template.wasm'), {}).then(result => result.instance.exports);
		const wasm = await TemplateRuntime.module;
		const input = new TextEncoder().encode(JSON.stringify({ template, values, preview, now_ms: now.getTime(), offset_minutes: -now.getTimezoneOffset() }));
		const pointer = wasm.template_alloc(input.length);
		new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
		let output;
		try {
			const packed = wasm.template_render(pointer, input.length);
			const address = Number(packed >> 32n); const length = Number(packed & 0xffffffffn);
			try { output = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, address, length))); } finally { wasm.template_free(address, length); }
		} finally { wasm.template_free(pointer, input.length); }
		if (output.error) throw new Error(output.error);
		return output;
	}
	static preview(result) { return result.steps.map(step => step.kind === 'enter' ? '⏎ [Enter key]' : step.text).join(''); }
}
