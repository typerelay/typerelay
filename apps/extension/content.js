(() => {
if (globalThis.typeRelayContentReady) return;
globalThis.typeRelayContentReady = true;

let items = [];
let prefix = ';';
let ownedUntil = 0;
let lastEditor;
let lastSelection;
let promptOpen = false;
const googleDocs = [location.origin, ...Array.from(location.ancestorOrigins || [])].includes('https://docs.google.com');

const send = async message => { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) throw new Error(response?.error || 'TypeRelay is unavailable'); return response.value; };

function editorFor(target) {
	if (!(target instanceof Element)) return null;
	if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly ? target : null;
	if (target instanceof HTMLInputElement) return ['text', 'search'].includes(target.type) && !target.disabled && !target.readOnly ? target : null;
	const editable = target.closest('[contenteditable]');
	return editable?.isContentEditable ? editable : null;
}

function selectionFor(editor) {
	if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) return { start: editor.selectionStart, end: editor.selectionEnd };
	const selection = editor.ownerDocument.getSelection();
	return selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
}

function beforeCaret(editor) {
	const saved = selectionFor(editor);
	if (!saved) return null;
	if ('start' in saved) return saved.start === saved.end ? editor.value.slice(0, saved.start) : null;
	if (!saved.collapsed) return null;
	const range = saved.cloneRange();
	range.selectNodeContents(editor);
	range.setEnd(saved.startContainer, saved.startOffset);
	return range.toString();
}

function restore(editor, saved) {
	editor.focus();
	if ('start' in saved) editor.setSelectionRange(saved.start, saved.end);
	else { const selection = editor.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(saved); }
}

async function notice(message) {
	try {
		const host = document.createElement('div');
		const shadow = host.attachShadow({ mode: 'closed' });
		const html = await fetch(chrome.runtime.getURL('notice.html')).then(response => response.text());
		const css = await fetch(chrome.runtime.getURL('notice.css')).then(response => response.text());
		const style = document.createElement('style');
		style.textContent = css;
		const panel = document.createElement('div');
		panel.innerHTML = html;
		panel.querySelector('[data-message]').textContent = message;
		shadow.append(style, panel);
		document.documentElement.append(host);
		setTimeout(() => host.remove(), 5000);
	} catch { /* The page can still use its unchanged field when a notice cannot load. */ }
}

async function promptFields(fields, variables) {
	const host = document.createElement('div');
	host.style.position = 'fixed';
	host.style.zIndex = '2147483647';
	host.style.inset = '0';
	const shadow = host.attachShadow({ mode: 'closed' });
	const html = await fetch(chrome.runtime.getURL('prompt.html')).then(response => response.text());
	const css = await fetch(chrome.runtime.getURL('prompt.css')).then(response => response.text());
	promptOpen = true;
	const style = document.createElement('style');
	style.textContent = css;
	shadow.append(style);
	const panel = document.createElement('div');
	panel.innerHTML = html;
	shadow.append(panel);
	document.documentElement.append(host);
	try {
		const { promptFields } = await import(chrome.runtime.getURL('prompt.js'));
		return await promptFields(shadow, fields, variables);
	} finally { host.remove(); promptOpen = false; }
}

function insert(editor, saved, expected, erase, rendered, rich) {
	if (!editor.isConnected || !saved) throw new Error('The original field is no longer available');
	restore(editor, saved);
	const before = beforeCaret(editor);
	if (expected && (!before || !before.endsWith(expected))) throw new Error('The field changed; abbreviation left unchanged');
	if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
		const start = editor.selectionStart;
		const begin = erase ? start - erase : start;
		const end = erase ? start : editor.selectionEnd;
		editor.setSelectionRange(begin, end);
		if (!document.execCommand('insertText', false, rendered.text)) { restore(editor, saved); throw new Error('This field rejected an undoable insertion'); }
		return;
	}
	const selection = editor.ownerDocument.getSelection();
	if (erase) { selection.collapseToEnd(); for (let index = 0; index < erase; index++) selection.modify('extend', 'backward', 'character'); }
	if (expected && selection.toString() !== expected) { restore(editor, saved); throw new Error('The rich editor moved; abbreviation left unchanged'); }
	if (rich && rendered.html) {
		if (!document.execCommand('insertHTML', false, rendered.html)) { restore(editor, saved); throw new Error('This editor rejected formatted insertion'); }
	} else if (!document.execCommand('insertText', false, rendered.text)) { restore(editor, saved); throw new Error('This editor rejected insertion'); }
}

