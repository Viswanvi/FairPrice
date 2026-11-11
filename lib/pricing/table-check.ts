import { feeConfig, priceLevelRatio } from "./data";
import { netAfterFeesCents } from "./fees";
import { feeFloorCents } from "./formula";
import { discountPctFor, validateTable, type CandidateRow, type ValidationResult } from "./validator";

/**
 * Validate a stored table against its product using the current fee config and price levels.
 * The table's own countries are the targets, so older tables stay checkable if the target
 * list changes later.
 */
export function checkStoredRows(
  rows: ReadonlyArray<CandidateRow>,
  product: { baseCents: number; minCents: number; maxDiscountPct: number },
): ValidationResult {
  const countries = rows.map((r) => r.country);
  return validateTable({
    rows,
    product,
    targets: countries,
    ratios: new Map(countries.map((c) => [c, priceLevelRatio(c)])),
    feeFloorCents: feeFloorCents(feeConfig()),
  });
}

/** Derived columns that follow the price: discount and estimated net after fees. */
export function derivedColumns(priceCents: number, baseCents: number, country: string) {
  return {
    discountPct: discountPctFor(priceCents, baseCents),
    netCents: netAfterFeesCents(priceCents, feeConfig(), country),
  };
}
