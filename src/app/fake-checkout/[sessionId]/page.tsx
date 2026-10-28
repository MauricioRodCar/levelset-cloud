import { notFound, redirect } from "next/navigation";
import { getBillingContext } from "@/server/billing/context";
import { FakePaymentProvider } from "@/server/billing/fake-provider";
import { receiveWebhook } from "@/server/billing/webhooks";

// Stand-in for the provider's hosted checkout when PAYMENT_PROVIDER=fake (local development and E2E).
// It completes the fake checkout and delivers the resulting webhooks to our own pipeline.
export const dynamic = "force-dynamic";

function fakeProvider() {
  const { provider } = getBillingContext();
  if (!(provider instanceof FakePaymentProvider)) notFound();
  return provider;
}

async function complete(sessionId: string, outcome: "paid" | "trial") {
  "use server";
  const ctx = getBillingContext();
  const provider = fakeProvider();
  provider.completeCheckout(sessionId, outcome);
  for (const d of provider.takeDeliveries()) await receiveWebhook(ctx, d.body, d.headers);
  redirect(`/checkout/success?session_id=${encodeURIComponent(sessionId)}`);
}

export default async function FakeCheckout({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = fakeProvider().getSession(sessionId);
  if (!session) notFound();

  return (
    <main className="card">
      <p className="badge">Test checkout · fake provider</p>
      <h1>Confirm your subscription</h1>
      <dl>
        <dt>Plan</dt>
        <dd data-testid="fake-plan">{session.planKey}</dd>
        <dt>Email</dt>
        <dd>{session.email}</dd>
        {session.trialDays > 0 && (
          <>
            <dt>Trial</dt>
            <dd>{session.trialDays} days</dd>
          </>
        )}
      </dl>
      <form action={complete.bind(null, sessionId, session.trialDays > 0 ? "trial" : "paid")}>
        <button type="submit">{session.trialDays > 0 ? "Start trial" : "Pay"}</button>
      </form>
      <p>
        <a href="/pricing?canceled=1">Cancel</a>
      </p>
    </main>
  );
}
