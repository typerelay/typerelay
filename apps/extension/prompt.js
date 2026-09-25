export function promptFields(root, fields, variables, submitLabel = 'Insert') {
	const form = root.querySelector('form');
	const container = root.querySelector('[data-fields]');
	const answers = {};
	for (const [index, name] of fields.entries()) {
		const variable = variables?.[name] || {};
		const template = root.querySelector(variable.multiline ? '[data-multiline]' : '[data-single]');
		const row = template.content.cloneNode(true);
		const label = row.querySelector('label');
		const input = row.querySelector('input, textarea');
		label.textContent = variable.label || name;
		label.htmlFor = `typerelay-field-${index}`;
		input.id = label.htmlFor;
		input.name = name;
		input.value = variable.default || '';
		input.required = variable.required !== false;
		container.append(row);
	}
	form.querySelector('[type="submit"]').textContent = submitLabel;
	return new Promise(resolve => {
		const cancel = root.querySelector('[data-cancel]');
		const finish = value => { form.removeEventListener('submit', submit); cancel.removeEventListener('click', abort); form.removeEventListener('keydown', keydown); resolve(value); };
		const submit = event => { event.preventDefault(); if (!form.reportValidity()) return; const data = new form.ownerDocument.defaultView.FormData(form); for (const field of fields) answers[field] = data.get(field) || ''; finish(answers); };
		const abort = () => finish(null);
		const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); abort(); } };
		form.addEventListener('submit', submit);
		cancel.addEventListener('click', abort);
		form.addEventListener('keydown', keydown);
		form.querySelector('input, textarea')?.focus();
	});
}
