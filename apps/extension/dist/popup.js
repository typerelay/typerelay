const $ = selector => document.querySelector(selector);
const send = async message => { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) throw new Error(response?.error || 'TypeRelay is unavailable'); return response.value; };
let items = [];

function status(message) { $('#status').textContent = message; }

function results() {
	const query = $('#search').value.trim().toLowerCase();
	const matches = items.filter(item => !query || [item.trigger, item.title, item.library].some(value => value?.toLowerCase().includes(query))).slice(0, 50);
	const list = $('#results');
	list.replaceChildren();
	for (const item of matches) {
		const row = document.createElement('li');
		const button = document.createElement('button');
		const title = document.createElement('strong');
		const detail = document.createElement('small');
		button.type = 'button';
		title.textContent = item.title || item.trigger || 'Untitled snippet';
		detail.textContent = `${item.library} · ${item.trigger || 'Search only'}`;
		button.append(title, detail);
		button.addEventListener('click', async () => {
			try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); const response = await chrome.tabs.sendMessage(tab.id, { type: 'insert', id: item.id }); if (!response?.ok) throw new Error(response?.error || 'Focus an editable field first'); window.close(); }
			catch (error) { status(error.message); }
		});
		row.append(button);
		list.append(row);
	}
}

async function refresh() {
	const state = await send({ type: 'status' });
	$('#signed-out').hidden = state.connected;
	$('#signed-in').hidden = !state.connected;
	$('#edit').href = `${state.origin}/`;
	$('#prefix').value = state.prefix;
	status(state.connected ? `${state.count} snippets` : 'Signed out');
	if (state.connected) { items = (await send({ type: 'snapshot' })).items; results(); }
}

$('#connect').addEventListener('click', async () => { try { status('Signing in…'); await send({ type: 'connect' }); await refresh(); } catch (error) { status(error.message); } });
$('#disconnect').addEventListener('click', async () => { try { await send({ type: 'disconnect' }); await refresh(); } catch (error) { status(error.message); } });
$('#sync').addEventListener('click', async () => { try { status('Syncing…'); await send({ type: 'sync' }); await refresh(); } catch (error) { status(error.message); } });
$('#search').addEventListener('input', results);
$('#prefix').addEventListener('change', async event => { try { await send({ type: 'prefix', value: event.target.value }); status('Prefix saved'); } catch (error) { status(error.message); } });
void refresh().catch(error => status(error.message));
