import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./hash";

const rows = [
  { country: "IN", priceCents: 3500, discountPct: 65, relevance: "high", reason: "Large developer audience.", flags: [] },
  { country: "BR", priceCents: 4500, discountPct: 55, relevance: "high", reason: "Strong demand for web skills.", flags: [] },
  { country: "US", priceCents: 9900, discountPct: 0, relevance: "high", reason: "Base market.", flags: ["base"] },
];

describe("contentHash", () => {
  it("is a 64-character lowercase hex sha256", () => {
    expect(contentHash(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical rows", () => {
    expect(contentHash(rows)).toBe(contentHash(structuredClone(rows)));
  });

  it("is stable when rows are in a different order", () => {
    expect(contentHash([...rows].reverse())).toBe(contentHash(rows));
  });

  it("is stable when keys are in a different order", () => {
    const reordered = rows.map((r) => ({
      flags: r.flags,
      reason: r.reason,
      relevance: r.relevance,
      discountPct: r.discountPct,
      priceCents: r.priceCents,
      country: r.country,
    }));
    expect(contentHash(reordered)).toBe(contentHash(rows));
  });

  it("changes when a price changes by one cent", () => {
    const changed = rows.map((r) => (r.country === "IN" ? { ...r, priceCents: 3501 } : r));
    expect(contentHash(changed)).not.toBe(contentHash(rows));
  });

  it("changes when a reason, relevance or flag changes", () => {
    const reason = rows.map((r) => (r.country === "BR" ? { ...r, reason: "Different." } : r));
    const relevance = rows.map((r) => (r.country === "BR" ? { ...r, relevance: "low" } : r));
    const flags = rows.map((r) => (r.country === "US" ? { ...r, flags: [] } : r));
    for (const variant of [reason, relevance, flags]) {
      expect(contentHash(variant)).not.toBe(contentHash(rows));
    }
  });

  it("changes when a row is added or removed", () => {
    expect(contentHash(rows.slice(0, 2))).not.toBe(contentHash(rows));
    expect(
      contentHash([...rows, { country: "NG", priceCents: 2900, discountPct: 70, relevance: "medium", reason: "x", flags: [] }]),
    ).not.toBe(contentHash(rows));
  });

  it("keeps flag order significant (flags are data, not a set)", () => {
    const a = [{ country: "IN", priceCents: 3500, flags: ["a", "b"] }];
    const b = [{ country: "IN", priceCents: 3500, flags: ["b", "a"] }];
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});
