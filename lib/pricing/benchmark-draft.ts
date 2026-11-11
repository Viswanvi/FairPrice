import { audienceProfileSchema, type AudienceProfile } from "./ai";
import type { BenchmarkProduct } from "./benchmark";
import { feeConfig, priceLevelRatio, targetCountries } from "./data";
import { netAfterFeesCents } from "./fees";
import { feeFloorCents, formulaTable, type FormulaRowResult } from "./formula";
import { validateTable, type ValidatedRow } from "./validator";

/**
 * Rebuild, for one benchmark product, the DRAFT price table a seller would get from the AI
 * path, using the AI prices already committed in data/benchmark-results.json rather than a new
 * AI call (the seed uses this so judges can try the benchmark products at no AI cost).
 *
 * Same shape as POST /api/products/:id/price-tables stores: validator rows plus region,
 * formula price and net after fees, with the formula table as the baseline. The formula is
 * recomputed and every AI price goes through the validator again; stale or rule-breaking
 * data throws instead of being seeded. It is only a draft: a seller must still approve it
 * (CLAUDE.md rule 5), and approval runs the validator once more.
 *
 * Pure apart from reading the bundled data files.
 */

export interface BenchmarkDraftRow extends ValidatedRow {
  region: string;
  formulaPriceCents: number;
  netCents: number;
}

export interface BenchmarkDraft {
  audienceProfile: AudienceProfile;
  rows: BenchmarkDraftRow[];
  formulaRows: FormulaRowResult[];
}

export class BenchmarkDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkDraftError";
  }
}

export function benchmarkDraft(product: BenchmarkProduct): BenchmarkDraft {
  const targets = targetCountries();
  const ratios = new Map(targets.map((t) => [t.code, priceLevelRatio(t.code)]));
  const fees = feeConfig();
  const limits = { baseCents: product.baseCents, minCents: product.minCents, maxDiscountPct: product.maxDiscountPct };

  const profile = audienceProfileSchema.safeParse(product.audience);
  if (!profile.success) {
    throw new BenchmarkDraftError(`${product.id}: the committed audience profile doesn't match the current schema.`);
  }

  const formulaRows = formulaTable(
    limits,
    targets.map((t) => ({ code: t.code, ratio: ratios.get(t.code) ?? null })),
    fees,
  );

  // The committed formula prices must equal today's formula on today's data, or the AI prices
  // were chosen against different numbers and the benchmark should be re-run.
  const committed = new Map(product.rows.map((r) => [r.country, r]));
  const stale = formulaRows.filter((f) => committed.get(f.country)?.formulaPriceCents !== f.priceCents);
  if (stale.length > 0) {
    throw new BenchmarkDraftError(
      `${product.id}: data/benchmark-results.json is out of date for ${stale.map((f) => f.country).join(", ")} ` +
        "(run npm run benchmark again).",
    );
  }

  const checked = validateTable({
    rows: product.rows.map((r) => ({
      country: r.country,
      priceCents: r.aiPriceCents,
      relevance: r.relevance,
      reason: r.reason,
      flags: r.flags,
    })),
    product: limits,
    targets: targets.map((t) => t.code),
    ratios,
    feeFloorCents: feeFloorCents(fees),
  });
  if (checked.errors.length > 0) {
    throw new BenchmarkDraftError(`${product.id}: ${checked.errors.map((e) => e.message).join("; ")}`);
  }

  const regionOf = new Map(targets.map((t) => [t.code, t.region]));
  const formulaOf = new Map(formulaRows.map((f) => [f.country, f.priceCents]));
  return {
    audienceProfile: profile.data,
    rows: checked.rows.map((r) => ({
      ...r,
      region: regionOf.get(r.country)!,
      formulaPriceCents: formulaOf.get(r.country)!,
      netCents: netAfterFeesCents(r.priceCents, fees, r.country),
    })),
    formulaRows,
  };
}
