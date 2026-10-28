import { listOffers } from "@/server/billing/checkout";
import { getBillingContext } from "@/server/billing/context";
import { CheckoutForm } from "./checkout-form";

// FR-2: Pro plans with prices read from the payment provider (never stored in this repo), plus Free.
export const dynamic = "force-dynamic";

function formatPrice(price: { currency: string; unitAmount: number; interval: string } | null) {
  if (!price) return "Price shown at checkout";
  const amount = new Intl.NumberFormat("en", { style: "currency", currency: price.currency.toUpperCase() }).format(price.unitAmount / 100);
  return `${amount} / ${price.interval}`;
}

export default async function Pricing({ searchParams }: { searchParams: Promise<{ canceled?: string }> }) {
  const { canceled } = await searchParams;
  const offers = await listOffers(getBillingContext());

  return (
    <main>
      <h1>Levelset Pro</h1>
      <p className="muted">One installer for everyone. Pro unlocks with a licence key; Free never needs one.</p>
      {canceled && <p className="muted">Checkout canceled. Nothing was charged.</p>}

      <div className="grid">
        <section className="card">
          <h2>Free</h2>
          <p className="price">Free</p>
          <p className="muted">The open-source core. No account, no key.</p>
          <a href="https://github.com/MauricioRodCar/Levelset/releases">Download Levelset</a>
        </section>
        <CheckoutForm
          offers={offers.map((o) => ({ key: o.key, label: o.interval === "year" ? "Pro · annual" : "Pro · monthly", price: formatPrice(o.price) }))}
        />
      </div>
    </main>
  );
}
