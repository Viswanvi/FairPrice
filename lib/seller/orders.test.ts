import { describe, expect, it } from "vitest";
import { DECISION_INFO, DECISIONS, relativeTime, summarizeOrders, type OrderLike } from "./orders";

describe("summarizeOrders", () => {
  it("counts orders, captured money, not-charged and decisions", () => {
    const orders: OrderLike[] = [
      { status: "CAPTURED", decision: "MATCH", chargedCents: 3500 },
      { status: "CAPTURED", decision: "TRAVELER", chargedCents: 3500 },
      { status: "VOIDED", decision: "MISMATCH", chargedCents: 0 },
      { status: "VOIDED", decision: "UNCLEAR", chargedCents: null },
      { status: "DECLINED", decision: null, chargedCents: null },
      { status: "NEEDS_REVIEW", decision: "MATCH", chargedCents: null },
      { status: "CREATED", decision: null, chargedCents: null },
    ];
    expect(summarizeOrders(orders)).toEqual({
      total: 7,
      captured: 2,
      capturedCents: 7000,
      notCharged: 3,
      needsReview: 1,
      inProgress: 1,
      byDecision: { MATCH: 2, TRAVELER: 1, MISMATCH: 1, UNCLEAR: 1, NOT_PAYPAL: 0 },
    });
  });

  it("handles no orders", () => {
    expect(summarizeOrders([])).toMatchObject({ total: 0, capturedCents: 0 });
  });
});

describe("DECISION_INFO", () => {
  it("has a label for every decision and never accuses", () => {
    for (const d of DECISIONS) {
      const { label, help } = DECISION_INFO[d];
      expect(label).toBeTruthy();
      expect(`${label} ${help}`).not.toMatch(/vpn|fraud|cheat|abuse/i);
    }
  });

  it("says whether money moved for every decision", () => {
    for (const d of ["MISMATCH", "UNCLEAR", "NOT_PAYPAL"] as const) {
      expect(DECISION_INFO[d].help).toMatch(/^Not charged\./);
    }
    for (const d of ["MATCH", "TRAVELER"] as const) {
      expect(DECISION_INFO[d].help).toMatch(/Paid|Charged/);
    }
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const ago = (s: number) => new Date(now - s * 1000).toISOString();

  it.each([
    [3, "just now"],
    [42, "42s ago"],
    [5 * 60, "5 min ago"],
    [3 * 3600, "3 h ago"],
    [2 * 86400, "2 d ago"],
  ])("%is → %s", (seconds, expected) => {
    expect(relativeTime(ago(seconds), now)).toBe(expected);
  });

  it("treats future timestamps (clock skew) as just now", () => {
    expect(relativeTime(ago(-30), now)).toBe("just now");
  });
});
