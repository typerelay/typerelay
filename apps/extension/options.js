import { send } from './messages.js';

const $ = selector => document.querySelector(selector);
let prefix = ';';
let connected = false;
let syncBusy = false;
let connectBusy = false;
let refreshSerial = 0;

async function refresh() {
	const serial = ++refreshSerial;
	const state = await send({ type: 'status' });
	if (serial !== refreshSerial) return;
	connected = state.connected;
	$('#account-state').textContent = state.connected ? `Signed in to ${state.origin}` : state.authPending ? 'Finish sign-in in the Chrome tab.' : 'Signed out';
	$('#auth-error').textContent = state.authError || '';
	$('#auth-error').hidden = !state.authError;
	$('#connect').hidden = state.connected || !!state.authPending;
	$('#connect').disabled = connectBusy;
	$('#restart-connect').hidden = state.connected || !state.authPending;
	$('#restart-connect').disabled = connectBusy;
	$('#disconnect').hidden = !state.connected;
	$('#sync').disabled = !state.connected || syncBusy;
	$('#sync-summary').textContent = state.connected ? `${state.count} snippets available offline.` : 'Sign in to sync your snippets.';
	$('#last-sync').textContent = state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}` : '';
	$('#prefix').value = state.prefix;
	prefix = state.prefix;
	$('#edit').href = `${state.origin}/`;
}

$('#connect').addEventListener('click', async () => { connectBusy = true; $('#connect').disabled = true; try { $('#auth-error').hidden = true; await send({ type: 'connect' }); await refresh(); } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; } finally { connectBusy = false; $('#connect').disabled = false; } });
$('#restart-connect').addEventListener('click', async () => { connectBusy = true; $('#restart-connect').disabled = true; try { await send({ type: 'cancel-connect' }); await send({ type: 'connect' }); await refresh(); } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; } finally { connectBusy = false; $('#restart-connect').disabled = false; } });
$('#disconnect').addEventListener('click', async () => { const button = $('#disconnect'); button.disabled = true; try { await send({ type: 'disconnect' }); await refresh(); } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; } finally { button.disabled = false; } });
$('#sync').addEventListener('click', async () => { syncBusy = true; $('#sync').disabled = true; $('#sync-status').textContent = 'Syncing…'; try { await send({ type: 'sync' }); await refresh(); $('#sync-status').textContent = 'Synced'; } catch (error) { $('#sync-status').textContent = error.message; } finally { syncBusy = false; $('#sync').disabled = !connected; } });
$('#prefix').addEventListener('change', async event => { const control = event.target; control.disabled = true; try { await send({ type: 'prefix', value: control.value }); prefix = control.value; $('#prefix-status').textContent = 'Saved'; } catch (error) { control.value = prefix; $('#prefix-status').textContent = error.message; } finally { control.disabled = false; } });
chrome.storage.onChanged.addListener((changes, area) => { if ((area === 'local' && ['tokens', 'items', 'lastSync'].some(key => key in changes)) || (area === 'session' && ['browserAuth', 'browserAuthError'].some(key => key in changes))) void refresh().catch(error => { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; }); });
window.addEventListener('focus', () => void refresh().catch(() => undefined));
void refresh().catch(error => { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; });
