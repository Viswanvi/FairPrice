import { z } from "zod";
import { requireSeller } from "@/lib/auth/session";
import { getPriceTable, PriceTableError, updateDraftRows } from "@/lib/db/price-tables";
import { getOwnedProduct } from "@/lib/db/products";
import { HttpError, readJson, route } from "@/lib/http";
import { checkStoredRows, derivedColumns } from "@/lib/pricing/table-check";

const bodySchema = z.object({
  priceCents: z.number().int(),
  reason: z.string().trim().min(1).max(300).optional(),
});

/** Seller edits one country's price in a DRAFT table. The validator re-runs; 422 with reasons if it fails. */
export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/price-tables/[id]/rows/[country]">) => {
  const sellerId = await requireSeller();
  const { id, country: rawCountry } = await ctx.params;
  const country = rawCountry.toUpperCase();
  const { priceCents, reason } = await readJson(request, bodySchema);

  const existing = await getPriceTable(id);
  const product = existing && (await getOwnedProduct(existing.productId, sellerId));
  if (!existing || !product) throw new HttpError(404, "not_found", "Price table not found.");

  let warnings: ReturnType<typeof checkStoredRows>["warnings"] = [];
  try {
    const table = await updateDraftRows(id, (rows) => {
      const index = rows.findIndex((r) => r.country === country);
      if (index === -1) throw new HttpError(404, "country_not_in_table", `${country} isn't in this table.`);
      const next = rows.map((row, i) =>
        i === index
          ? {
              ...row,
              priceCents,
              reason: reason ?? row.reason,
              flags: [...new Set([...row.flags.filter((f) => f !== "formula_fallback"), "seller_edited"])],
              ...derivedColumns(priceCents, product.baseCents, country),
            }
          : row,
      );
      const check = checkStoredRows(next, product);
      const problems = check.errors.filter((e) => e.country === country);
      if (problems.length > 0) {
        throw new HttpError(422, "invalid_price", problems[0].message, { reasons: problems.map((p) => p.message) });
      }
      warnings = check.warnings;
      return next;
    });
    return Response.json({
      row: table.rows.find((r) => r.country === country),
      warnings,
      contentHash: table.contentHash,
    });
  } catch (error) {
    if (error instanceof PriceTableError && error.code === "not_draft") {
      throw new HttpError(409, "not_draft", "Only draft tables can be edited. Generate a new version to make changes.");
    }
    throw error;
  }
});
