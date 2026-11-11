/**
 * Baseline purchasing-power formula (docs/SPEC.md section 7) — what the AI must beat.
 *
 *   M = 1 + s × (ratio − 1),  s in [0, 1],  ratio = PPP / FX (US = 1)
 *   price = base × M, rounded to whole cents, then clamped to
 *           [max(seller minimum, fee floor, max-discount floor), base]
 *   feeFloor = fixedUsd / (maxFeeShare − percent − intlPercent)
 *
 * It treats every product the same way. Pure: no I/O. All money is integer cents.
 */

export interface FeeConfig {
  /** PayPal percentage fee as a fraction, e.g. 0.0349 for 3.49%. */
  percent: number;
  /** PayPal fixed fee per transaction in US dollars, e.g. 0.49. */
  fixedUsd: number;
  /** Extra international fee as a fraction, e.g. 0.015 for 1.5%. */
  intlPercent: number;
  /** Highest acceptable share of the price taken by fees, e.g. 0.15. */
  maxFeeShare: number;
}

export interface FormulaInput {
  baseCents: number;
  minCents: number;
  maxDiscountPct: number;
  /** Price-level ratio PPP / FX for the country (US = 1). */
  ratio: number;
  /** s in [0, 1]: how strongly the price follows the price level. */
  strength: number;
  fees: FeeConfig;
}

export type FormulaBound = "base" | "max_discount" | "min_price" | "fee_floor" | "floor_above_base";

export interface FormulaResult {
  priceCents: number;
  discountPct: number;
  multiplier: number;
  /** The highest of the seller minimum, the fee floor and the max-discount floor. */
  floorCents: number;
  /** Which limit, if any, set the price. */
  boundBy: FormulaBound | null;
}

export class FormulaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaInputError";
  }
}

/** Full purchasing-power adjustment: the plain formula a seller would get from PPP data. */
export const DEFAULT_STRENGTH = 1;

// Guards against float noise, e.g. 0.0499 − 0.0349 − 0.015 = 3.5e-18 instead of 0.
const EPSILON = 1e-9;

function check(condition: boolean, message: string): void {
  if (!condition) throw new FormulaInputError(message);
}

export function formulaMultiplier(ratio: number, strength: number): number {
  check(Number.isFinite(ratio) && ratio > 0, "ratio must be a positive number");
  check(Number.isFinite(strength) && strength >= 0 && strength <= 1, "strength must be between 0 and 1");
  return 1 + strength * (ratio - 1);
}

/** Lowest price (whole cents, rounded up) at which fees stay within maxFeeShare. */
export function feeFloorCents(fees: FeeConfig): number {
  for (const [name, value] of Object.entries(fees)) {
    check(Number.isFinite(value) && value >= 0, `fees.${name} must be a non-negative number`);
  }
  check(fees.maxFeeShare <= 1, "fees.maxFeeShare must be at most 1");
  const fixedCents = Math.round(fees.fixedUsd * 100);
  if (fixedCents === 0) return 0;
  const margin = fees.maxFeeShare - fees.percent - fees.intlPercent;
  check(margin > EPSILON, "percentage fees alone reach maxFeeShare; no price keeps fees within it");
  return Math.ceil(fixedCents / margin - EPSILON);
}

function discountPct(priceCents: number, baseCents: number): number {
  return Math.round((1 - priceCents / baseCents) * 100);
}

export function formulaPrice(input: FormulaInput): FormulaResult {
  const { baseCents, minCents, maxDiscountPct } = input;
  check(Number.isSafeInteger(baseCents) && baseCents > 0, "baseCents must be a positive whole number of cents");
  check(Number.isSafeInteger(minCents) && minCents >= 0, "minCents must be a non-negative whole number of cents");
  check(
    Number.isFinite(maxDiscountPct) && maxDiscountPct >= 0 && maxDiscountPct <= 100,
    "maxDiscountPct must be between 0 and 100",
  );

  const multiplier = formulaMultiplier(input.ratio, input.strength);
  const feeFloor = feeFloorCents(input.fees);
  // Rounded up so the discount never exceeds the maximum.
  const maxDiscountFloor = Math.ceil((baseCents * (100 - maxDiscountPct)) / 100 - EPSILON);

  // Highest floor wins; on a tie, report the seller's own minimum first.
  const floors: [Exclude<FormulaBound, "base" | "floor_above_base">, number][] = [
    ["min_price", minCents],
    ["fee_floor", feeFloor],
    ["max_discount", maxDiscountFloor],
  ];
  const [floorName, floorCents] = floors.reduce((best, f) => (f[1] > best[1] ? f : best));

  const raw = Math.round(baseCents * multiplier);
  let priceCents: number;
  let boundBy: FormulaBound | null = null;

  if (floorCents > baseCents) {
    priceCents = baseCents;
    boundBy = "floor_above_base";
  } else if (raw > baseCents) {
    priceCents = baseCents;
    boundBy = "base";
  } else if (raw < floorCents) {
    priceCents = floorCents;
    boundBy = floorName;
  } else {
    priceCents = raw;
  }

  return { priceCents, discountPct: discountPct(priceCents, baseCents), multiplier, floorCents, boundBy };
}

export interface CountryRatio {
  code: string;
  /** null when the World Bank has no usable data for the country. */
  ratio: number | null;
}

export interface FormulaRowResult {
  country: string;
  priceCents: number;
  discountPct: number;
  flags: string[];
}

/** Formula prices for many countries. Countries without data get the base price. */
export function formulaTable(
  product: { baseCents: number; minCents: number; maxDiscountPct: number },
  countries: ReadonlyArray<CountryRatio>,
  fees: FeeConfig,
  strength: number = DEFAULT_STRENGTH,
): FormulaRowResult[] {
  return countries.map(({ code, ratio }) => {
    if (ratio === null) {
      return { country: code, priceCents: product.baseCents, discountPct: 0, flags: ["no_data"] };
    }
    const r = formulaPrice({ ...product, ratio, strength, fees });
    return { country: code, priceCents: r.priceCents, discountPct: r.discountPct, flags: r.boundBy ? [r.boundBy] : [] };
  });
}
