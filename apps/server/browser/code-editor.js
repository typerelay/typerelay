import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export class CodeEditor {
	static languages = languages;
	constructor(field, host, readonly = false) {
		this.field = field;
		this.language = new Compartment();
		this.indentation = new Compartment();
		this.readonly = new Compartment();
		this.version = 0;
		this.view = new EditorView({ parent: host, state: EditorState.create({ doc: field.value.replaceAll('\r\n', '\n'), extensions: [EditorView.contentAttributes.of({ 'aria-label': 'Code expansion' }), EditorView.cspNonce.of(document.querySelector('meta[name=style-nonce]')?.content || ''), lineNumbers(), history(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle), EditorState.tabSize.of(4), this.language.of([]), this.indentation.of(indentUnit.of('\t')), this.readonly.of([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]), keymap.of([{ key: 'Escape', run: view => { view.setTabFocusMode(2000); return true; }, stopPropagation: true }, { key: 'Tab', run: view => { if (view.state.readOnly) return false; view.dispatch(view.state.replaceSelection(this.unit || '\t')); return true; } }, { key: 'Shift-Tab', run: indentLess }, ...defaultKeymap.filter(binding => binding.key !== 'Enter'), { key: 'Enter', run: view => { if (view.state.readOnly) return false; view.dispatch(view.state.changeByRange(range => { const line = view.state.doc.lineAt(range.from); const indent = view.state.doc.sliceString(line.from, range.from).match(/^[\t ]*/)[0]; const insert = '\n' + indent; return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) }; })); return true; } }, ...historyKeymap]), EditorView.updateListener.of(update => { if (update.docChanged) field.value = update.state.doc.toString(); }), EditorView.theme({ '&': { border: '0.0625rem solid #dee2e6', borderRadius: '0.25rem' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace', minHeight: '16rem', maxHeight: '32rem' }, '.cm-content': { whiteSpace: 'pre' } })] }) });
		field.hidden = true;
	}
	async configure(language, spaces, width) {
		const version = ++this.version;
		const name = language.replace(/Lexer$/, '').toLowerCase();
		const description = languages.find(item => item.name.toLowerCase() === name || item.alias.some(alias => alias.toLowerCase() === name));
		const extension = description ? await description.load() : [];
		if (version !== this.version) return;
		this.view.dispatch({ effects: [this.language.reconfigure(extension), this.indentation.reconfigure(indentUnit.of(spaces ? ' '.repeat(Number(width) || 4) : '\t'))] });
		// Tab inserts the chosen indentation without formatting surrounding content.
		this.unit = spaces ? ' '.repeat(Number(width) || 4) : '\t';
	}
	setReadonly(readonly) { this.view.dispatch({ effects: this.readonly.reconfigure([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]) }); }
	destroy() { this.version++; this.view.destroy(); this.field.hidden = false; }
}
