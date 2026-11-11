import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted recursively, so the same data always serializes the same way.
 * Array order is kept (arrays are ordered data); undefined object values are dropped, as in JSON.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * sha256 (hex) of a price table's rows. Rows are sorted by country first, so the hash
 * depends only on content — not on row order or key order. Shown on orders and the
 * publish screen as proof of which approved version priced a sale.
 */
export function contentHash(rows: ReadonlyArray<{ country: string }>): string {
  const sorted = rows
    .map((row) => ({ key: row.country, json: canonicalJson(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
    .map((r) => r.json);
  return createHash("sha256").update(`[${sorted.join(",")}]`, "utf8").digest("hex");
}
