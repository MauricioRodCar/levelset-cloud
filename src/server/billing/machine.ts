import { AppError } from "@/server/platform/errors";
import type { SnapshotStatus, SubscriptionSnapshot, SubscriptionState } from "./types";

/**
 * Subscription lifecycle as a transition table (ARCHITECTURE §4.1). The table
 * is the single source of truth: events are applied only along its edges, and
 * a provider snapshot is turned into events by finding the shortest path from
 * the stored state to the snapshot's state. Anything off the table is rejected.
 */

type From = SubscriptionState | null; // null = not yet known locally

export type Transition = { from: From; event: string; to: SubscriptionState };

const LIVE_STATES = ["incomplete", "trialing", "active", "past_due", "unpaid", "cancel_scheduled"] as const;

/**
 * Order matters only to break ties between equally short paths (earlier wins).
 * A subscription first seen in a later state (lost or reordered webhooks) is
 * assumed to have started paid, unless the provider says it is trialing.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: null, event: "checkout.completed_paid", to: "active" },
  { from: null, event: "checkout.completed_trial", to: "trialing" },
  { from: null, event: "checkout.completed_pending", to: "incomplete" },
  { from: "incomplete", event: "payment.succeeded", to: "active" },
  { from: "incomplete", event: "checkout.expired", to: "ended" },
  { from: "trialing", event: "payment.succeeded", to: "active" },
  { from: "trialing", event: "trial.ended_unpaid", to: "past_due" },
  { from: "active", event: "payment.failed", to: "past_due" },
  { from: "past_due", event: "payment.succeeded", to: "active" },
  { from: "past_due", event: "dunning.exhausted", to: "unpaid" },
  { from: "unpaid", event: "payment.succeeded", to: "active" },
  { from: "active", event: "cancel.scheduled", to: "cancel_scheduled" },
  { from: "trialing", event: "cancel.scheduled", to: "cancel_scheduled" },
  { from: "cancel_scheduled", event: "cancel.resumed", to: "active" },
  { from: "cancel_scheduled", event: "cancel.resumed_trial", to: "trialing" },
  { from: "cancel_scheduled", event: "period.ended", to: "ended" },
  // Immediate cancellation (refund, unpaid end, admin) from any live state.
  ...LIVE_STATES.map((from) => ({ from, event: "subscription.canceled", to: "ended" as const })),
];

/** Pro access while trialing, active, cancelled-but-paid-up, or in dunning grace (FR-9). */
export const ENTITLED_STATES: ReadonlySet<SubscriptionState> = new Set(["trialing", "active", "cancel_scheduled", "past_due"]);

export function isEntitled(state: SubscriptionState): boolean {
  return ENTITLED_STATES.has(state);
}

export class IllegalTransitionError extends AppError {
  constructor(
    readonly from: From,
    readonly to: SubscriptionState | null,
    readonly event?: string,
    /** Local subscription, when known (for the audit entry). */
    readonly subscriptionId?: string,
  ) {
    super(
      "illegal_transition",
      409,
      event
        ? `Event ${event} is not allowed in state ${from ?? "(new)"}`
        : `No transition from ${from ?? "(new)"} to ${to ?? "?"}`,
    );
  }
}

export function applyEvent(from: From, event: string): SubscriptionState {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event);
  if (!t) throw new IllegalTransitionError(from, null, event);
  return t.to;
}

/** Shortest event path from `from` to `to` (breadth-first over the table). */
export function planTransitions(from: From, to: SubscriptionState): Transition[] {
  if (from === to) return [];
  const queue: { state: From; path: Transition[] }[] = [{ state: from, path: [] }];
  const seen = new Set<From>([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const t of TRANSITIONS) {
      if (t.from !== state || seen.has(t.to)) continue;
      const next = [...path, t];
      if (t.to === to) return next;
      seen.add(t.to);
      queue.push({ state: t.to, path: next });
    }
  }
  throw new IllegalTransitionError(from, to);
}

const STATUS_TO_STATE: Record<SnapshotStatus, SubscriptionState> = {
  incomplete: "incomplete",
  incomplete_expired: "ended",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "ended",
};

/** Where the provider says the subscription is now. A pending cancellation only applies to paid-up states. */
export function targetState(snapshot: Pick<SubscriptionSnapshot, "status" | "cancelAtPeriodEnd">): SubscriptionState {
  const state = STATUS_TO_STATE[snapshot.status];
  if (snapshot.cancelAtPeriodEnd && (state === "active" || state === "trialing")) return "cancel_scheduled";
  return state;
}
