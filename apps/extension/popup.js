import { send } from './messages.js';

const $ = selector => document.querySelector(selector);
let items = [];
let matches = [];
let selectedIndex = -1;
let openingOptions = false;

function status(message) { $('#status').textContent = message; $('#status').hidden = !message; }

async function openSettings() {
	if (openingOptions) return;
	openingOptions = true;
	try { await chrome.runtime.openOptionsPage(); window.close(); }
	catch (error) { openingOptions = false; status(error.message); }
}

async function insert(item) {
	try { await send({ type: 'insert', id: item.id }); window.close(); }
	catch (error) { status(error.message); }
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
	if (!query) { matches = []; list.replaceChildren(); list.hidden = true; $('#search').setAttribute('aria-expanded', 'false'); $('#search-message').hidden = false; $('#search-message').textContent = 'Type to search snippets.'; select(-1); return; }
	matches = items.filter(item => [item.trigger, item.title, item.library].some(value => value?.toLowerCase().includes(query))).slice(0, 20);
	const fragment = document.createDocumentFragment();
	for (const item of matches) {
		const row = $('#result-template').content.firstElementChild.cloneNode(true);
		row.id = 'result-' + item.id;
		row.querySelector('strong').textContent = item.title || item.trigger || 'Untitled snippet';
		row.querySelector('small').textContent = item.library + ' · ' + (item.trigger || 'Search only');
		row.addEventListener('click', () => void insert(item));
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
	if (!state.connected) { $('#signed-out').hidden = false; $('#signed-in').hidden = true; status(state.authError || 'Sign in from settings.'); await openSettings(); return; }
	$('#signed-out').hidden = true;
	$('#signed-in').hidden = false;
	status(state.authError || (state.bridgeVerified ? '' : 'Desktop update needed'));
	items = (await send({ type: 'snapshot' })).items;
	results();
	$('#search').focus();
}

$('#settings').addEventListener('click', () => void openSettings());
$('#search').addEventListener('input', results);
$('#search').addEventListener('keydown', event => {
	if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); select(selectedIndex + 1, true); }
	if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); select(selectedIndex - 1, true); }
	if (event.key === 'Enter' && selectedIndex >= 0) { event.preventDefault(); void insert(matches[selectedIndex]); }
});
void refresh().catch(error => status(error.message));
