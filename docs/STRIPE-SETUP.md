# Stripe test-mode setup

What the owner does once, by hand, so checkout and the Stripe E2E suite run for real. Everything here is **test mode**: no real money moves, and the server refuses live keys unless `STRIPE_ALLOW_LIVE=true`. Prices are set in Stripe only; this public repo never contains amounts.

## 1. Account and catalog

1. Create a Stripe account and stay in **test mode** (the "Test mode" / sandbox toggle in the dashboard).
2. **Product catalog → Add product:** name it "Levelset Pro" and add two **recurring** prices: one monthly, one yearly, with whatever amounts you choose.
3. Copy the two **price IDs** (`price_…`).

## 2. Customer portal

**Settings → Billing → Customer portal**, then:
- Allow customers to **cancel** subscriptions (at the end of the billing period).
- Allow **switching plans** between the two Levelset Pro prices.
- Allow **updating payment methods** and **viewing invoices**.

## 3. API key

**Developers → API keys:** copy the **secret key** (`sk_test_…`). It's better to create a **restricted key** with only these permissions:

| Resource | Access |
|---|---|
| Checkout Sessions | Write |
| Customer portal | Write |
| Customers | Read |
| Subscriptions | Write (cancel when a customer deletes their account) |
| Prices | Read |
| Invoices | Read |
| Disputes | Read |

## 4. GitHub secrets (for CI)

```bash
gh secret set STRIPE_TEST_SECRET_KEY --repo MauricioRodCar/levelset-cloud
```

```bash
gh secret set STRIPE_TEST_PRICE_PRO_MONTHLY --repo MauricioRodCar/levelset-cloud
```

```bash
gh secret set STRIPE_TEST_PRICE_PRO_ANNUAL --repo MauricioRodCar/levelset-cloud
```

Each command prompts for the value, so it never lands in shell history. The next CI run then runs the **E2E (Stripe test mode)** job. It installs the Stripe CLI, forwards webhooks with `stripe listen`, pays with Stripe's published test card, and waits for the licence. Without the secrets the job prints a notice and skips.

## 5. Local development with Stripe

In `.env`: `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, and both `STRIPE_PRICE_PRO_*`. Then forward webhooks, either with the CLI:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

or with Docker (`docker compose --profile stripe up stripe`). Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET`, then `npm run dev` and open `/pricing`.

## 6. Deployed environment (milestone 8)

**Developers → Webhooks → Add endpoint:** `https://<app-host>/api/webhooks/stripe`, with these events:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
invoice.paid
invoice.payment_failed
charge.dispute.created
```

Put the endpoint's signing secret in `STRIPE_WEBHOOK_SECRET` in the host's secret store.

## Notes

- **API version:** the server uses the version pinned by the `stripe` SDK (`2026-09-30`). Webhook endpoints should use the same version.
- **Switching to a merchant of record at launch** (Lemon Squeezy, Paddle; PRD §8) means a new `PaymentProvider` adapter. Nothing above carries over except the catalog idea.
