import { and, eq, ne } from "drizzle-orm";
import { reconciliationRuns, subscriptions } from "@/db/schema";
import { AppError } from "@/server/platform/errors";
import { type BillingContext, syncSubscription } from "./sync";
import type { SubscriptionState } from "./types";

/**
 * Billing reconciliation (FR-15, ARCHITECTURE §6.4): walks every subscription
 * the provider knows, fixes drift through the same sync code as webhooks
 * (audited as system:reconcile), and lists local subscriptions the provider
 * doesn't know. The report is stored for the admin panel.
 */

export type ReconcileReport = {
  provider: string;
  checked: number;
  inSync: number;
  fixed: { ref: string; from: SubscriptionState | null; to: SubscriptionState; events: string[] }[];
  /** Live locally but unknown to the provider. */
  orphansLocal: string[];
  errors: { ref: string; code: string; message: string }[];
};

export async function reconcileSubscriptions(ctx: BillingContext): Promise<ReconcileReport & { runId: string }> {
  const startedAt = new Date();
  const actor = { type: "system", id: "reconcile" } as const;
  const report: ReconcileReport = { provider: ctx.provider.id, checked: 0, inSync: 0, fixed: [], orphansLocal: [], errors: [] };
  const seen = new Set<string>();

  for await (const snapshot of ctx.provider.listSubscriptions()) {
    report.checked++;
    seen.add(snapshot.ref);
    try {
      const result = await ctx.db.transaction((tx) => syncSubscription(tx, ctx, snapshot, { actor }));
      if (result.changed) report.fixed.push({ ref: snapshot.ref, from: result.from, to: result.to, events: result.events });
      else report.inSync++;
    } catch (e) {
      report.errors.push({
        ref: snapshot.ref,
        code: e instanceof AppError ? e.code : "error",
        message: e instanceof Error ? e.message : "unknown error",
      });
    }
  }

  const live = await ctx.db
    .select({ ref: subscriptions.providerSubscriptionId })
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, ctx.provider.id), ne(subscriptions.state, "ended")));
  report.orphansLocal = live.map((r) => r.ref).filter((ref) => !seen.has(ref));

  const [run] = await ctx.db
    .insert(reconciliationRuns)
    .values({ provider: ctx.provider.id, startedAt, finishedAt: new Date(), report })
    .returning({ id: reconciliationRuns.id });
  return { ...report, runId: run!.id };
}
