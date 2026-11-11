import { describe, expect, it } from "vitest";
import { validateTable, type CandidateRow, type ValidatorInput } from "./validator";

// Demo product: $99 base, $15 minimum, 70% max discount → max-discount floor $29.70.
// Fee floor $4.90. Effective floor = max($15, $4.90) = $15, and discount ≤ 70% → ≥ $29.70.
const product = { baseCents: 9900, minCents: 1500, maxDiscountPct: 70 };
const targets = ["US", "BR", "IN"];
const ratios = new Map<string, number | null>([
  ["US", 1],
  ["BR", 0.46],
  ["IN", 0.23],
]);

function row(country: string, priceCents: number, extra: Partial<CandidateRow> = {}): CandidateRow {
  return { country, priceCents, relevance: "high", reason: `Reason for ${country}.`, flags: [], ...extra };
}

const goodRows = [row("US", 9900), row("BR", 4900), row("IN", 3500)];

function input(overrides: Partial<ValidatorInput> = {}): ValidatorInput {
  return { rows: goodRows, product, targets, ratios, feeFloorCents: 490, ...overrides };
}

const codes = (r: ReturnType<typeof validateTable>) => r.errors.map((e) => `${e.country}:${e.code}`);

describe("validateTable — valid tables", () => {
  it("accepts a valid table with no errors or warnings", () => {
    const r = validateTable(input());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.rows.map((x) => x.country)).toEqual(["US", "BR", "IN"]);
  });

  it("recomputes discountPct from the price instead of trusting the input", () => {
    const r = validateTable(input({ rows: [row("US", 9900, { discountPct: 50 }), row("BR", 4900, { discountPct: 0 }), row("IN", 3500)] }));
    expect(r.rows.map((x) => x.discountPct)).toEqual([0, 51, 65]);
  });

  it("normalizes country codes to upper case", () => {
    const r = validateTable(input({ rows: [row("us", 9900), row(" br ", 4900), row("In", 3500)] }));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.country)).toEqual(["US", "BR", "IN"]);
  });

  it("accepts a price exactly at the max-discount floor ($29.70 = 70% off)", () => {
    const r = validateTable(input({ rows: [row("US", 9900), row("BR", 4900), row("IN", 2970)] }));
    expect(r.errors).toEqual([]);
  });
});

describe("validateTable — floors and caps (errors)", () => {
  it("rejects a price below the seller minimum", () => {
    const p = { ...product, maxDiscountPct: 95 }; // so only the $15 minimum applies
    expect(codes(validateTable(input({ product: p, rows: [row("US", 9900), row("BR", 4900), row("IN", 1499)] })))).toEqual([
      "IN:below_floor",
    ]);
  });

  it("rejects a price below the fee floor when it is higher than the seller minimum", () => {
    const p = { baseCents: 1900, minCents: 100, maxDiscountPct: 95 };
    const r = validateTable(input({ product: p, rows: [row("US", 1900), row("BR", 900), row("IN", 489)] }));
    expect(codes(r)).toEqual(["IN:below_floor"]);
    expect(r.errors[0].message).toContain("$4.90");
  });

  it("rejects a price above base", () => {
    expect(codes(validateTable(input({ rows: [row("US", 9901), row("BR", 4900), row("IN", 3500)] })))).toEqual([
      "US:above_base",
    ]);
  });

  it("rejects a discount above the maximum", () => {
    expect(codes(validateTable(input({ rows: [row("US", 9900), row("BR", 4900), row("IN", 2969)] })))).toEqual([
      "IN:discount_exceeds_max",
    ]);
  });

  it("when every floor is above base, only the base price is allowed", () => {
    const p = { baseCents: 400, minCents: 100, maxDiscountPct: 70 }; // fee floor $4.90 > $4.00 base
    expect(validateTable(input({ product: p, rows: [row("US", 400), row("BR", 400), row("IN", 400)] })).errors).toEqual([]);
    expect(codes(validateTable(input({ product: p, rows: [row("US", 400), row("BR", 400), row("IN", 399)] })))).toEqual([
      "IN:below_floor",
    ]);
  });

  it("rejects fractional cents", () => {
    expect(codes(validateTable(input({ rows: [row("US", 9900), row("BR", 4900.5), row("IN", 3500)] })))).toEqual([
      "BR:not_whole_cents",
    ]);
  });

  it("rejects zero, negative and non-numeric prices", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codes(validateTable(input({ rows: [row("US", 9900), row("BR", bad), row("IN", 3500)] })))).toEqual([
        "BR:invalid_price",
      ]);
    }
  });
});

