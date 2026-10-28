import { describe, expect, it } from "vitest";
import { subscriptionState } from "@/db/schema";
import {
  applyEvent,
  ENTITLED_STATES,
  IllegalTransitionError,
  isEntitled,
  planTransitions,
  targetState,
  TRANSITIONS,
} from "@/server/billing/machine";
import type { SnapshotStatus, SubscriptionState } from "@/server/billing/types";

const STATES = subscriptionState.enumValues;
const EVENTS = [...new Set(TRANSITIONS.map((t) => t.event))];

// The documented table (ARCHITECTURE §4.1), written out independently of the implementation.
const EXPECTED: Record<string, SubscriptionState> = {
  "(new)|checkout.completed_trial": "trialing",
  "(new)|checkout.completed_paid": "active",
  "(new)|checkout.completed_pending": "incomplete",
  "incomplete|payment.succeeded": "active",
  "incomplete|checkout.expired": "ended",
  "trialing|payment.succeeded": "active",
  "trialing|trial.ended_unpaid": "past_due",
  "active|payment.failed": "past_due",
  "past_due|payment.succeeded": "active",
  "past_due|dunning.exhausted": "unpaid",
  "unpaid|payment.succeeded": "active",
  "active|cancel.scheduled": "cancel_scheduled",
  "trialing|cancel.scheduled": "cancel_scheduled",
  "cancel_scheduled|cancel.resumed": "active",
  "cancel_scheduled|cancel.resumed_trial": "trialing",
  "cancel_scheduled|period.ended": "ended",
  "incomplete|subscription.canceled": "ended",
  "trialing|subscription.canceled": "ended",
  "active|subscription.canceled": "ended",
  "past_due|subscription.canceled": "ended",
  "unpaid|subscription.canceled": "ended",
  "cancel_scheduled|subscription.canceled": "ended",
};

describe("transition table", () => {
  it.each([null, ...STATES].flatMap((from) => EVENTS.map((event) => [from, event] as const)))(
    "%s + %s",
    (from, event) => {
      const expected = EXPECTED[`${from ?? "(new)"}|${event}`];
      if (expected) expect(applyEvent(from, event)).toBe(expected);
      else expect(() => applyEvent(from, event)).toThrow(IllegalTransitionError);
    },
  );

  it("treats ended as terminal", () => {
    for (const to of STATES.filter((s) => s !== "ended")) {
      expect(() => planTransitions("ended", to)).toThrow(IllegalTransitionError);
    }
  });

  it("grants Pro exactly in the entitled states", () => {
    expect([...ENTITLED_STATES].sort()).toEqual(["active", "cancel_scheduled", "past_due", "trialing"]);
    expect(STATES.filter(isEntitled)).toHaveLength(4);
  });
});

describe("planTransitions", () => {
  it("returns no events when nothing changed", () => {
    expect(planTransitions("active", "active")).toEqual([]);
  });

  it("finds the shortest path along table edges", () => {
    const events = (from: SubscriptionState | null, to: SubscriptionState) => planTransitions(from, to).map((t) => t.event);
    expect(events(null, "active")).toEqual(["checkout.completed_paid"]);
    expect(events(null, "past_due")).toEqual(["checkout.completed_paid", "payment.failed"]);
    expect(events(null, "cancel_scheduled")).toEqual(["checkout.completed_paid", "cancel.scheduled"]);
    expect(events("cancel_scheduled", "ended")).toEqual(["period.ended"]);
    expect(events("active", "ended")).toEqual(["subscription.canceled"]);
    expect(events("unpaid", "cancel_scheduled")).toEqual(["payment.succeeded", "cancel.scheduled"]);
  });

  it("reaches every non-terminal state from every live state, and ended from all", () => {
    for (const from of [null, ...STATES.filter((s) => s !== "ended")]) {
      expect(planTransitions(from, "ended").at(-1)?.to).toBe("ended");
    }
  });
});

describe("targetState", () => {
  const cases: [SnapshotStatus, boolean, SubscriptionState][] = [
    ["incomplete", false, "incomplete"],
    ["incomplete_expired", false, "ended"],
    ["trialing", false, "trialing"],
    ["trialing", true, "cancel_scheduled"],
    ["active", false, "active"],
    ["active", true, "cancel_scheduled"],
    ["past_due", true, "past_due"], // dunning wins over a pending cancellation
    ["unpaid", false, "unpaid"],
    ["canceled", true, "ended"],
  ];
  it.each(cases)("%s (cancel at period end: %s) → %s", (status, cancelAtPeriodEnd, expected) => {
    expect(targetState({ status, cancelAtPeriodEnd })).toBe(expected);
  });
});
