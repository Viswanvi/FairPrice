import { describe, expect, it } from "vitest";
import { demoBannerText, priceHeadline } from "./display";
import { buildQuote } from "./quote";

describe("buildQuote", () => {
  const product = { id: "demo-bootcamp", title: "Bootcamp", baseCents: 9900, requirePaypal: true };
  const table = { version: 3, rows: [{ country: "IN", priceCents: 3500 }, { country: "US", priceCents: 9900 }] };

  it("prices the display country from the approved table", () => {
    expect(buildQuote(product, table, { country: "IN", overridden: true, source: "override" })).toEqual({
      productId: "demo-bootcamp",
      title: "Bootcamp",
      shownCountry: "IN",
      priceCents: 3500,
      standardCents: 9900,
      inTable: true,
      overridden: true,
      tableVersion: 3,
      requirePaypal: true,
    });
  });

  it("falls back to the standard price for unknown or untabled countries", () => {
    expect(buildQuote(product, table, { country: null, overridden: false, source: "none" })).toMatchObject({ priceCents: 9900, inTable: false });
    expect(buildQuote(product, table, { country: "FR", overridden: false, source: "ip" })).toMatchObject({ priceCents: 9900, inTable: false });
  });
});

describe("priceHeadline", () => {
  it("names the fair price and shows the standard price when it's lower", () => {
    expect(priceHeadline({ shownCountry: "IN", inTable: true, priceCents: 3500, standardCents: 9900 })).toEqual({
      label: "Fair price for India, verified by PayPal at checkout",
      showStandard: true,
    });
  });

  it("uses 'the' where English needs it and hides an equal standard price", () => {
    expect(priceHeadline({ shownCountry: "US", inTable: true, priceCents: 9900, standardCents: 9900 })).toEqual({
      label: "Fair price for the United States, verified by PayPal at checkout",
      showStandard: false,
    });
  });

  it("doesn't call an untabled country's price 'fair'", () => {
    expect(priceHeadline({ shownCountry: "FR", inTable: false, priceCents: 9900, standardCents: 9900 }).label).toBe("Price for France");
  });

  it("handles an unknown country", () => {
    expect(priceHeadline({ shownCountry: null, inTable: false, priceCents: 9900, standardCents: 9900 }).label).toBe(
      "Standard price. PayPal confirms your country at checkout.",
    );
  });
});

describe("demoBannerText", () => {
  it("matches the SPEC wording", () => {
    expect(demoBannerText("IN")).toBe("Demo: simulating a visitor from India.");
    expect(demoBannerText("US")).toBe("Demo: simulating a visitor from the United States.");
  });
});
