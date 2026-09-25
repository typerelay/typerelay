import { send } from './messages.js';
import { promptFields } from './prompt.js';

const $ = selector => document.querySelector(selector);
let items = [];
let matches = [];
let selectedIndex = -1;
let openingOptions = false;
let copying = false;

function status(message) { $('#status').textContent = message; $('#status').hidden = !message; }

async function openSettings() {
	if (openingOptions) return;
	openingOptions = true;
	try { await chrome.runtime.openOptionsPage(); window.close(); }
	catch (error) { openingOptions = false; status(error.message); }
}

async function copy(item) {
	if (copying) return;
	copying = true;
	status('');
	const row = document.getElementById('result-' + item.id);
	row?.setAttribute('aria-busy', 'true');
	try {
		const preview = await send({ type: 'prepare', id: item.id, preview: true });
		if (preview.rendered.enter_actions) throw new Error('This snippet uses an Enter key action, which cannot be copied. Clipboard unchanged.');
		const fields = preview.rendered.fields || [];
		let values = {};
		if (fields.length) {
			const panel = $('#copy-prompt');
			panel.replaceChildren($('#prompt-template').content.cloneNode(true));
			$('#signed-in').hidden = true;
			panel.hidden = false;
			try { values = await promptFields(panel, fields, preview.rendered.variables, 'Copy'); }
			finally { panel.hidden = true; panel.replaceChildren(); $('#signed-in').hidden = false; $('#search').focus(); }
			if (values === null) return;
		}
		const result = await send({ type: 'prepare', id: item.id, values, preview: false });
		if (result.rendered.enter_actions) throw new Error('This snippet uses an Enter key action, which cannot be copied. Clipboard unchanged.');
		if (result.item.content.type === 'rich_text' && result.rendered.html) {
			await window.navigator.clipboard.write([new window.ClipboardItem({ 'text/plain': new Blob([result.rendered.text], { type: 'text/plain' }), 'text/html': new Blob([result.rendered.html], { type: 'text/html' }) })]);
		} else await window.navigator.clipboard.writeText(result.rendered.text);
		await send({ type: 'usage', event: { event_id: crypto.randomUUID(), identity: result.statisticsIdentity, library: result.item.library_id, snippet: result.item.id, shared: result.item.shared, action: 'copy', client: 'extension', occurred_at: new Date().toISOString(), characters: Math.max(0, (result.rendered.characters ?? [...result.rendered.text].length)) } }).catch(() => undefined);
		window.close();
	} catch (error) { status(error.message); }
	finally { copying = false; row?.removeAttribute('aria-busy'); }
}

function select(index, scroll = false) {
	selectedIndex = matches.length ? (index + matches.length) % matches.length : -1;
	for (const [position, row] of [...$('#results').children].entries()) row.setAttribute('aria-selected', String(position === selectedIndex));
	const selected = $('#results').children[selectedIndex];
	if (selected) { $('#search').setAttribute('aria-activedescendant', selected.id); if (scroll) selected.scrollIntoView?.({ block: 'nearest' }); }
	else $('#search').removeAttribute('aria-activedescendant');
}

function results() {
	const query = $('#search').value.trim().toLowerCase();
	const list = $('#results');
	if (!query) { matches = []; list.replaceChildren(); list.hidden = true; $('#search').setAttribute('aria-expanded', 'false'); $('#search-message').hidden = true; $('#search-message').textContent = ''; select(-1); return; }
	matches = items.filter(item => [item.trigger, item.title, item.library].some(value => value?.toLowerCase().includes(query))).slice(0, 20);
	const fragment = document.createDocumentFragment();
	for (const item of matches) {
		const row = $('#result-template').content.firstElementChild.cloneNode(true);
		row.id = 'result-' + item.id;
		row.querySelector('strong').textContent = item.title || item.trigger || 'Untitled snippet';
		row.querySelector('small').textContent = item.library + ' · ' + (item.trigger || 'Search only') + (item.abbreviation_collision ? ' · Abbreviation paused: duplicate' : '');
		row.querySelector('.result-summary').addEventListener('click', () => void copy(item));
		const detail = row.querySelector('.detail');
		const preview = row.querySelector('.preview');
		preview.id = 'preview-' + item.id;
		detail.setAttribute('aria-controls', preview.id);
		let previewSerial = 0;
		detail.addEventListener('click', async () => {
			select(matches.findIndex(match => match.id === item.id));
			$('#search').focus({ preventScroll: true });
			const serial = ++previewSerial;
			preview.hidden = !preview.hidden;
			detail.setAttribute('aria-expanded', String(!preview.hidden));
			if (preview.hidden) return;
			const message = preview.querySelector('.preview-status');
			const plain = preview.querySelector('.preview-text');
			const rich = preview.querySelector('.preview-rich');
			message.textContent = 'Loading…';
			message.hidden = false;
			plain.hidden = true;
			rich.hidden = true;
			try {
				const result = await send({ type: 'prepare', id: item.id, preview: true });
				if (!row.isConnected || serial !== previewSerial) return;
				if (result.item.content.type === 'rich_text' && result.rendered.html) {
					const parser = new window.DOMParser();
					const shell = parser.parseFromString($('#preview-shell').innerHTML, 'text/html');
					const content = document.createElement('template');
					content.innerHTML = result.rendered.html;
					for (const element of content.content.querySelectorAll('script, style, meta, link, base, iframe, object, embed, form')) element.remove();
					for (const element of content.content.querySelectorAll('*')) for (const attribute of [...element.attributes]) if (!['src', 'alt', 'width', 'height', 'colspan', 'rowspan'].includes(attribute.name) || (attribute.name === 'src' && (element.tagName !== 'IMG' || !/^data:image\//i.test(attribute.value)))) element.removeAttribute(attribute.name);
					shell.querySelector('#preview-content').replaceChildren(...content.content.childNodes);
					rich.srcdoc = shell.documentElement.outerHTML;
					rich.hidden = false;
				} else { plain.textContent = result.rendered.text; plain.hidden = false; }
				message.hidden = true;
			} catch (error) { if (row.isConnected && serial === previewSerial) message.textContent = error.message; }
		});
		fragment.append(row);
	}
	list.replaceChildren(fragment);
	list.hidden = !matches.length;
	$('#search').setAttribute('aria-expanded', String(!!matches.length));
	$('#search-message').hidden = !!matches.length;
	$('#search-message').textContent = matches.length ? '' : 'No snippets found.';
	select(0);
}

async function refresh() {
	const state = await send({ type: 'status' });
	$('#open-app').href = `${state.origin}/`;
	$('#open-app').hidden = !state.origin;
	if (!state.connected) { $('#signed-out').hidden = false; $('#signed-in').hidden = true; status(state.authError || 'Sign in from options.'); await openSettings(); return; }
	$('#signed-out').hidden = true;
	$('#signed-in').hidden = false;
	status(state.authError || '');
	items = (await send({ type: 'snapshot' })).items;
	results();
	$('#search').focus();
}

$('#settings').addEventListener('click', () => void openSettings());
$('#search').addEventListener('input', results);
$('#search').addEventListener('keydown', event => {
	if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); select(selectedIndex + 1, true); }
	if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); select(selectedIndex - 1, true); }
	if (event.key === 'Enter' && !event.isComposing && !event.repeat && selectedIndex >= 0) { event.preventDefault(); void copy(matches[selectedIndex]); }
});
void refresh().catch(error => status(error.message));
