"use client";

import { useState } from "react";

type Offer = { key: string; label: string; price: string };

/** Starts checkout. One Idempotency-Key per form, so a double click or retry never opens two sessions (FR-3). */
export function CheckoutForm({ offers }: { offers: Offer[] }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [planKey, setPlanKey] = useState(offers[0]?.key ?? "");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ plan_key: planKey, email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.title ?? "Checkout could not start");
      window.location.assign(body.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout could not start");
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ gridColumn: "span 2" }}>
      <h2>Pro</h2>
      <div className="grid" role="radiogroup" aria-label="Billing period">
        {offers.map((o) => (
          <label key={o.key} className="card plan">
            <span>
              <input type="radio" name="plan" value={o.key} checked={planKey === o.key} onChange={() => setPlanKey(o.key)} /> {o.label}
            </span>
            <span className="price">{o.price}</span>
          </label>
        ))}
      </div>
      <label className="field">
        Email for your licence
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !planKey}>
        {busy ? "Starting checkout…" : "Continue to payment"}
      </button>
    </form>
  );
}
