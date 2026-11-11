import { describe, expect, it } from "vitest";
import { feeConfig, priceLevelRatio, priceLevels, REGIONS, targetCountries } from "./data";
import { feeFloorCents, formulaTable } from "./formula";

// Sanity checks on the committed data files (Phase 8 verify gate, automated).
describe("data/price-levels.json", () => {
  it("covers most of the world", () => {
    expect(priceLevels().size).toBeGreaterThan(150);
  });

  it("has the US at exactly 1", () => {
    expect(priceLevelRatio("US")).toBe(1);
  });

  it("has India well below 1", () => {
    expect(priceLevelRatio("IN")).toBeGreaterThan(0.1);
    expect(priceLevelRatio("IN")).toBeLessThan(0.5);
  });

  it("has sensible ratios everywhere", () => {
    for (const level of priceLevels().values()) {
      expect(level.ratio).toBeGreaterThanOrEqual(0.05);
      expect(level.ratio).toBeLessThanOrEqual(3);
      expect(level.ratio).toBeCloseTo(level.ppp / level.fx, 3);
    }
  });

  it("returns null for countries without data", () => {
    expect(priceLevelRatio("ZZ")).toBeNull();
  });
});

describe("data/target-countries.json", () => {
  const targets = targetCountries();

  it("has about 40 unique countries", () => {
    expect(targets.length).toBeGreaterThanOrEqual(35);
    expect(targets.length).toBeLessThanOrEqual(45);
    expect(new Set(targets.map((t) => t.code)).size).toBe(targets.length);
  });

  it("includes every market the SPEC names", () => {
    const codes = new Set(targets.map((t) => t.code));
    for (const code of ["IN", "BR", "US", "NG", "ID", "MX", "PH", "PK", "EG", "VN", "DE", "GB", "FR", "JP"]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("covers every region", () => {
    expect(new Set(targets.map((t) => t.region))).toEqual(new Set(REGIONS));
  });

  it("has World Bank data for every target", () => {
    for (const t of targets) expect(priceLevelRatio(t.code), t.code).not.toBeNull();
  });
});

describe("data/fees.json", () => {
  it("gives a fee floor between $1 and $10", () => {
    const floor = feeFloorCents(feeConfig());
    expect(floor).toBeGreaterThan(100);
    expect(floor).toBeLessThan(1000);
  });

  it("prices the demo bootcamp sensibly across the targets", () => {
    const rows = formulaTable(
      { baseCents: 9900, minCents: 1500, maxDiscountPct: 70 },
      targetCountries().map((t) => ({ code: t.code, ratio: priceLevelRatio(t.code) })),
      feeConfig(),
    );
    const price = (code: string) => rows.find((r) => r.country === code)?.priceCents;
    expect(price("US")).toBe(9900);
    expect(price("IN")).toBeLessThan(4000);
    expect(price("IN")).toBeGreaterThanOrEqual(2970); // 70% max discount
    expect(rows.every((r) => !r.flags.includes("no_data"))).toBe(true);
  });
});
