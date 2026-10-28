import { getConfig, hashPepper } from "@/server/platform/config";
import { getDb } from "@/server/platform/db";
import { getPaymentProvider } from "./registry";
import type { CheckoutContext } from "./checkout";
import type { BillingContext } from "./sync";

/** The billing context for this process: database, configured provider, hash pepper. */
export function getBillingContext(): BillingContext & CheckoutContext {
  const config = getConfig();
  return { db: getDb(), provider: getPaymentProvider(config), pepper: hashPepper(config), config };
}
