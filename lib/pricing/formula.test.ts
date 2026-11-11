import { describe, expect, it } from "vitest";
import {
  feeFloorCents,
  FormulaInputError,
  formulaMultiplier,
  formulaPrice,
  formulaTable,
  type FeeConfig,
  type FormulaInput,
} from "./formula";

// Illustrative fee config: 3.49% + $0.49, +1.5% international, fees may take at most 15%.
// feeFloor = 0.49 / (0.15 - 0.0349 - 0.015) = $4.895… → 490 cents (rounded UP so fees never exceed 15%).
const fees: FeeConfig = { percent: 0.0349, fixedUsd: 0.49, intlPercent: 0.015, maxFeeShare: 0.15 };

function input(overrides: Partial<FormulaInput> = {}): FormulaInput {
  return { baseCents: 9900, minCents: 1500, maxDiscountPct: 70, ratio: 0.6, strength: 1, fees, ...overrides };
}

describe("formulaMultiplier — M = 1 + s × (ratio − 1)", () => {
  it("s = 0 ignores the price level", () => {
    expect(formulaMultiplier(0.25, 0)).toBe(1);
  });

  it("s = 1 follows the price level fully", () => {
    expect(formulaMultiplier(0.25, 1)).toBe(0.25);
  });

  it("s = 0.5 goes halfway", () => {
    expect(formulaMultiplier(0.3, 0.5)).toBeCloseTo(0.65, 10);
  });

  it("is above 1 for countries pricier than the US", () => {
    expect(formulaMultiplier(1.4, 1)).toBe(1.4);
  });

  it("rejects strength outside [0, 1] and non-positive ratios", () => {
    expect(() => formulaMultiplier(0.5, -0.1)).toThrow(FormulaInputError);
    expect(() => formulaMultiplier(0.5, 1.1)).toThrow(FormulaInputError);
    expect(() => formulaMultiplier(0, 1)).toThrow(FormulaInputError);
    expect(() => formulaMultiplier(Number.NaN, 1)).toThrow(FormulaInputError);
  });
});

describe("feeFloorCents — fixedUsd / (maxFeeShare − percent − intlPercent)", () => {
  it("computes the floor in whole cents, rounded up", () => {
    expect(feeFloorCents(fees)).toBe(490);
  });

  it("is zero when there is no fixed fee", () => {
    expect(feeFloorCents({ ...fees, fixedUsd: 0 })).toBe(0);
  });

  it("throws when percentage fees alone exceed the allowed fee share", () => {
    expect(() => feeFloorCents({ ...fees, maxFeeShare: 0.04 })).toThrow(FormulaInputError);
    expect(() => feeFloorCents({ ...fees, maxFeeShare: 0.0499 })).toThrow(FormulaInputError);
  });
});

