import { expect, test } from "@playwright/test";

// Real Stripe Checkout in test mode. Needs STRIPE_* test-mode secrets and `stripe listen` forwarding
// webhooks to /api/webhooks/stripe (the CI job sets both up; see docs/STRIPE-SETUP.md).
test.skip(!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"), "needs Stripe test-mode keys");

// Stripe's published test card: https://docs.stripe.com/testing
const TEST_CARD = { number: "4242424242424242", expiry: "12 / 34", cvc: "123" };

test("buys Pro through Stripe test-mode Checkout and gets a licence via the webhook", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByLabel("Pro · monthly").check();
  await page.getByLabel("Email for your licence").fill(`e2e-stripe-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Continue to payment" }).click();

  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  await page.locator("#cardNumber").fill(TEST_CARD.number);
  await page.locator("#cardExpiry").fill(TEST_CARD.expiry);
  await page.locator("#cardCvc").fill(TEST_CARD.cvc);
  await page.locator("#billingName").fill("E2E Tester");
  const postal = page.locator("#billingPostalCode");
  if (await postal.isVisible()) await postal.fill("10001");
  await page.getByTestId("hosted-payment-submit-button").click();

  await page.waitForURL(/\/checkout\/success\?session_id=cs_test_/, { timeout: 60_000 });
  await expect(page.getByTestId("checkout-state")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
});
