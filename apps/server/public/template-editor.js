import { TemplateRuntime } from './template-runtime.js';
export class TemplateEditor {
	constructor(client) { this.client = client; this.variables = {}; this.sequence = 0; }
	attach() {
		const area = document.querySelector('#replace');
		if (!area) return;
		const root = document.querySelector('#template-options');
		root.hidden = document.querySelector('#snippet-type').value !== 'template';
		if (area !== this.area) {
			this.area = area; this.variables = JSON.parse(root.dataset.variables); this.names = '';
			area.addEventListener('input', () => this.preview());
			root.addEventListener('input', event => { const field = event.target.dataset.vfield; if (field) { const name = event.target.closest('[data-variable]').dataset.variable; this.variables[name][field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; this.preview(); } });
			document.querySelector('#insert-variable').onclick = () => {
				if (this.client.codeReadonly) return;
				const kind = document.querySelector('#variable-kind').value;
				const name = kind === 'custom' ? document.querySelector('#variable-name').value : kind;
				if (kind === 'custom' && (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || ['date', 'time', 'timestamp'].includes(name))) return this.client.toast('Choose a field name; date, time and timestamp are built-ins.', 'error');
				area.setRangeText('{{' + name + '}}', area.selectionStart, area.selectionEnd, 'end'); area.focus(); area.dispatchEvent(new Event('input', { bubbles: true }));
			};
		}
		if (!root.hidden) this.preview();
	}
	async content() { return (await TemplateRuntime.render({ text: this.area.value, variables: this.variables }, {}, true)).template; }
	async preview() {
		if (!this.area?.isConnected || document.querySelector('#snippet-type').value !== 'template') return;
		const sequence = ++this.sequence;
		try {
			const result = await TemplateRuntime.render({ text: this.area.value, variables: this.variables }, {}, true);
			if (sequence !== this.sequence || !this.area.isConnected) return;
			this.variables = result.template.variables;
			const names = JSON.stringify(Object.keys(this.variables));
			if (names !== this.names) {
				this.names = names; const container = document.querySelector('#variable-definitions'); container.replaceChildren();
				for (const [name, definition] of Object.entries(this.variables)) {
					const row = document.querySelector('#variable-definition').content.firstElementChild.cloneNode(true); row.dataset.variable = name; row.querySelector('legend').textContent = '{{' + name + '}}';
					const builtin = ['date', 'time', 'timestamp'].includes(name);
					row.querySelectorAll('[data-input-options]').forEach(node => node.hidden = builtin); row.querySelector('[data-time-options]').hidden = !builtin;
					for (const field of row.querySelectorAll('[data-vfield]')) { if (field.type === 'checkbox') field.checked = definition[field.dataset.vfield]; else field.value = definition[field.dataset.vfield]; field.disabled = !!this.client.codeReadonly; const label = field.previousElementSibling; field.id = 'variable-' + name + '-' + field.dataset.vfield; if (label?.tagName === 'LABEL') label.htmlFor = field.id; }
					container.append(row);
				}
			}
			document.querySelector('#template-preview').textContent = TemplateRuntime.preview(result); document.querySelector('#template-error').textContent = '';
		} catch (error) { if (sequence === this.sequence && document.querySelector('#template-error')) document.querySelector('#template-error').textContent = error.message; }
	}
}
export class TemplateFill {
	constructor(client) {
		this.client = client; this.sequence = 0;
		this.modal = document.querySelector('#template-fill');
		if (!this.modal) return;
		this.modal.addEventListener('input', () => this.preview());
		this.modal.addEventListener('hidden.bs.modal', () => { this.sequence++; this.content = null; document.querySelector('#template-fill-fields').replaceChildren(); document.querySelector('#template-fill-preview').textContent = ''; if (this.restoreEditor) { this.restoreEditor = false; bootstrap.Modal.getOrCreateInstance(document.querySelector('#form-modal')).show(); } });
		document.querySelector('#template-fill-form').onsubmit = async event => {
			event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
			try { const now = new Date(); const values = this.values(); if (this.revalidate) await this.revalidate(); const result = await TemplateRuntime.render(this.content, values, false, now); await navigator.clipboard.writeText(result.text); bootstrap.Modal.getInstance(this.modal).hide(); this.client.toast(result.enter_actions ? 'Copied text. Enter key actions were omitted.' : 'Copied'); } catch (error) { document.querySelector('#template-fill-error').textContent = error.message; } finally { if (button) button.disabled = false; }
		};
	}
	values() { return Object.fromEntries([...document.querySelectorAll('[data-answer]:not([hidden])')].map(field => [field.dataset.answer, field.value])); }
	async preview() { const sequence = ++this.sequence; try { const result = await TemplateRuntime.render(this.content, this.values(), true); if (sequence !== this.sequence) return; document.querySelector('#template-fill-preview').textContent = TemplateRuntime.preview(result); document.querySelector('#template-fill-error').textContent = ''; } catch (error) { if (sequence === this.sequence) document.querySelector('#template-fill-error').textContent = error.message; } }
	async open(content, revalidate = null) {
		const source = { text: content.text, variables: content.variables || {} };
		const result = await TemplateRuntime.render(source, {}, true);
		this.content = result.template; this.revalidate = revalidate;
		if (!result.fields.length) { if (revalidate) await revalidate(); const filled = await TemplateRuntime.render(source); await navigator.clipboard.writeText(filled.text); this.client.toast(filled.enter_actions ? 'Copied text. Enter key actions were omitted.' : 'Copied'); return; }
		const container = document.querySelector('#template-fill-fields'); container.replaceChildren();
		for (const name of result.fields) {
			const field = result.template.variables[name]; const row = document.querySelector('#template-fill-field').content.firstElementChild.cloneNode(true); const control = row.querySelector(field.multiline ? 'textarea' : 'input'); row.querySelector('input').hidden = field.multiline; row.querySelector('textarea').hidden = !field.multiline; control.dataset.answer = name; control.id = 'answer-' + name; control.value = field.default; control.required = field.required; row.querySelector('label').textContent = field.label + (field.required ? ' *' : ''); row.querySelector('label').htmlFor = control.id; container.append(row);
		}
		document.querySelector('#template-fill-actions').textContent = result.enter_actions ? 'Copy includes text only. Enter key actions are omitted.' : '';
		const editor = document.querySelector('#form-modal'); this.restoreEditor = editor.classList.contains('show');
		if (this.restoreEditor) await new Promise(resolve => { editor.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(editor).hide(); });
		bootstrap.Modal.getOrCreateInstance(this.modal).show(); await this.preview();
	}
}
