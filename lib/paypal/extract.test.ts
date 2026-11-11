import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPayerCountry } from "./extract";
import { centsToValue, valueToCents } from "./money";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "paypal", `${name}.json`), "utf8"));

describe("extractPayerCountry — real sandbox responses (Phase 5 verify gate)", () => {
  it.each([
    ["in-authorize", "IN"],
    ["br-authorize", "BR"],
    ["us-authorize", "US"],
    ["in-get-approved", "IN"],
    ["in-authorize-with-shipping", "IN"],
  ])("%s → %s", (name, country) => {
    expect(extractPayerCountry(fixture(name))).toEqual({
      country,
      countrySource: "payer",
      paymentType: "paypal",
      paidWithPayPalAccount: true,
      accountStatus: "VERIFIED",
    });
  });
});

describe("extractPayerCountry — fallbacks", () => {
  it("falls back to payment_source.paypal.address when payer.address is missing", () => {
    const r = extractPayerCountry({ payment_source: { paypal: { address: { country_code: "BR" } } } });
    expect(r).toMatchObject({ country: "BR", countrySource: "payment_source", paidWithPayPalAccount: true });
  });

  it("returns null when neither path has a country", () => {
    expect(extractPayerCountry({ payer: {}, payment_source: { paypal: {} } })).toMatchObject({
      country: null,
      countrySource: null,
    });
  });

  it("never uses the shipping address", () => {
    const r = extractPayerCountry({
      payment_source: { paypal: {} },
      purchase_units: [{ shipping: { address: { country_code: "IN" } } }],
    });
    expect(r.country).toBeNull();
  });

  it("ignores malformed country codes", () => {
    expect(extractPayerCountry({ payer: { address: { country_code: "india" } } }).country).toBeNull();
    expect(
      extractPayerCountry({ payer: { address: { country_code: 7 } }, payment_source: { paypal: { address: { country_code: "IN" } } } })
        .country,
    ).toBe("IN");
  });

  it("marks a card payment as not a PayPal account", () => {
    expect(extractPayerCountry({ payment_source: { card: { last_digits: "1111" } } })).toMatchObject({
      paymentType: "card",
      paidWithPayPalAccount: false,
      country: null,
    });
  });

  it("handles junk input", () => {
    for (const junk of [null, undefined, "x", 42, []]) {
      expect(extractPayerCountry(junk)).toMatchObject({ country: null, paymentType: null, paidWithPayPalAccount: false });
    }
  });
});

describe("money", () => {
  it.each([
    [3500, "35.00"],
    [3499, "34.99"],
    [5, "0.05"],
    [0, "0.00"],
    [9900, "99.00"],
    [123456, "1234.56"],
  ])("centsToValue(%i) = %s", (cents, value) => {
    expect(centsToValue(cents)).toBe(value);
    expect(valueToCents(value)).toBe(cents);
  });

  it("parses short forms exactly", () => {
    expect(valueToCents("35")).toBe(3500);
    expect(valueToCents("34.9")).toBe(3490);
    expect(valueToCents("0.29")).toBe(29);
  });

  it("rejects bad amounts", () => {
    for (const bad of [-1, 34.5, Number.NaN]) expect(() => centsToValue(bad)).toThrow(RangeError);
    for (const bad of ["", "35.001", "-5.00", "1e3", "35,00", " 35"]) expect(() => valueToCents(bad)).toThrow(RangeError);
  });
});
