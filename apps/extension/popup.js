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
		const row = $('#result-template').content.cloneNode(true);
		const button = row.querySelector('button');
		const title = row.querySelector('strong');
		const detail = row.querySelector('small');
		title.textContent = item.title || item.trigger || 'Untitled snippet';
		detail.textContent = `${item.library} · ${item.trigger || 'Search only'}`;
		button.addEventListener('click', async () => {
			try { await send({ type: 'insert', id: item.id }); window.close(); }
			catch (error) { status(error.message); }
		});
		list.append(row);
	}
}

async function refresh() {
	const state = await send({ type: 'status' });
	$('#signed-out').hidden = state.connected;
	$('#signed-in').hidden = !state.connected;
	$('#edit').href = `${state.origin}/`;
	$('#prefix').value = state.prefix;
	status(!state.connected ? 'Signed out' : !state.bridgeVerified ? 'Desktop update needed' : `${state.count} snippets`);
	if (state.connected) { items = (await send({ type: 'snapshot' })).items; results(); }
}

$('#connect').addEventListener('click', async () => { try { status('Signing in…'); await send({ type: 'connect' }); await refresh(); } catch (error) { status(error.message); } });
$('#disconnect').addEventListener('click', async () => { try { await send({ type: 'disconnect' }); await refresh(); } catch (error) { status(error.message); } });
$('#sync').addEventListener('click', async () => { try { status('Syncing…'); await send({ type: 'sync' }); await refresh(); } catch (error) { status(error.message); } });
$('#search').addEventListener('input', results);
$('#prefix').addEventListener('change', async event => { try { await send({ type: 'prefix', value: event.target.value }); status('Prefix saved'); } catch (error) { status(error.message); } });
void refresh().catch(error => status(error.message));
