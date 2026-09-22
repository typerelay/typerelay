---
title: "TypeRelay Cloud billing"
description: "Understand TypeRelay Cloud plans, trials, billing, seat limits, cancellation, Stripe Tax, and custom-domain white-label settings."
---

# Billing

Hosted TypeRelay accounts start on Free. Account owners and admins can open **Settings → Subscription** to start the one-time seven-day Pro trial, buy Pro or Team, change Team seat capacity, update payment details, view invoices, or cancel at the end of the billing period.

Free includes one person, 250 active snippets, one active library, and one connected machine. API and MCP access require Pro or Team. Sharing, team management, brand assets, and custom domains require Team. Trashed content does not count until restored; existing data is retained after a downgrade.

Team includes five prepaid seats. Purchase additional seats in Subscription before inviting more people. Seat reductions and Team-to-Pro changes take effect at renewal after current members and invitations fit the target.

The no-card Pro trial becomes paid immediately when Checkout completes. Without Checkout, request-time checks end Pro access at the exact expiry timestamp and a protected scheduler persists the return to Free every five minutes. Trial owners are enrolled into the configured Helpmonks sequence by a durable worker with twelve attempts at five-minute intervals. A canceled paid subscription returns to Free after Stripe confirms the subscription ended.

Stripe Tax is enabled for Checkout. Keep the live account's registrations active. TypeRelay Products use the business-use hosted SaaS tax code and tax-exclusive Prices.

## White-label domains

Team owners and admins can upload a navigation logo, login logo, and favicon in **Settings → White-label**. For a custom hostname, create a DNS-only CNAME to `custom.typerelay.com`, save the hostname, and select **Verify**. TypeRelay shows the domain as active only after Cloudflare reports both hostname and SSL status active.

Brand assets accept PNG, JPG, WebP, AVIF, GIF or ICO images up to 5 MB and are normalized to PNG storage. Removing an asset returns that location to the TypeRelay default. The hostname field accepts only a hostname on your own domain, not a URL, path, TypeRelay-owned name or hostname already connected to another account.

Domain states distinguish missing DNS from pending SSL. **Refresh** rechecks the existing Cloudflare hostname; **Verify** checks the DNS CNAME and creates or recovers the Cloudflare custom hostname. Removing the domain stops branded-host routing but does not remove the account or its libraries. A Team-plan loss disables the custom hostname until the entitlement returns.

Passkeys remain bound to `app.typerelay.com`; branded domains support password, magic-link, and authenticator-code sign-in.
