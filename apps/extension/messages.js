export async function send(message) {
	const response = await chrome.runtime.sendMessage(message);
	if (!response?.ok) throw new Error(response?.error || 'Type Relay is unavailable');
	return response.value;
}
