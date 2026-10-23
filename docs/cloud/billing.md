---
title: "TypeRelay Cloud billing"
description: "Understand TypeRelay Cloud plans, trials, billing, seat limits, cancellation, Stripe Tax, and custom-domain white-label settings."
---

# Billing

Hosted TypeRelay accounts start on Free. Account owners and admins can open **Settings → Subscription** to start the one-time seven-day Pro trial, buy Pro or Team, change purchased seat capacity, update payment details, view invoices, or cancel at the end of the billing period.

If a billing action reports that billing changed, refresh Subscription and retry. An older confirmation cannot overwrite a newer subscription update or cancellation.

Free includes one person, 250 active snippets, one active library, and one connected machine. API and MCP access require Pro or Team. Pro costs $4 per user per month for 1–5 users, including the owner. Team costs $8 per user per month with no plan user cap. Both paid plans include sharing, team management, team statistics and private web AI; local AI is available on all plans. Brand assets and custom domains require Team. Trashed content does not count until restored; existing data is retained after a downgrade.

Both paid plans start at one purchased seat. Pending invitations reserve seats. Purchase enough seats in Subscription before inviting or adding people. An active Pro trial allows up to five users. Seat reductions and Team-to-Pro changes take effect at renewal after current members and invitations fit the target.

Scheduled reductions reserve the future capacity immediately. Cancel a scheduled change in Subscription before choosing another plan or seat count. Stripe confirms upgrades using the exact plan and seat count selected in TypeRelay. The general customer portal manages invoices, payment details, billing details, and cancellation; plan and seat selection starts in TypeRelay.

Opening Checkout reserves its selected capacity during a trial. Finish the existing checkout or cancel it in Subscription before choosing another quantity. An expired checkout releases its reservation when Stripe reports its expiration.

If retained memberships exceed a plan's capacity, the owner and earliest members within that capacity keep access. Other memberships remain stored and regain access when enough seats become available; a Pro trial never activates more than five people.

The no-card Pro trial becomes paid immediately when Checkout completes. Without Checkout, request-time checks end Pro access at the exact expiry timestamp and a protected scheduler persists the return to Free every five minutes. Trial owners are enrolled into the configured Helpmonks sequence by a durable worker with twelve attempts at five-minute intervals. A canceled paid subscription returns to Free after Stripe confirms the subscription ended.

Stripe Tax is enabled for Checkout. Keep the live account's registrations active. Prices exclude applicable taxes. Existing product tax categories are preserved when updating the catalog.

## White-label domains

Team owners and admins can upload a navigation logo, login logo, and favicon in **Settings → White-label**. For a custom hostname, create a DNS-only CNAME to `custom.typerelay.com`, save the hostname, and select **Verify**. TypeRelay shows the domain as active only after Cloudflare reports both hostname and SSL status active. A saved hostname that is not verified does not reserve the domain. After an account verifies the CNAME, other accounts cannot connect the same hostname.

Brand assets accept PNG, JPG, WebP, AVIF, GIF or ICO images up to 5 MB and are normalized to PNG storage. Removing an asset returns that location to the TypeRelay default. The hostname field accepts only a hostname on your own domain, not a URL, path, TypeRelay-owned name or hostname already connected to another account.

A failed branding save keeps the previously saved image file available. Reload White-label settings before retrying an upload or removal.

Domain states distinguish missing DNS from pending SSL. **Refresh** rechecks the existing Cloudflare hostname; **Verify** checks the DNS CNAME and creates or recovers the Cloudflare custom hostname. A failed DNS recheck preserves an existing verified reservation. Remove or change the hostname to release it after external cleanup finishes. Removing the domain stops branded-host routing but does not remove the account or its libraries. A Team-plan loss disables the custom hostname until the entitlement returns.

Domain changes run one at a time per account. A conflicting request returns 409; retry after the current operation finishes. If a provider request has an uncertain outcome, TypeRelay keeps its reservation and cleanup details. **Verify** or **Refresh** can recover a provider record only when its account and claim metadata match. A pending create is never repeated or discarded merely because time passed. If no exact record can be confirmed, an operator must reconcile the provider state before the hostname can be changed or removed.

Older Cloudflare records without account and claim metadata require operator reconciliation before domain changes or cleanup. TypeRelay preserves their existing routing and reservation and does not automatically adopt or delete them. A disabled domain stays disabled until its pending cleanup is resolved, even if the Team entitlement returns.

Passkeys remain bound to `app.typerelay.com`; branded domains support password, magic-link, and authenticator-code sign-in.

## Single sign-on

[SAML SSO](../guide/sso) is available on Pro and Team, including the Pro trial. A custom domain is optional and remains a Team feature. SSO sign-in and enforcement are inactive on Free; configuration is retained and owners can use ordinary sign-in.
