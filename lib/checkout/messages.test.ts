import { describe, expect, it } from "vitest";
import { countryPhrase, resultFromOrder, type OrderForResult } from "./messages";
import { customIdFor, priceForCountry } from "./pricing";

const order = (o: Partial<OrderForResult>): OrderForResult => ({
  id: "ord_1",
  productId: "demo-bootcamp",
  status: "CREATED",
  decision: null,
  payerCountry: null,
  shownCents: 3500,
  chargedCents: null,
  offerCents: null,
  ...o,
});

describe("resultFromOrder — SPEC section 3 / 9 copy", () => {
  it("PAID (match)", () => {
    expect(resultFromOrder(order({ status: "CAPTURED", decision: "MATCH", payerCountry: "IN", chargedCents: 3500 }))).toMatchObject({
      result: "PAID",
      chargedCents: 3500,
      country: "IN",
      canReoffer: false,
      message: "You paid $35, the fair price for India.",
    });
  });

  it("TRAVELER", () => {
    expect(
      resultFromOrder(order({ status: "CAPTURED", decision: "TRAVELER", payerCountry: "IN", shownCents: 9900, chargedCents: 3500 })),
    ).toMatchObject({ result: "TRAVELER", chargedCents: 3500, message: "You were charged $35, the fair price for your country, not $99." });
  });

  it("MISMATCH, with 'the' for the United States and a re-offer", () => {
    expect(resultFromOrder(order({ status: "VOIDED", decision: "MISMATCH", payerCountry: "US", offerCents: 9900 }))).toMatchObject({
      result: "MISMATCH",
      chargedCents: 0,
      offerCents: 9900,
      canReoffer: true,
      message: "Your PayPal account is registered in the United States. The price there is $99. You have not been charged.",
    });
  });

  it("UNCLEAR (voided) and UNCLEAR accepted at the standard price", () => {
    expect(resultFromOrder(order({ status: "VOIDED", decision: "UNCLEAR", offerCents: 9900 }))).toMatchObject({
      result: "UNCLEAR",
      canReoffer: true,
      message: "We couldn't confirm your country, so the standard price of $99 applies. You have not been charged.",
    });
    expect(resultFromOrder(order({ status: "CAPTURED", decision: "UNCLEAR", shownCents: 9900, chargedCents: 9900 }))).toMatchObject({
      result: "PAID",
      message: "We couldn't confirm your country, so the standard price applied. You paid $99.",
    });
  });

  it("NOT_PAYPAL (voided) and accepted at the standard price", () => {
    expect(resultFromOrder(order({ status: "VOIDED", decision: "NOT_PAYPAL", offerCents: 9900 }))).toMatchObject({
      result: "NOT_PAYPAL",
      canReoffer: true,
      message: "Fair prices need a PayPal account, so card payments pay the standard price of $99. You have not been charged.",
    });
    expect(resultFromOrder(order({ status: "CAPTURED", decision: "NOT_PAYPAL", chargedCents: 9900 })).message).toBe(
      "You paid $99, the standard price for card payments.",
    );
  });

  it("DECLINED, REVIEW and PENDING", () => {
    expect(resultFromOrder(order({ status: "DECLINED" }))).toMatchObject({ result: "DECLINED", chargedCents: 0 });
    expect(resultFromOrder(order({ status: "NEEDS_REVIEW", shownCents: 3500 })).message).toBe(
      "We're confirming your payment with PayPal. You won't be charged more than $35.",
    );
    expect(resultFromOrder(order({ status: "CREATED" })).result).toBe("PENDING");
  });

  it("every message says whether money moved and never accuses", () => {
    const all = [
      order({ status: "CAPTURED", decision: "MATCH", payerCountry: "BR", chargedCents: 4500 }),
      order({ status: "CAPTURED", decision: "TRAVELER", payerCountry: "IN", chargedCents: 3500, shownCents: 9900 }),
      order({ status: "VOIDED", decision: "MISMATCH", payerCountry: "GB", offerCents: 8900 }),
      order({ status: "VOIDED", decision: "UNCLEAR", offerCents: 9900 }),
      order({ status: "VOIDED", decision: "NOT_PAYPAL", offerCents: 9900 }),
      order({ status: "DECLINED" }),
      order({ status: "NEEDS_REVIEW" }),
      order({ status: "CREATED" }),
    ].map(resultFromOrder);
    for (const r of all) {
      expect(r.message).toMatch(/You paid|You were charged|You have not been charged|won't be charged more than/);
      expect(r.message).not.toMatch(/vpn|fraud|cheat|proof|lying|fake/i);
    }
  });
});

describe("countryPhrase", () => {
  it("adds 'the' where English needs it", () => {
    expect(countryPhrase("US")).toBe("the United States");
    expect(countryPhrase("GB")).toBe("the United Kingdom");
    expect(countryPhrase("IN")).toBe("India");
  });
});

describe("priceForCountry / customIdFor", () => {
  const rows = [
    { country: "IN", priceCents: 3500 },
    { country: "US", priceCents: 9900 },
  ];
  it("uses the table price or the standard price", () => {
    expect(priceForCountry(rows, "IN", 9900)).toEqual({ priceCents: 3500, inTable: true });
    expect(priceForCountry(rows, "FR", 9900)).toEqual({ priceCents: 9900, inTable: false });
    expect(priceForCountry(rows, null, 9900)).toEqual({ priceCents: 9900, inTable: false });
  });

  it("formats custom_id", () => {
    expect(customIdFor("demo-bootcamp", 3, "IN")).toBe("demo-bootcamp:3:IN");
    expect(customIdFor("demo-bootcamp", 3, null)).toBe("demo-bootcamp:3:--");
  });
});
