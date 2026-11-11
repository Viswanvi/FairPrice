import { describe, expect, it } from "vitest";
import {
  decide,
  EligibilityInputError,
  type DecideInput,
  type PriceTableForDecision,
} from "./decide";

// docs/SPEC.md section 6. Amounts assume a $99 standard price and an illustrative $35 India price.
const STANDARD = 9900;

const tableV3: PriceTableForDecision = {
  version: 3,
  rows: [
    { country: "IN", priceCents: 3500 },
    { country: "BR", priceCents: 4500 },
    { country: "US", priceCents: 9900 },
  ],
};

const tableV4: PriceTableForDecision = {
  version: 4,
  rows: [
    { country: "IN", priceCents: 3000 },
    { country: "BR", priceCents: 4500 },
    { country: "US", priceCents: 9900 },
  ],
};

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    authorizedCents: 3500,
    payerCountry: "IN",
    paidWithPayPalAccount: true,
    table: tableV3,
    standardCents: STANDARD,
    requirePayPalForFairPrice: true,
    ...overrides,
  };
}

describe("decide — SPEC section 6 unit test matrix", () => {
  it("India buyer: authorized $35, payer IN, table $35 → capture $35, MATCH", () => {
    expect(decide(input())).toEqual({ action: "CAPTURE", amountCents: 3500, reason: "MATCH" });
  });

  it("VPN user: authorized $35, payer US, table $99 → void, offer $99, MISMATCH", () => {
    expect(decide(input({ payerCountry: "US" }))).toEqual({
      action: "VOID",
      reason: "MISMATCH",
      offerCents: 9900,
    });
  });

  it("Traveler: authorized $99, payer IN, table $35 → capture $35, TRAVELER", () => {
    expect(decide(input({ authorizedCents: 9900, payerCountry: "IN" }))).toEqual({
      action: "CAPTURE",
      amountCents: 3500,
      reason: "TRAVELER",
    });
  });

  it("Unknown country: authorized $35, no payer country → void, offer $99, UNCLEAR", () => {
    expect(decide(input({ payerCountry: null }))).toEqual({
      action: "VOID",
      reason: "UNCLEAR",
      offerCents: STANDARD,
    });
  });

  it("Country missing from table: authorized $35, payer FR → standard $99 applies → void, offer $99", () => {
    expect(decide(input({ payerCountry: "FR" }))).toEqual({
      action: "VOID",
      reason: "MISMATCH",
      offerCents: STANDARD,
    });
  });

  it("Guest card, PayPal required: authorized $35, no country → void, offer $99, NOT_PAYPAL", () => {
    expect(decide(input({ paidWithPayPalAccount: false, payerCountry: null }))).toEqual({
      action: "VOID",
      reason: "NOT_PAYPAL",
      offerCents: STANDARD,
    });
  });

  it("Cents precision: authorized $34.99, payer IN, table $34.99 → capture $34.99", () => {
    const table = { version: 1, rows: [{ country: "IN", priceCents: 3499 }] };
    expect(decide(input({ authorizedCents: 3499, table }))).toEqual({
      action: "CAPTURE",
      amountCents: 3499,
      reason: "MATCH",
    });
  });

  it("Same country, table changed later: order on v3 ($35), v4 says $30 → capture $35 from v3", () => {
    // The caller passes the version stored on the order (v3); v4 must not affect it.
    expect(decide(input({ table: tableV3 }))).toEqual({
      action: "CAPTURE",
      amountCents: 3500,
      reason: "MATCH",
    });
    // Sanity check that the tables really differ: v4 would have produced a lower capture.
    expect(decide(input({ table: tableV4 }))).toEqual({
      action: "CAPTURE",
      amountCents: 3000,
      reason: "TRAVELER",
    });
  });
});

