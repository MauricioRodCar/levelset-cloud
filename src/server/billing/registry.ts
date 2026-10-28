import type { Config } from "@/server/platform/config";
import { FakePaymentProvider } from "./fake-provider";
import { StripePaymentProvider } from "./stripe-provider";
import type { PaymentProvider } from "./types";

const globalForProvider = globalThis as unknown as {
  __levelsetFakeProvider?: FakePaymentProvider;
  __levelsetStripeProvider?: StripePaymentProvider;
};

/**
 * The configured provider. The fake keeps its state in memory, so one instance
 * per process (kept on globalThis to survive dev-server hot reloads).
 */
export function getPaymentProvider(config: Config): PaymentProvider {
  switch (config.PAYMENT_PROVIDER) {
    case "fake":
      globalForProvider.__levelsetFakeProvider ??= new FakePaymentProvider({ baseUrl: config.APP_URL });
      return globalForProvider.__levelsetFakeProvider;
    case "stripe":
      globalForProvider.__levelsetStripeProvider ??= new StripePaymentProvider(config);
      return globalForProvider.__levelsetStripeProvider;
  }
}
