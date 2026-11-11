/** The approved table's price for a display country, or the standard price. Pure. */
export function priceForCountry(
  rows: ReadonlyArray<{ country: string; priceCents: number }>,
  country: string | null,
  standardCents: number,
): { priceCents: number; inTable: boolean } {
  const row = country ? rows.find((r) => r.country === country) : undefined;
  return row ? { priceCents: row.priceCents, inTable: true } : { priceCents: standardCents, inTable: false };
}

/** PayPal custom_id: "<productId>:<tableVersion>:<shownCountry>" (≤ 127 chars). */
export function customIdFor(productId: string, tableVersion: number, shownCountry: string | null): string {
  return `${productId}:${tableVersion}:${shownCountry ?? "--"}`.slice(0, 127);
}
