export class Abbreviation {
	static normalize(value) { return typeof value === 'string' ? value.replace(/^[,;]+/, '') : value; }
	static field(input) {
		const value = Abbreviation.normalize(input.value);
		const removed = input.value.length - value.length;
		if (!removed) return;
		const start = input.selectionStart;
		const end = input.selectionEnd;
		input.value = value;
		if (start !== null && end !== null) input.setSelectionRange(Math.max(0, start - removed), Math.max(0, end - removed));
	}
}