describe("formulaPrice", () => {
  it("US (ratio 1) pays the base price, no discount", () => {
    expect(formulaPrice(input({ ratio: 1 }))).toMatchObject({ priceCents: 9900, discountPct: 0, boundBy: null });
  });

  it("never prices above base, even in pricier countries", () => {
    expect(formulaPrice(input({ ratio: 1.4 }))).toMatchObject({ priceCents: 9900, discountPct: 0, boundBy: "base" });
  });

  it("follows the price level when no limit applies", () => {
    expect(formulaPrice(input({ ratio: 0.6 }))).toMatchObject({ priceCents: 5940, discountPct: 40, boundBy: null });
  });

  it("applies the strength s", () => {
    // M = 1 + 0.5 × (0.4 − 1) = 0.7 → 6930
    expect(formulaPrice(input({ ratio: 0.4, strength: 0.5 })).priceCents).toBe(6930);
  });

  it("clamps to the max-discount floor (India-like ratio)", () => {
    // 9900 × 0.25 = 2475 < 9900 × 30% = 2970
    expect(formulaPrice(input({ ratio: 0.25 }))).toMatchObject({
      priceCents: 2970,
      discountPct: 70,
      floorCents: 2970,
      boundBy: "max_discount",
    });
  });

  it("clamps to the seller minimum when it is the highest floor", () => {
    expect(formulaPrice(input({ minCents: 6000, ratio: 0.4 }))).toMatchObject({
      priceCents: 6000,
      boundBy: "min_price",
    });
  });

  it("clamps to the fee floor when it is the highest floor", () => {
    expect(
      formulaPrice(input({ baseCents: 1000, minCents: 100, maxDiscountPct: 90, ratio: 0.2 })),
    ).toMatchObject({ priceCents: 490, discountPct: 51, boundBy: "fee_floor" });
  });

  it("keeps the base price when every floor is above it", () => {
    expect(formulaPrice(input({ baseCents: 400, minCents: 100, ratio: 0.3 }))).toMatchObject({
      priceCents: 400,
      discountPct: 0,
      boundBy: "floor_above_base",
    });
  });

  it("rounds to whole cents", () => {
    // 1999 × 0.333 = 665.667 → 666
    const r = formulaPrice(input({ baseCents: 1999, minCents: 100, ratio: 0.333, fees: { ...fees, fixedUsd: 0 } }));
    expect(r.priceCents).toBe(666);
    expect(Number.isInteger(r.priceCents)).toBe(true);
  });

  it("rounds the max-discount floor UP so the discount never exceeds the maximum", () => {
    // 1999 × 30% = 599.7 → 600 (discount 69.98%, shown as 70)
    const r = formulaPrice(input({ baseCents: 1999, minCents: 100, ratio: 0.1, fees: { ...fees, fixedUsd: 0 } }));
    expect(r).toMatchObject({ priceCents: 600, discountPct: 70, boundBy: "max_discount" });
  });

  it("a 0% maximum discount always charges base", () => {
    expect(formulaPrice(input({ maxDiscountPct: 0, ratio: 0.3 })).priceCents).toBe(9900);
  });

  it("rejects invalid seller inputs", () => {
    for (const bad of [
      { baseCents: 0 },
      { baseCents: 99.5 },
      { minCents: -1 },
      { minCents: 10.5 },
      { maxDiscountPct: 101 },
      { maxDiscountPct: -5 },
      { ratio: -0.2 },
      { strength: 2 },
    ]) {
      expect(() => formulaPrice(input(bad))).toThrow(FormulaInputError);
    }
  });

  it("invariants: whole cents, never above base, discount within the maximum, at or above every floor unless above base", () => {
    for (const ratio of [0.05, 0.2, 0.33, 0.5, 0.77, 1, 1.3]) {
      for (const strength of [0, 0.25, 0.5, 1]) {
        for (const [baseCents, minCents, maxDiscountPct] of [
          [9900, 1500, 70],
          [1999, 400, 60],
          [4900, 1500, 50],
          [500, 100, 80],
        ]) {
          const r = formulaPrice(input({ ratio, strength, baseCents, minCents, maxDiscountPct }));
          expect(Number.isInteger(r.priceCents)).toBe(true);
          expect(r.priceCents).toBeLessThanOrEqual(baseCents);
          expect(r.discountPct).toBeLessThanOrEqual(maxDiscountPct);
          if (r.floorCents <= baseCents) expect(r.priceCents).toBeGreaterThanOrEqual(r.floorCents);
        }
      }
    }
  });
});

describe("formulaTable", () => {
  const product = { baseCents: 9900, minCents: 1500, maxDiscountPct: 70 };

  it("prices every country and flags the limit that applied", () => {
    const rows = formulaTable(product, [
      { code: "US", ratio: 1 },
      { code: "IN", ratio: 0.25 },
      { code: "BR", ratio: 0.6 },
    ], fees);
    expect(rows).toEqual([
      { country: "US", priceCents: 9900, discountPct: 0, flags: [] },
      { country: "IN", priceCents: 2970, discountPct: 70, flags: ["max_discount"] },
      { country: "BR", priceCents: 5940, discountPct: 40, flags: [] },
    ]);
  });

  it("uses the base price and flags no_data when a country has no ratio", () => {
    expect(formulaTable(product, [{ code: "XK", ratio: null }], fees)).toEqual([
      { country: "XK", priceCents: 9900, discountPct: 0, flags: ["no_data"] },
    ]);
  });
});
