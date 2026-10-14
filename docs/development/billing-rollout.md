# October 2026 billing rollout

The application and production Swarm configuration are prepared for Free, Pro at $4 per user/month (1–5 users), and Team at $8 per user/month (from one user). Pro includes collaboration. White-label branding and custom domains remain Team features. SSO/SAML implementation is a separate task.

## Live catalog configuration

| Setting | Stripe ID |
| --- | --- |
| Free monthly price | `price_1UFgOyCyRKgmXfUBunyDdpJx` |
| Pro monthly price | `price_1UQMqjCyRKgmXfUBKbefysIc` |
| Team monthly price | `price_1UQMqmCyRKgmXfUBWrhUSrFJ` |
| Management portal | `bpc_1UQNciCyRKgmXfUBkz4iwtkh` |

The new management portal handles billing details, payment methods, invoices and cancellation at period end. App-validated plan/seat changes use Stripe confirmation flows with separate configurations restricted to the target price and plan seat bounds. Reductions use subscription schedules; applying a reduction releases its schedule so another change can be made immediately.

The previous production Compose contained Streamient Free/Unlimited price IDs, an empty Team price and a Streamient portal. The new configuration is in `helpmonks-install-script/docker/compose.swarm.typerelay.yml`. Changing that file does not update running services.

## Before an authorized production deployment

1. Register the TypeRelay live webhook at `https://app.typerelay.com/billing/webhook`, using the events in `StripeProvisioner.webhookEvents`. No TypeRelay endpoint existed in the live account's seven legacy webhook endpoints when checked on October 14. Store its signing secret in the production configuration; the existing value has not been verified against a TypeRelay endpoint. Configure delivery only as part of the production rollout.
2. Resolve Stripe Tax configuration. Checkout enables automatic tax and provisioning requires an active registration; the live account had zero active registrations when checked. This task does not choose or create tax registrations.
3. Audit any existing application subscriptions using the former Streamient price IDs before migration. Zero subscriptions on the original TypeRelay prices does not establish zero subscriptions under those incorrect IDs. Existing TypeRelay catalog prices remain recognizable and are not automatically repriced. No customer subscription was migrated by this task.
4. Release through the normal `develop` → `main` workflow, then deploy the matching application image and Swarm configuration together. Verify paid Checkout, signed webhook delivery, seat updates, a renewal reduction, cancellation and Free restoration. Refresh Cloudflare cache after the authorized deployment.

Production services, live webhooks, tax registrations, and customer subscriptions were not changed by this implementation task. The new live portal configuration is staged for the new Compose configuration.
