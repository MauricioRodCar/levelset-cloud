import { expect, type Page, test } from "@playwright/test";

const email = (tag: string) => `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

async function startCheckout(page: Page, plan: "Pro · monthly" | "Pro · annual", address: string) {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Levelset Pro" })).toBeVisible();
  await page.getByLabel(plan).check();
  await page.getByLabel("Email for your licence").fill(address);
  await page.getByRole("button", { name: "Continue to payment" }).click();
}

test("buys Pro and waits for the webhook to create the licence", async ({ page }) => {
  await startCheckout(page, "Pro · monthly", email("buy"));
  await expect(page).toHaveURL(/\/fake-checkout\//);
  await expect(page.getByTestId("fake-plan")).toHaveText("pro_monthly");

  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page).toHaveURL(/\/checkout\/success\?session_id=/);
  await expect(page.getByTestId("checkout-state")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.getByRole("status")).toContainText("Your Pro licence is ready");
});

test("cancelling checkout returns to pricing without charging", async ({ page }) => {
  await startCheckout(page, "Pro · annual", email("cancel"));
  await expect(page.getByTestId("fake-plan")).toHaveText("pro_annual");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/pricing\?canceled=1/);
  await expect(page.getByText("Nothing was charged")).toBeVisible();
});

test("refuses a second subscription for an email that already has Pro", async ({ page }) => {
  const address = email("twice");
  await startCheckout(page, "Pro · monthly", address);
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByTestId("checkout-state")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

  await startCheckout(page, "Pro · annual", address);
  await expect(page.getByRole("alert").filter({ hasText: "already has an active Pro subscription" })).toBeVisible();
  await expect(page).toHaveURL(/\/pricing/);
});
