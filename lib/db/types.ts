import { z } from "zod";

/**
 * Shapes of the JSON stored in price_tables.rows and price_tables.formula_rows.
 * Amounts are integer cents. Extra keys are kept (loose objects) so later phases can add
 * fields such as net-after-fees without a migration; the content hash covers them too.
 */

const country = z
  .string()
  .regex(/^[A-Z]{2}$/, { error: "country must be an upper-case ISO 3166-1 alpha-2 code" });
const cents = z.number().int({ error: "must be whole cents" }).positive();
const discountPct = z.number().min(0).max(100);

export const relevanceSchema = z.enum(["high", "medium", "low"]);
export type Relevance = z.infer<typeof relevanceSchema>;

export const priceRowSchema = z.looseObject({
  country,
  priceCents: cents,
  discountPct,
  relevance: relevanceSchema,
  reason: z.string(),
  flags: z.array(z.string()),
});
export type PriceRow = z.infer<typeof priceRowSchema>;

export const formulaRowSchema = z.looseObject({
  country,
  priceCents: cents,
  discountPct,
});
export type FormulaRow = z.infer<typeof formulaRowSchema>;

function uniqueCountries<T extends { country: string }>(rows: T[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.country)) {
      ctx.addIssue({ code: "custom", message: `country ${row.country} appears more than once` });
    }
    seen.add(row.country);
  }
}

export const priceRowsSchema = z.array(priceRowSchema).min(1).superRefine(uniqueCountries);
export const formulaRowsSchema = z.array(formulaRowSchema).superRefine(uniqueCountries);