async function expand(editor, saved, id, expected = '', erase = 0) {
	const preview = await send({ type: 'prepare', id, preview: true });
	if (preview.rendered.enter_actions) { notice('This snippet uses an Enter key action, which Chrome cannot perform safely. The field was left unchanged.'); return; }
	const fields = preview.rendered.fields || [];
	const values = fields.length ? await promptFields(fields, preview.rendered.variables) : {};
	if (values === null) return;
	const result = await send({ type: 'prepare', id, values, preview: false });
	if (result.rendered.enter_actions) { notice('This snippet uses an Enter key action, which Chrome cannot perform safely. The field was left unchanged.'); return; }
	insert(editor, saved, expected, erase, result.rendered, result.item.content.type === 'rich_text');
	await send({ type: 'usage', event: { event_id: crypto.randomUUID(), identity: result.statisticsIdentity, library: result.item.library_id, snippet: result.item.id, shared: result.item.shared, action: 'insert', client: 'extension', occurred_at: new Date().toISOString(), characters: Math.max(0, (result.rendered.characters ?? [...result.rendered.text].length) - erase) } }).catch(() => undefined);
}

async function claim() {
	if (googleDocs) { ownedUntil = 0; return; }
	if (!document.hasFocus() || !editorFor(document.activeElement) || promptOpen) { ownedUntil = 0; return; }
	try { if ((await send({ type: 'claim' })).verified) ownedUntil = Date.now() + 650; else ownedUntil = 0; } catch { ownedUntil = 0; }
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	if (changes.items) items = changes.items.newValue || [];
	if (changes.prefix) prefix = changes.prefix.newValue || ';';
});

void send({ type: 'snapshot' }).then(snapshot => { items = snapshot.items; prefix = snapshot.prefix; }).catch(() => undefined);
setInterval(() => { if (items.length) void claim(); }, 400);

document.addEventListener('focusin', event => { const editor = editorFor(event.target); if (editor) { lastEditor = editor; lastSelection = selectionFor(editor); void send({ type: 'focus' }).catch(() => undefined); void claim(); } }, true);
document.addEventListener('keyup', event => { const editor = editorFor(event.target); if (editor) { lastEditor = editor; lastSelection = selectionFor(editor); } }, true);
document.addEventListener('mouseup', event => { const editor = editorFor(event.target); if (editor) { lastEditor = editor; lastSelection = selectionFor(editor); } }, true);

document.addEventListener('keydown', event => {
	if (!event.isTrusted || event.key !== ' ' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || promptOpen || Date.now() > ownedUntil) return;
	const editor = editorFor(event.target);
	if (!editor) return;
	const before = beforeCaret(editor);
	if (!before) return;
	const match = before.match(/[,;./'\[\]\\`=][a-z0-9-]{1,63}$/);
	if (!match || match[0][0] !== prefix) return;
	const item = items.find(row => !row.abbreviation_collision && row.trigger === match[0].slice(1));
	if (!item) return;
	const saved = selectionFor(editor);
	event.preventDefault();
	event.stopImmediatePropagation();
	void send({ type: 'match', before, prefix, triggers: [...new Set(items.filter(row => !row.abbreviation_collision).map(row => row.trigger).filter(Boolean))] }).then(result => {
		if (!result || result.trigger !== item.trigger || result.erase !== match[0].length) throw new Error('Abbreviation changed');
		return expand(editor, saved, item.id, match[0], result.erase);
	}).catch(error => notice(error.message));
}, true);

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
	if (message.type !== 'insert') return;
	if (googleDocs) { reply({ ok: false, error: 'Google Docs insertion is not supported yet. Copy your snippet and paste it into the document.' }); return; }
	const editor = editorFor(document.activeElement) || lastEditor;
	const saved = editor ? selectionFor(editor) || lastSelection : null;
	if (!editor || !saved) { reply({ ok: false, error: 'Focus an editable field first' }); return; }
	void expand(editor, saved, message.id).then(() => reply({ ok: true }), error => reply({ ok: false, error: error.message }));
	return true;
});

})();
