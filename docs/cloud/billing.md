# Billing

Hosted TypeRelay accounts start on Free. Account owners and admins can open **Settings → Subscription** to start the one-time seven-day Pro trial, buy Pro or Team, change Team seat capacity, update payment details, view invoices, or cancel at the end of the billing period.

Free includes one person, 250 active snippets, one active library, and one connected machine. API and MCP access require Pro or Team. Sharing, team management, brand assets, and custom domains require Team. Trashed content does not count until restored; existing data is retained after a downgrade.

Team includes five prepaid seats. Purchase additional seats in Subscription before inviting more people. Seat reductions and Team-to-Pro changes take effect at renewal after current members and invitations fit the target.

The no-card Pro trial becomes paid immediately when Checkout completes. Without Checkout, request-time checks end Pro access at the exact expiry timestamp and a protected scheduler persists the return to Free every five minutes. Trial owners are enrolled into the configured Helpmonks sequence by a durable worker with twelve attempts at five-minute intervals. A canceled paid subscription returns to Free after Stripe confirms the subscription ended.

Stripe Tax is enabled for Checkout. Keep the live account's registrations active. TypeRelay Products use the business-use hosted SaaS tax code and tax-exclusive Prices.

## White-label domains

Team owners and admins can upload a navigation logo, login logo, and favicon in **Settings → White-label**. For a custom hostname, create a DNS-only CNAME to `custom.typerelay.com`, save the hostname, and select **Verify**. TypeRelay shows the domain as active only after Cloudflare reports both hostname and SSL status active.

Passkeys remain bound to `app.typerelay.com`; branded domains support password, magic-link, and authenticator-code sign-in.
