import { CheckoutStatus } from "./checkout-status";

// FR-4: after payment. The licence is created by the webhook; this page only waits for it.
export const dynamic = "force-dynamic";

export default async function CheckoutSuccess({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id: sessionId } = await searchParams;
  return (
    <main className="card">
      <h1>Thanks for subscribing</h1>
      {sessionId ? <CheckoutStatus sessionId={sessionId} /> : <p className="error">Missing checkout session.</p>}
    </main>
  );
}
