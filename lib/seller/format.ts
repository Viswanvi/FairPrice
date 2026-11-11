/** Pure formatting helpers shared by the seller (and later buyer) screens. Safe on server and client. */

/** "$35" for whole dollars, "$34.99" otherwise. */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Parse a seller-typed dollar amount ("35", "34.99", "$1,299.00") into whole cents.
 * Returns null for anything that isn't a non-negative amount with at most two decimals.
 */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

let displayNames: Intl.DisplayNames | null = null;

/** English country name for an ISO alpha-2 code ("IN" → "India"); the code if unknown. */
export function countryName(code: string): string {
  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export interface DiffRow {
  country: string;
  aiCents: number;
  formulaCents: number;
  diffCents: number;
  diffPct: number;
}

/** AI vs formula per country, sorted by the size of the difference (largest first). */
export function priceDifferences(
  rows: ReadonlyArray<{ country: string; priceCents: number }>,
  formulaRows: ReadonlyArray<{ country: string; priceCents: number }>,
): DiffRow[] {
  const formula = new Map(formulaRows.map((r) => [r.country, r.priceCents]));
  return rows
    .filter((r) => formula.has(r.country))
    .map((r) => {
      const formulaCents = formula.get(r.country)!;
      const diffCents = r.priceCents - formulaCents;
      return {
        country: r.country,
        aiCents: r.priceCents,
        formulaCents,
        diffCents,
        diffPct: formulaCents > 0 ? Math.round((diffCents / formulaCents) * 100) : 0,
      };
    })
    .sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents) || a.country.localeCompare(b.country));
}

/** Countries with the n largest AI-vs-formula differences (ignoring zero differences). */
export function biggestDifferences(
  rows: ReadonlyArray<{ country: string; priceCents: number }>,
  formulaRows: ReadonlyArray<{ country: string; priceCents: number }>,
  n = 5,
): string[] {
  return priceDifferences(rows, formulaRows)
    .filter((d) => d.diffCents !== 0)
    .slice(0, n)
    .map((d) => d.country);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One-line iframe embed for the hosted product page. */
export function embedSnippet(pageUrl: string, title: string): string {
  return `<iframe src="${escapeAttr(pageUrl)}" title="${escapeAttr(title)}" width="100%" height="680" style="border:0;max-width:480px" loading="lazy"></iframe>`;
}

const dateTimeUtc = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * "11 Nov 2026, 06:34 UTC". Fixed locale and time zone so the server and the browser render
 * identical text (locale-dependent formatting caused a hydration mismatch).
 */
export function formatDateTimeUtc(iso: string): string {
  return `${dateTimeUtc.format(new Date(iso))} UTC`;
}

/** First 12 hex characters of a content hash, for display. */
export const shortHash = (hash: string): string => hash.slice(0, 12);
