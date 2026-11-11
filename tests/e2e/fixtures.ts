/**
 * Data the browser tests need, written straight to the database (no AI, no PayPal).
 * Every product here starts with "e2e-" and is removed by global-teardown.ts.
 */
export const E2E = {
  /** Has an APPROVED table — the buyer page tests use it. */
  buyerProduct: "e2e-buyer",
  /** Has a DRAFT table — the seller tests edit and approve it. */
  sellerProduct: "e2e-seller",
  /** No table at all — "not on sale yet". */
  unpublishedProduct: "e2e-unpublished",
  /** Title prefix for anything the tests create through the UI. */
  titlePrefix: "E2E",
};

export const sellerPassword = (): string => {
  const pw = process.env.E2E_SELLER_PASSWORD;
  if (!pw) throw new Error("E2E_SELLER_PASSWORD is not set (playwright.config.ts sets it)");
  return pw;
};

export const tableRows = [
  { country: "US", priceCents: 9900, discountPct: 0, relevance: "high", reason: "E2E: base market.", flags: [], region: "North America", formulaPriceCents: 9900, netCents: 9505 },
  { country: "IN", priceCents: 3500, discountPct: 65, relevance: "high", reason: "E2E: large student audience.", flags: [], region: "South Asia", formulaPriceCents: 2970, netCents: 3276 },
  { country: "BR", priceCents: 4500, discountPct: 55, relevance: "medium", reason: "E2E: Portuguese subtitles help.", flags: [], region: "Latin America", formulaPriceCents: 4554, netCents: 4226 },
];
export const formulaRows = [
  { country: "US", priceCents: 9900, discountPct: 0, flags: [] },
  { country: "IN", priceCents: 2970, discountPct: 70, flags: ["max_discount"] },
  { country: "BR", priceCents: 4554, discountPct: 54, flags: [] },
];