describe("validateTable — country coverage (errors)", () => {
  it("rejects a missing target country", () => {
    expect(codes(validateTable(input({ rows: [row("US", 9900), row("IN", 3500)] })))).toEqual(["BR:missing_country"]);
  });

  it("rejects a duplicated country", () => {
    expect(
      codes(validateTable(input({ rows: [row("US", 9900), row("BR", 4900), row("IN", 3500), row("IN", 3600)] }))),
    ).toEqual(["IN:duplicate_country"]);
  });

  it("rejects a country that isn't a target", () => {
    expect(
      codes(validateTable(input({ rows: [row("US", 9900), row("BR", 4900), row("IN", 3500), row("FR", 7900)] }))),
    ).toEqual(["FR:unknown_country"]);
  });

  it("returns valid rows even when other rows fail, so callers can keep them", () => {
    const r = validateTable(input({ rows: [row("US", 9900), row("BR", 9999), row("IN", 3500)] }));
    expect(codes(r)).toEqual(["BR:above_base"]);
    expect(r.rows.map((x) => x.country)).toEqual(["US", "BR", "IN"]);
  });

  it("reports every problem at once", () => {
    const r = validateTable(input({ rows: [row("US", 10000), row("IN", 100)] }));
    expect(codes(r).sort()).toEqual(["BR:missing_country", "IN:below_floor", "US:above_base"]);
  });
});

describe("validateTable — price inversion warnings", () => {
  it("warns when a lower-price-level country costs more and relevance doesn't explain it", () => {
    // IN (0.23) at $50 vs BR (0.46) at $30, both high relevance.
    const r = validateTable(input({ rows: [row("US", 9900), row("BR", 3000), row("IN", 5000)] }));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ country: "IN", code: "price_inversion" });
    expect(r.warnings[0].message).toContain("BR");
  });

  it("doesn't warn when the pricier country is less relevant (that explains a smaller discount)", () => {
    const r = validateTable(
      input({ rows: [row("US", 9900), row("BR", 3000, { relevance: "high" }), row("IN", 5000, { relevance: "low" })] }),
    );
    expect(r.warnings).toEqual([]);
  });

  it("ignores small gaps from price endings (≤ $1)", () => {
    const r = validateTable(input({ rows: [row("US", 9900), row("BR", 3400), row("IN", 3499)] }));
    expect(r.warnings).toEqual([]);
  });

  it("ignores countries with nearly the same price level", () => {
    const close = new Map<string, number | null>([["US", 1], ["BR", 0.25], ["IN", 0.23]]);
    const r = validateTable(input({ ratios: close, rows: [row("US", 9900), row("BR", 3000), row("IN", 5000)] }));
    expect(r.warnings).toEqual([]);
  });

  it("skips countries without price-level data", () => {
    const noData = new Map<string, number | null>([["US", 1], ["BR", null], ["IN", 0.23]]);
    const r = validateTable(input({ ratios: noData, rows: [row("US", 9900), row("BR", 3000), row("IN", 5000)] }));
    expect(r.warnings).toEqual([]);
  });

  it("gives at most one warning per country", () => {
    const four = ["US", "BR", "MX", "IN"];
    const r4 = new Map<string, number | null>([["US", 1], ["BR", 0.46], ["MX", 0.54], ["IN", 0.23]]);
    const r = validateTable(
      input({ targets: four, ratios: r4, rows: [row("US", 9900), row("BR", 3000), row("MX", 3200), row("IN", 6000)] }),
    );
    expect(r.warnings.filter((w) => w.country === "IN")).toHaveLength(1);
  });
});
