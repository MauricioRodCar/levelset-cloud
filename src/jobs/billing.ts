// Billing jobs (ARCHITECTURE §10):
//   node jobs/billing.mjs retry-webhooks   every 15 min: reprocess failed webhook events
//   node jobs/billing.mjs reconcile        nightly: compare the provider with the database
import { getPaymentProvider } from "@/server/billing/registry";
import { reconcileSubscriptions } from "@/server/billing/reconcile";
import { retryPendingWebhooks } from "@/server/billing/webhooks";
import { hashPepper, loadConfig } from "@/server/platform/config";
import { createDb } from "@/server/platform/db";

async function main(command: string | undefined): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDb(config.DATABASE_URL, { max: 2 });
  const ctx = { db, provider: getPaymentProvider(config), pepper: hashPepper(config) };
  try {
    if (command === "retry-webhooks") {
      const { attempted, succeeded } = await retryPendingWebhooks(ctx);
      console.log(`Webhook retry: ${succeeded}/${attempted} succeeded.`);
    } else if (command === "reconcile") {
      const r = await reconcileSubscriptions(ctx);
      console.log(
        `Reconciliation ${r.runId}: checked ${r.checked}, in sync ${r.inSync}, fixed ${r.fixed.length}, ` +
          `orphans ${r.orphansLocal.length}, errors ${r.errors.length}.`,
      );
      if (r.errors.length) process.exitCode = 2;
    } else {
      throw new Error("usage: billing.mjs <retry-webhooks|reconcile>");
    }
  } finally {
    await db.$client.end();
  }
}

main(process.argv[2]).catch((e: unknown) => {
  console.error("Billing job failed:", e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