describe("decide — cents precision", () => {
  it("one cent higher eligible price than authorized → void and offer the eligible price", () => {
    const table = { version: 1, rows: [{ country: "IN", priceCents: 3500 }] };
    expect(decide(input({ authorizedCents: 3499, table }))).toEqual({
      action: "VOID",
      reason: "MISMATCH",
      offerCents: 3500,
    });
  });

  it("one cent lower eligible price than authorized → capture the eligible price", () => {
    const table = { version: 1, rows: [{ country: "IN", priceCents: 3499 }] };
    expect(decide(input({ authorizedCents: 3500, table }))).toEqual({
      action: "CAPTURE",
      amountCents: 3499,
      reason: "TRAVELER",
    });
  });
});

describe("decide — payer country missing or not in table", () => {
  it("empty or blank payer country is treated as missing → UNCLEAR", () => {
    for (const payerCountry of ["", "   "]) {
      expect(decide(input({ payerCountry }))).toEqual({
        action: "VOID",
        reason: "UNCLEAR",
        offerCents: STANDARD,
      });
    }
  });

  it("malformed payer country (not two letters) is treated as missing → UNCLEAR", () => {
    for (const payerCountry of ["IND", "I", "1N"]) {
      expect(decide(input({ payerCountry })).reason).toBe("UNCLEAR");
    }
  });

  it("lower-case payer country matches the table", () => {
    expect(decide(input({ payerCountry: "in" }))).toEqual({
      action: "CAPTURE",
      amountCents: 3500,
      reason: "MATCH",
    });
  });

  it("country not in the table, authorized at standard price → capture standard, MATCH", () => {
    expect(decide(input({ authorizedCents: STANDARD, payerCountry: "FR" }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "MATCH",
    });
  });

  it("country not in the table, authorized above standard (impossible from our server) → capture standard, TRAVELER", () => {
    expect(decide(input({ authorizedCents: 12000, payerCountry: "FR" }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "TRAVELER",
    });
  });
});

describe("decide — guest card checkout", () => {
  it("guest card, PayPal required, even with a country → void, offer standard, NOT_PAYPAL", () => {
    expect(decide(input({ paidWithPayPalAccount: false, payerCountry: "IN" }))).toEqual({
      action: "VOID",
      reason: "NOT_PAYPAL",
      offerCents: STANDARD,
    });
  });

  // Changed in Phase 13 with the user's approval (finding F1): rule 7 now captures a card payment
  // that was already authorized at the standard price instead of voiding and re-offering the same price.
  it("guest card, PayPal required, authorized at standard → capture standard, NOT_PAYPAL (rule 7)", () => {
    expect(
      decide(input({ paidWithPayPalAccount: false, payerCountry: "US", authorizedCents: STANDARD })),
    ).toEqual({ action: "CAPTURE", amountCents: STANDARD, reason: "NOT_PAYPAL" });
  });

  it("guest card, PayPal not required, country known → normal rules, MATCH", () => {
    expect(
      decide(input({ paidWithPayPalAccount: false, requirePayPalForFairPrice: false })),
    ).toEqual({ action: "CAPTURE", amountCents: 3500, reason: "MATCH" });
  });

  it("guest card, PayPal not required, no country → UNCLEAR", () => {
    expect(
      decide(
        input({ paidWithPayPalAccount: false, requirePayPalForFairPrice: false, payerCountry: null }),
      ),
    ).toEqual({ action: "VOID", reason: "UNCLEAR", offerCents: STANDARD });
  });

  it("PayPal account, PayPal required → normal rules", () => {
    expect(decide(input({ requirePayPalForFairPrice: true })).reason).toBe("MATCH");
  });
});

describe("decide — rule 7: an offer equal to the authorized amount is captured", () => {
  it("no payer country, but the buyer authorized the standard price → capture standard, UNCLEAR", () => {
    expect(decide(input({ payerCountry: null, authorizedCents: STANDARD }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "UNCLEAR",
    });
  });

  it("an accepted re-offer at the standard price is captured even without a country", () => {
    // After an UNCLEAR void the buyer approves the offered $99; the country is still missing.
    expect(decide(input({ payerCountry: "", authorizedCents: STANDARD }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "UNCLEAR",
    });
  });

  it("does not apply when the offer differs from the authorized amount", () => {
    expect(decide(input({ payerCountry: null, authorizedCents: 3500 }))).toEqual({
      action: "VOID",
      reason: "UNCLEAR",
      offerCents: STANDARD,
    });
    expect(decide(input({ paidWithPayPalAccount: false, authorizedCents: 3500 }))).toEqual({
      action: "VOID",
      reason: "NOT_PAYPAL",
      offerCents: STANDARD,
    });
  });

  it("can never turn a MISMATCH into a capture (the offer is always above the authorized amount)", () => {
    for (const authorizedCents of [100, 3500, 4499, 9899]) {
      const d = decide(input({ payerCountry: "US", authorizedCents }));
      expect(d).toMatchObject({ action: "VOID", reason: "MISMATCH" });
    }
  });
});

describe("decide — standard-price country", () => {
  it("US buyer authorized at the standard price, US in table at standard → capture $99, MATCH", () => {
    expect(decide(input({ authorizedCents: STANDARD, payerCountry: "US" }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "MATCH",
    });
  });

  it("US buyer authorized at the standard price, US absent from table → capture $99, MATCH", () => {
    const table = { version: 1, rows: [{ country: "IN", priceCents: 3500 }] };
    expect(decide(input({ authorizedCents: STANDARD, payerCountry: "US", table }))).toEqual({
      action: "CAPTURE",
      amountCents: STANDARD,
      reason: "MATCH",
    });
  });
});

describe("decide — money-safety invariants", () => {
  it("never captures more than authorized, and a capture is always positive", () => {
    const countries = [null, "IN", "BR", "US", "FR", "in", ""];
    const authorized = [1, 3499, 3500, 3501, 4500, 9899, 9900];
    for (const payerCountry of countries) {
      for (const authorizedCents of authorized) {
        for (const paidWithPayPalAccount of [true, false]) {
          for (const requirePayPalForFairPrice of [true, false]) {
            const d = decide(
              input({ payerCountry, authorizedCents, paidWithPayPalAccount, requirePayPalForFairPrice }),
            );
            if (d.action === "CAPTURE") {
              expect(d.amountCents).toBeGreaterThan(0);
              expect(d.amountCents).toBeLessThanOrEqual(authorizedCents);
            } else {
              expect(d.offerCents).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it("does not mutate its input", () => {
    const i = input();
    const snapshot = JSON.stringify(i);
    decide(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });

  it("is deterministic: the same input always gives the same decision", () => {
    expect(decide(input({ payerCountry: "US" }))).toEqual(decide(input({ payerCountry: "US" })));
  });
});

describe("decide — rejects invalid amounts (programmer errors, never buyer situations)", () => {
  it.each([
    ["fractional authorized cents", { authorizedCents: 34.99 }],
    ["zero authorized cents", { authorizedCents: 0 }],
    ["negative authorized cents", { authorizedCents: -3500 }],
    ["fractional standard cents", { standardCents: 99.5 }],
    ["zero standard cents", { standardCents: 0 }],
    ["NaN authorized cents", { authorizedCents: Number.NaN }],
  ] as const)("throws on %s", (_label, overrides) => {
    expect(() => decide(input(overrides))).toThrow(EligibilityInputError);
  });

  it("throws when the payer's table row has an invalid price", () => {
    const table = { version: 1, rows: [{ country: "IN", priceCents: 0 }] };
    expect(() => decide(input({ table }))).toThrow(EligibilityInputError);
  });

  it("throws when the table lists the payer's country twice", () => {
    const table = {
      version: 1,
      rows: [
        { country: "IN", priceCents: 3500 },
        { country: "IN", priceCents: 3000 },
      ],
    };
    expect(() => decide(input({ table }))).toThrow(EligibilityInputError);
  });
});
