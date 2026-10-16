// This file is loaded only on the hosted, server-confirmed signup page.
(() => {
	const link = document.querySelector('#signup-continue');
	if (location.origin !== 'https://app.typerelay.com' || location.pathname !== '/auth/confirmed' || !link?.dataset.transactionId || !link.dataset.sendTo) return;
	let finished = false;
	const redirect = () => { if (finished) return; finished = true; location.replace(link.href); };
	const timeout = setTimeout(redirect, 3000);
	window.dataLayer = window.dataLayer || [];
	const tag = function () { window.dataLayer.push(arguments); };
	tag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
	tag('set', 'allow_ad_personalization_signals', false);
	tag('set', 'url_passthrough', true);
	tag('js', new Date());
	tag('config', link.dataset.sendTo.split('/')[0], { send_page_view: false, page_referrer: '' });
	tag('event', 'conversion', {
		send_to: link.dataset.sendTo,
		transaction_id: link.dataset.transactionId,
		page_referrer: '',
		event_callback: () => {
			if (finished) return;
			// The callback acknowledges dispatch, not Google's eventual attribution/reporting.
			fetch('/auth/confirmed', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, body: JSON.stringify({ transaction_id: link.dataset.transactionId }) }).catch(() => {}).finally(() => { clearTimeout(timeout); redirect(); });
		},
	});
	const script = document.createElement('script');
	script.async = true;
	script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(link.dataset.sendTo.split('/')[0]);
	script.onerror = redirect;
	document.head.appendChild(script);
})();
