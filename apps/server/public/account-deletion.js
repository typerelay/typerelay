document.querySelector('#account-deletion-form')?.addEventListener('submit', async event => {
	event.preventDefault();
	const form = event.currentTarget;
	const button = event.submitter;
	if (button.disabled) return;
	button.disabled = true;
	try {
		const answer = await Swal.fire({ title: 'Permanently delete your account?', text: 'This also deletes every account you own and its shared data. This cannot be undone.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete my account', reverseButtons: true });
		if (!answer.isConfirmed) return;
		const fields = new FormData(form);
		const response = await fetch('/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, body: JSON.stringify({ user: form.dataset.user, accounts: JSON.parse(form.dataset.accounts), confirmation: fields.get('confirmation'), confirm: fields.has('confirm') }) });
		const result = await response.json();
		if (!response.ok) throw Error(result.error || 'Could not request deletion. Please try again.');
		const receipt = new DOMParser().parseFromString(result.html, 'text/html').body.firstElementChild;
		document.querySelector('#account-deletion').replaceWith(receipt); receipt.focus();
	} catch (error) { await Swal.fire({ icon: 'error', title: 'Account deletion', text: error.message }); }
	finally { button.disabled = false; }
});
