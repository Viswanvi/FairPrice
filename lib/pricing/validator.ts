/**
 * Price-table validator (docs/SPEC.md section 7). Plain code has the final say on every
 * number the AI (or a seller edit) proposes — CLAUDE.md money-safety rule 5.
 *
 * Errors (the row can't be used):
 *   - price must be a positive whole number of cents
 *   - price ≤ base
 *   - price ≥ max(seller minimum, fee floor) — or exactly base when that floor is above base
 *   - discount ≤ the seller's maximum (price ≥ base × (1 − max%), rounded up)
 *   - every target country exactly once; no other countries
 * Warnings (allowed, shown to the seller):
 *   - a country with a clearly lower price level costs clearly more than one with a higher
 *     price level, and its relevance is not lower (which would explain a smaller discount)
 *
 * Pure: no I/O. discountPct is always recomputed from the price; the input's value is ignored.
 */

export type Relevance = "high" | "medium" | "low";

export interface CandidateRow {
  country: string;
  priceCents: number;
  discountPct?: number;
  relevance: Relevance;
  reason: string;
  flags: string[];
}

export interface ValidatedRow {
  country: string;
  priceCents: number;
  discountPct: number;
  relevance: Relevance;
  reason: string;
  flags: string[];
}

export type ValidationErrorCode =
  | "invalid_price"
  | "not_whole_cents"
  | "below_floor"
  | "above_base"
  | "discount_exceeds_max"
  | "missing_country"
  | "duplicate_country"
  | "unknown_country";

export interface ValidationIssue<C extends string = string> {
  country: string;
  code: C;
  message: string;
}

export interface ValidatorInput {
  rows: ReadonlyArray<CandidateRow>;
  product: { baseCents: number; minCents: number; maxDiscountPct: number };
  /** Every target country must appear exactly once. */
  targets: ReadonlyArray<string>;
  /** Price-level ratio per country (null = no data). */
  ratios: ReadonlyMap<string, number | null>;
  feeFloorCents: number;
}

export interface ValidationResult {
  /** Normalized rows: first occurrence of each target country, in input order. */
  rows: ValidatedRow[];
  errors: ValidationIssue<ValidationErrorCode>[];
  warnings: ValidationIssue<"price_inversion">[];
}

/** Inversions smaller than this are treated as price-ending noise. */
const INVERSION_MIN_GAP_CENTS = 100;
/** Price levels closer than this are treated as equal. */
const INVERSION_MIN_RATIO_GAP = 0.05;
const RELEVANCE_RANK: Record<Relevance, number> = { low: 1, medium: 2, high: 3 };

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function discountPctFor(priceCents: number, baseCents: number): number {
  return Math.round((1 - priceCents / baseCents) * 100);
}

/** Lowest price allowed by the max discount, rounded up so the discount never exceeds it. */
export function maxDiscountFloorCents(baseCents: number, maxDiscountPct: number): number {
  return Math.ceil((baseCents * (100 - maxDiscountPct)) / 100 - 1e-9);
}

function priceError(
  country: string,
  price: number,
  input: ValidatorInput,
): ValidationIssue<ValidationErrorCode> | null {
  const { baseCents, minCents, maxDiscountPct } = input.product;
  const issue = (code: ValidationErrorCode, message: string) => ({ country, code, message });

  if (!Number.isFinite(price) || price <= 0) {
    return issue("invalid_price", `${country}: price must be a positive amount`);
  }
  if (!Number.isInteger(price)) {
    return issue("not_whole_cents", `${country}: price must be a whole number of cents`);
  }
  if (price > baseCents) {
    return issue("above_base", `${country}: ${usd(price)} is above the base price ${usd(baseCents)}`);
  }
  const floor = Math.max(minCents, input.feeFloorCents);
  if (floor > baseCents) {
    if (price < baseCents) {
      return issue(
        "below_floor",
        `${country}: the minimum price (${usd(floor)}) is above the base price, so the base price ${usd(baseCents)} applies`,
      );
    }
    return null;
  }
  if (price < floor) {
    const which = input.feeFloorCents > minCents ? "the fee floor" : "your minimum price";
    return issue("below_floor", `${country}: ${usd(price)} is below ${which} of ${usd(floor)}`);
  }
  if (price < maxDiscountFloorCents(baseCents, maxDiscountPct)) {
    return issue(
      "discount_exceeds_max",
      `${country}: ${usd(price)} is more than ${maxDiscountPct}% off; the lowest allowed is ${usd(maxDiscountFloorCents(baseCents, maxDiscountPct))}`,
    );
  }
  return null;
}

export function validateTable(input: ValidatorInput): ValidationResult {
  const targets = new Set(input.targets.map((t) => t.trim().toUpperCase()));
  const errors: ValidationIssue<ValidationErrorCode>[] = [];
  const rows: ValidatedRow[] = [];
  const seen = new Set<string>();
  const failed = new Set<string>();

  for (const candidate of input.rows) {
    const country = candidate.country.trim().toUpperCase();
    if (!targets.has(country)) {
      errors.push({ country, code: "unknown_country", message: `${country} is not one of the target countries` });
      continue;
    }
    if (seen.has(country)) {
      errors.push({ country, code: "duplicate_country", message: `${country} appears more than once` });
      continue;
    }
    seen.add(country);

    const price = candidate.priceCents;
    const error = priceError(country, price, input);
    if (error) {
      errors.push(error);
      failed.add(country);
    }
    rows.push({
      country,
      priceCents: price,
      discountPct: error ? 0 : discountPctFor(price, input.product.baseCents),
      relevance: candidate.relevance,
      reason: candidate.reason,
      flags: [...candidate.flags],
    });
  }

  for (const target of targets) {
    if (!seen.has(target)) {
      errors.push({ country: target, code: "missing_country", message: `${target} is missing from the table` });
    }
  }

  return { rows, errors, warnings: inversionWarnings(rows.filter((r) => !failed.has(r.country)), input.ratios) };
}

function inversionWarnings(
  rows: ValidatedRow[],
  ratios: ReadonlyMap<string, number | null>,
): ValidationIssue<"price_inversion">[] {
  const withRatio = rows.flatMap((row) => {
    const ratio = ratios.get(row.country);
    return ratio == null ? [] : [{ row, ratio }];
  });

  const warnings: ValidationIssue<"price_inversion">[] = [];
  for (const a of withRatio) {
    let worst: { row: ValidatedRow; ratio: number; gap: number } | null = null;
    for (const b of withRatio) {
      const cheaperPlace = b.ratio - a.ratio > INVERSION_MIN_RATIO_GAP;
      const gap = a.row.priceCents - b.row.priceCents;
      const explained = RELEVANCE_RANK[a.row.relevance] < RELEVANCE_RANK[b.row.relevance];
      if (cheaperPlace && gap > INVERSION_MIN_GAP_CENTS && !explained && (!worst || gap > worst.gap)) {
        worst = { ...b, gap };
      }
    }
    if (worst) {
      warnings.push({
        country: a.row.country,
        code: "price_inversion",
        message:
          `${a.row.country} (price level ${a.ratio.toFixed(2)}) costs ${usd(a.row.priceCents)}, more than ` +
          `${worst.row.country} (price level ${worst.ratio.toFixed(2)}) at ${usd(worst.row.priceCents)}, ` +
          `and its relevance (${a.row.relevance}) doesn't explain the difference. Check the reason: "${a.row.reason}"`,
      });
    }
  }
  return warnings;
}
