import { countryName, formatUsd } from "@/lib/seller/format";

/**
 * Buyer-facing checkout results and their copy (docs/SPEC.md sections 3 and 9).
 * Rules (CLAUDE.md): always say whether money moved; never accuse; one plain sentence of
 * explanation, never a formula; the account country is evidence, not proof of residence.
 */

export type CheckoutResultCode =
  | "PAID"
  | "TRAVELER"
  | "MISMATCH"
  | "UNCLEAR"
  | "NOT_PAYPAL"
  | "DECLINED"
  | "REVIEW"
  | "PENDING";

export type DecisionCode = "MATCH" | "TRAVELER" | "MISMATCH" | "UNCLEAR" | "NOT_PAYPAL";
export type OrderStatusCode = "CREATED" | "AUTHORIZED" | "CAPTURED" | "VOIDED" | "DECLINED" | "NEEDS_REVIEW";

export interface CheckoutResult {
  result: CheckoutResultCode;
  /** Our order ID (needed for a re-offer). */
  orderId: string;
  productId: string;
  decision: DecisionCode | null;
  chargedCents: number;
  /** The amount the buyer approved in PayPal (the authorized amount). */
  shownCents: number;
  /** The payer's PayPal account country, when known. */
  country: string | null;
  /** The price offered after a void (re-offer button), when there is one. */
  offerCents: number | null;
  /** True when the buyer can accept the offered price as a new payment. */
  canReoffer: boolean;
  message: string;
}

// Country names that read naturally with "the" ("registered in the United States").
const WITH_THE = new Set(["US", "GB", "NL", "PH", "AE", "CZ", "DO", "BS", "GM", "CF", "KM", "MV", "MH", "SB", "CD", "CG", "VA"]);

export function countryPhrase(code: string): string {
  const name = countryName(code);
  return WITH_THE.has(code.toUpperCase()) ? `the ${name}` : name;
}

export interface OrderForResult {
  id: string;
  productId: string;
  status: OrderStatusCode;
  decision: DecisionCode | null;
  payerCountry: string | null;
  shownCents: number;
  chargedCents: number | null;
  offerCents: number | null;
}

/** Build the buyer result (code + message) from a stored order. Pure. */
export function resultFromOrder(order: OrderForResult): CheckoutResult {
  const base = {
    orderId: order.id,
    productId: order.productId,
    decision: order.decision,
    chargedCents: order.status === "CAPTURED" ? (order.chargedCents ?? 0) : 0,
    shownCents: order.shownCents,
    country: order.payerCountry,
    offerCents: null as number | null,
    canReoffer: false,
  };
  const country = order.payerCountry ? countryPhrase(order.payerCountry) : null;

  switch (order.status) {
    case "CAPTURED": {
      const paid = formatUsd(base.chargedCents);
      if (order.decision === "TRAVELER") {
        return {
          ...base,
          result: "TRAVELER",
          message: `You were charged ${paid}, the fair price for your country, not ${formatUsd(order.shownCents)}.`,
        };
      }
      if (order.decision === "UNCLEAR") {
        return { ...base, result: "PAID", message: `We couldn't confirm your country, so the standard price applied. You paid ${paid}.` };
      }
      if (order.decision === "NOT_PAYPAL") {
        return { ...base, result: "PAID", message: `You paid ${paid}, the standard price for card payments.` };
      }
      return {
        ...base,
        result: "PAID",
        message: country ? `You paid ${paid}, the fair price for ${country}.` : `You paid ${paid}.`,
      };
    }
    case "VOIDED": {
      const offer = order.offerCents ?? 0;
      const withOffer = { ...base, offerCents: offer || null, canReoffer: offer > 0 };
      if (order.decision === "MISMATCH" && country) {
        return {
          ...withOffer,
          result: "MISMATCH",
          message: `Your PayPal account is registered in ${country}. The price there is ${formatUsd(offer)}. You have not been charged.`,
        };
      }
      if (order.decision === "NOT_PAYPAL") {
        return {
          ...withOffer,
          result: "NOT_PAYPAL",
          message: `Fair prices need a PayPal account, so card payments pay the standard price of ${formatUsd(offer)}. You have not been charged.`,
        };
      }
      return {
        ...withOffer,
        result: "UNCLEAR",
        message: `We couldn't confirm your country, so the standard price of ${formatUsd(offer)} applies. You have not been charged.`,
      };
    }
    case "DECLINED":
      return { ...base, result: "DECLINED", message: "Your payment wasn't approved. You have not been charged." };
    case "NEEDS_REVIEW":
      return {
        ...base,
        result: "REVIEW",
        message: `We're confirming your payment with PayPal. You won't be charged more than ${formatUsd(order.shownCents)}.`,
      };
    default:
      return { ...base, result: "PENDING", message: "Your payment hasn't been approved yet. You have not been charged." };
  }
}
