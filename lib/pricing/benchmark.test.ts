import { describe, expect, it } from "vitest";
import { summarizeBenchmark, type BenchmarkRow } from "./benchmark";

const row = (country: string, relevance: BenchmarkRow["relevance"], formula: [number, number], ai: [number, number]): BenchmarkRow => ({
  country,
  region: "x",
  relevance,
  formulaPriceCents: formula[0],
  formulaDiscountPct: formula[1],
  aiPriceCents: ai[0],
  aiDiscountPct: ai[1],
  reason: `reason ${country}`,
  flags: [],
});

// A US tax guide: the formula discounts everywhere; the AI keeps low-relevance countries near base.
const rows: BenchmarkRow[] = [
  row("US", "high", [4900, 0], [4900, 0]),
  row("IN", "low", [2450, 50], [4500, 8]),
  row("NG", "low", [2450, 50], [4400, 10]),
  row("BR", "low", [2450, 50], [3900, 20]), // exactly 20% is not "above 20%"
  row("CA", "medium", [4090, 17], [4500, 8]),
  row("DE", "low", [3930, 20], [4600, 6]),
];

describe("summarizeBenchmark", () => {
  const s = summarizeBenchmark(rows, 490);

  it("counts deep discounts (> 20%) in low-relevance countries", () => {
    expect(s.counts.deepDiscountLowRelevance).toEqual({ formula: 3, ai: 0 });
  });

  it("counts rows below the fee floor", () => {
    expect(s.counts.belowFeeFloor).toEqual({ formula: 0, ai: 0 });
    expect(summarizeBenchmark([row("NG", "low", [400, 92], [500, 90])], 490).counts.belowFeeFloor).toEqual({ formula: 1, ai: 0 });
  });

  it("averages the discount per relevance level", () => {
    expect(s.averageDiscountByRelevance).toEqual({
      high: { formula: 0, ai: 0, countries: 1 },
      medium: { formula: 17, ai: 8, countries: 1 },
      low: { formula: 42.5, ai: 11, countries: 4 },
    });
  });

  it("lists the five biggest differences, largest first", () => {
    expect(s.biggestDifferences).toEqual(["IN", "NG", "BR", "DE", "CA"]);
  });

  it("handles a relevance level with no countries", () => {
    expect(summarizeBenchmark([row("US", "high", [100, 0], [100, 0])], 490).averageDiscountByRelevance.low).toEqual({
      formula: 0,
      ai: 0,
      countries: 0,
    });
  });
});
