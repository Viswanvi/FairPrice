/**
 * Eligibility engine (docs/SPEC.md section 6).
 *
 * Given what the buyer authorized, the payer's PayPal account country and the approved
 * table version stored on the order, decide whether to capture (the same or a lower
 * amount) or void. Only an equal or lower amount is ever captured. Rules 1–6 are SPEC
 * section 6; rule 7 (an offer equal to the authorized amount is captured) was added in
 * Phase 13 so this function stays the single place that decides (CLAUDE.md rule 3).
 *
 * PURE: no database, network, AI, clock or randomness (CLAUDE.md money-safety rule 4).
 * ESLint enforces this for lib/eligibility/.
 */

export type Decision =
  | { action: "CAPTURE"; amountCents: number; reason: "MATCH" | "TRAVELER" | "UNCLEAR" | "NOT_PAYPAL" }
  | { action: "VOID"; reason: "MISMATCH" | "UNCLEAR" | "NOT_PAYPAL"; offerCents: number };

export type DecisionReason = Decision["reason"];

/** The approved price-table version stored with the order. Only these fields are read. */
export interface PriceTableForDecision {
  version: number;
  rows: ReadonlyArray<{ country: string; priceCents: number }>;
}

export interface DecideInput {
  /** What the buyer approved and PayPal authorized, in integer cents. */
  authorizedCents: number;
  /** Payer's PayPal account country (ISO 3166-1 alpha-2), or null if PayPal didn't return one. */
  payerCountry: string | null;
  /** False for guest card checkout. */
  paidWithPayPalAccount: boolean;
  /** The table version recorded on the order, never "the latest". */
  table: PriceTableForDecision;
  /** The product's base price in integer cents. */
  standardCents: number;
  requirePayPalForFairPrice: boolean;
}

/** Thrown for impossible inputs (bugs upstream). Callers must void, never capture, on error. */
export class EligibilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EligibilityInputError";
  }
}

function assertPositiveCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EligibilityInputError(`${name} must be a positive integer number of cents`);
  }
}

/** Upper-cased two-letter code, or null when missing or malformed. */
function normalizeCountry(country: string | null): string | null {
  if (country === null) return null;
  const code = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** The table's price for the country, or null when the country isn't in the table. */
function tablePriceCents(table: PriceTableForDecision, country: string): number | null {
  const matches = table.rows.filter((row) => row.country.trim().toUpperCase() === country);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new EligibilityInputError(`table v${table.version} lists ${country} more than once`);
  }
  const price = matches[0].priceCents;
  assertPositiveCents(`table v${table.version} price for ${country}`, price);
  return price;
}

export function decide(input: DecideInput): Decision {
  const { authorizedCents, standardCents } = input;
  assertPositiveCents("authorizedCents", authorizedCents);
  assertPositiveCents("standardCents", standardCents);

  // Rule 1: guest card while the seller requires PayPal for fair prices.
  if (!input.paidWithPayPalAccount && input.requirePayPalForFairPrice) {
    return offerOrCapture("NOT_PAYPAL", standardCents, authorizedCents);
  }

  // Rule 2: no usable payer country.
  const country = normalizeCountry(input.payerCountry);
  if (country === null) {
    return offerOrCapture("UNCLEAR", standardCents, authorizedCents);
  }

  // Rule 3: the table's price for the payer country, or the standard price.
  const eligibleCents = tablePriceCents(input.table, country) ?? standardCents;

  // Rule 4: same price → capture in full.
  if (eligibleCents === authorizedCents) {
    return { action: "CAPTURE", amountCents: authorizedCents, reason: "MATCH" };
  }
  // Rule 5: lower price → capture only the eligible amount.
  if (eligibleCents < authorizedCents) {
    return { action: "CAPTURE", amountCents: eligibleCents, reason: "TRAVELER" };
  }
  // Rule 6: higher price → never capture more than authorized; void and re-offer.
  // (Rule 7 can't apply here: the offer is always above the authorized amount.)
  return { action: "VOID", reason: "MISMATCH", offerCents: eligibleCents };
}

/**
 * Rule 7: a void whose offered price EQUALS the authorized amount is captured instead — the buyer
 * already approved exactly that price (e.g. a card payment at the standard price, or an accepted
 * re-offer), so voiding and asking again would loop. Never more than authorized, by construction.
 */
function offerOrCapture(reason: "UNCLEAR" | "NOT_PAYPAL", offerCents: number, authorizedCents: number): Decision {
  return offerCents === authorizedCents
    ? { action: "CAPTURE", amountCents: authorizedCents, reason }
    : { action: "VOID", reason, offerCents };
}
