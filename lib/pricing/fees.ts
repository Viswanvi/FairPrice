import type { FeeConfig } from "./formula";

/**
 * What the seller keeps after estimated PayPal fees, in whole cents. The merchant account is
 * in the US, so only non-US buyers add the international fee. Estimates for the price table;
 * real fees come from PayPal's capture response.
 */
export function netAfterFeesCents(priceCents: number, fees: FeeConfig, buyerCountry: string): number {
  const international = buyerCountry.toUpperCase() !== "US";
  const share = fees.percent + (international ? fees.intlPercent : 0);
  return priceCents - Math.round(priceCents * share) - Math.round(fees.fixedUsd * 100);
}
