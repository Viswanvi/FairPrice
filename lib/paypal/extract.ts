import { z } from "zod";

/**
 * Payer country and payment type from an Orders v2 response (GET order or authorize).
 * Path and fallback order come from docs/SPIKE_RESULTS.md:
 *   1. payer.address.country_code
 *   2. payment_source.paypal.address.country_code
 * The shipping address is never used — it isn't the account country.
 */

export interface PayerInfo {
  /** ISO alpha-2 country of the payer's PayPal account, or null if PayPal didn't return one. */
  country: string | null;
  /** Which path the country came from. */
  countrySource: "payer" | "payment_source" | null;
  /** The payment_source key, e.g. "paypal" or "card"; null if absent. */
  paymentType: string | null;
  paidWithPayPalAccount: boolean;
  /** payment_source.paypal.account_status, e.g. "VERIFIED". */
  accountStatus: string | null;
}

const countryCode = z.string().regex(/^[A-Z]{2}$/);

const shape = z.looseObject({
  payer: z.looseObject({ address: z.looseObject({ country_code: z.unknown().optional() }).optional() }).optional(),
  payment_source: z.record(z.string(), z.unknown()).optional(),
});

const paypalSource = z.looseObject({
  account_status: z.string().optional(),
  address: z.looseObject({ country_code: z.unknown().optional() }).optional(),
});

export function extractPayerCountry(response: unknown): PayerInfo {
  const parsed = shape.safeParse(response);
  const data = parsed.success ? parsed.data : {};
  const sources = data.payment_source ?? {};
  const paymentType = Object.keys(sources)[0] ?? null;
  const paypal = paypalSource.safeParse(sources.paypal);

  const fromPayer = countryCode.safeParse(data.payer?.address?.country_code);
  const fromSource = countryCode.safeParse(paypal.success ? paypal.data.address?.country_code : undefined);

  return {
    country: fromPayer.success ? fromPayer.data : fromSource.success ? fromSource.data : null,
    countrySource: fromPayer.success ? "payer" : fromSource.success ? "payment_source" : null,
    paymentType,
    paidWithPayPalAccount: paymentType === "paypal",
    accountStatus: paypal.success ? (paypal.data.account_status ?? null) : null,
  };
}
