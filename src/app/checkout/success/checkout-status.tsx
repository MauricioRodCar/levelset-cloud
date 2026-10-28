"use client";

import { useEffect, useState } from "react";

type State = "pending" | "processing" | "ready" | "expired" | "error" | "timeout";

const MESSAGES: Record<State, string> = {
  pending: "Waiting for the payment to be confirmed…",
  processing: "Payment received. Setting up your licence…",
  ready: "Your Pro licence is ready. Sign in with the same email to see your key and manage your devices.",
  expired: "This checkout expired before payment. Nothing was charged.",
  error: "We couldn't check the status right now. Your payment is safe; refresh in a moment.",
  timeout: "This is taking longer than usual. You'll get an email when your licence is ready.",
};

/** Polls the checkout status every 2 s for up to 2 minutes. */
export function CheckoutStatus({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<State>("pending");

  useEffect(() => {
    let stopped = false;
    const started = Date.now();
    async function poll() {
      try {
        const res = await fetch(`/api/v1/checkout/status?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        const body = (await res.json()) as { state?: State };
        if (!res.ok || !body.state) throw new Error();
        if (stopped) return;
        setState(body.state);
        if (body.state === "ready" || body.state === "expired") return;
      } catch {
        if (!stopped) setState("error");
      }
      if (Date.now() - started > 120_000) return setState("timeout");
      if (!stopped) setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
    };
  }, [sessionId]);

  return (
    <p data-testid="checkout-state" data-state={state} role="status">
      {MESSAGES[state]}
    </p>
  );
}
