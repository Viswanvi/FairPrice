import { z } from "zod";
import { biggestDifferences } from "@/lib/seller/format";

/**
 * Formula-versus-AI benchmark (docs/SPEC.md section 7). Pure calculations over one product's
 * two price tables, plus the schema of data/benchmark-results.json. Descriptive numbers only —
 * no claims about conversion or revenue (there is no sales data; the products are invented).
 */

/** "Deep discount" for the low-relevance count (SPEC: discounts above 20%). */
export const DEEP_DISCOUNT_PCT = 20;

const relevance = z.enum(["high", "medium", "low"]);
export type Relevance = z.infer<typeof relevance>;

export const benchmarkRowSchema = z.object({
  country: z.string(),
  region: z.string(),
  /** The AI's relevance rating for this country's region (the formula has none). */
  relevance,
  formulaPriceCents: z.number().int(),
  formulaDiscountPct: z.number(),
  aiPriceCents: z.number().int(),
  aiDiscountPct: z.number(),
  reason: z.string(),
  flags: z.array(z.string()),
});
export type BenchmarkRow = z.infer<typeof benchmarkRowSchema>;

const pair = z.object({ formula: z.number(), ai: z.number() });

export const benchmarkSummarySchema = z.object({
  counts: z.object({
    /** Rows priced below the payment-fee floor. */
    belowFeeFloor: pair,
    /** Rows more than DEEP_DISCOUNT_PCT % off in countries the AI rated low relevance. */
    deepDiscountLowRelevance: pair,
  }),
  /** Mean discount (%) for countries at each relevance level, and how many countries that is. */
  averageDiscountByRelevance: z.record(relevance, z.object({ formula: z.number(), ai: z.number(), countries: z.number().int() })),
  /** The five countries where the AI moved furthest from the formula. */
  biggestDifferences: z.array(z.string()),
});
export type BenchmarkSummary = z.infer<typeof benchmarkSummarySchema>;

export const benchmarkProductSchema = benchmarkSummarySchema.extend({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  description: z.string(),
  baseCents: z.number().int(),
  minCents: z.number().int(),
  maxDiscountPct: z.number(),
  goal: z.enum(["revenue", "reach"]),
  audience: z.object({
    category: z.string(),
    language: z.string(),
    buyerType: z.string(),
    shareability: z.string(),
    regions: z.array(z.object({ region: z.string(), relevance, reason: z.string() })),
  }),
  productSummary: z.string(),
  rows: z.array(benchmarkRowSchema),
  meta: z.object({ fallbackCountries: z.array(z.string()), reasked: z.boolean(), latencyMs: z.number(), models: z.array(z.string()) }),
});
export type BenchmarkProduct = z.infer<typeof benchmarkProductSchema>;

export const benchmarkFileSchema = z.object({
  note: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  feeFloorCents: z.number().int(),
  deepDiscountPct: z.number(),
  products: z.array(benchmarkProductSchema).min(1),
});
export type BenchmarkFile = z.infer<typeof benchmarkFileSchema>;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeBenchmark(rows: ReadonlyArray<BenchmarkRow>, feeFloorCents: number): BenchmarkSummary {
  const below = (pick: (r: BenchmarkRow) => number) => rows.filter((r) => pick(r) < feeFloorCents).length;
  const lowDeep = (pick: (r: BenchmarkRow) => number) =>
    rows.filter((r) => r.relevance === "low" && pick(r) > DEEP_DISCOUNT_PCT).length;

  const averages = Object.fromEntries(
    (["high", "medium", "low"] as const).map((level) => {
      const group = rows.filter((r) => r.relevance === level);
      const mean = (pick: (r: BenchmarkRow) => number) =>
        group.length ? round1(group.reduce((sum, r) => sum + pick(r), 0) / group.length) : 0;
      return [level, { formula: mean((r) => r.formulaDiscountPct), ai: mean((r) => r.aiDiscountPct), countries: group.length }];
    }),
  ) as BenchmarkSummary["averageDiscountByRelevance"];

  return {
    counts: {
      belowFeeFloor: { formula: below((r) => r.formulaPriceCents), ai: below((r) => r.aiPriceCents) },
      deepDiscountLowRelevance: { formula: lowDeep((r) => r.formulaDiscountPct), ai: lowDeep((r) => r.aiDiscountPct) },
    },
    averageDiscountByRelevance: averages,
    biggestDifferences: biggestDifferences(
      rows.map((r) => ({ country: r.country, priceCents: r.aiPriceCents })),
      rows.map((r) => ({ country: r.country, priceCents: r.formulaPriceCents })),
      5,
    ),
  };
}
