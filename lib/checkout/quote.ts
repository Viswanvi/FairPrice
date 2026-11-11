import type { DisplayCountry } from "@/lib/geo/country";
import { priceForCountry } from "./pricing";

/** The price a visitor is shown. Built in one place for GET /api/quote and the buyer page. Pure. */
export interface Quote {
  productId: string;
  title: string;
  shownCountry: string | null;
  priceCents: number;
  standardCents: number;
  inTable: boolean;
  overridden: boolean;
  tableVersion: number;
  requirePaypal: boolean;
}

export function buildQuote(
  product: { id: string; title: string; baseCents: number; requirePaypal: boolean },
  table: { version: number; rows: ReadonlyArray<{ country: string; priceCents: number }> },
  geo: DisplayCountry,
): Quote {
  const { priceCents, inTable } = priceForCountry(table.rows, geo.country, product.baseCents);
  return {
    productId: product.id,
    title: product.title,
    shownCountry: geo.country,
    priceCents,
    standardCents: product.baseCents,
    inTable,
    overridden: geo.overridden,
    tableVersion: table.version,
    requirePaypal: product.requirePaypal,
  };
}
