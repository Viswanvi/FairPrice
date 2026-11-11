import { requireSeller } from "@/lib/auth/session";
import { approveTable, getPriceTable, PriceTableError } from "@/lib/db/price-tables";
import { getOwnedProduct } from "@/lib/db/products";
import { HttpError, route } from "@/lib/http";
import { checkStoredRows } from "@/lib/pricing/table-check";

/** Lock a DRAFT version and hash it. Refused while the validator reports any error. */
export const POST = route(async (_request: Request, ctx: RouteContext<"/api/price-tables/[id]/approve">) => {
  const sellerId = await requireSeller();
  const { id } = await ctx.params;
  const table = await getPriceTable(id);
  const product = table && (await getOwnedProduct(table.productId, sellerId));
  if (!table || !product) throw new HttpError(404, "not_found", "Price table not found.");

  if (table.status === "draft") {
    const check = checkStoredRows(table.rows, product);
    if (check.errors.length > 0) {
      throw new HttpError(422, "table_invalid", "Fix the highlighted prices before approving.", {
        reasons: check.errors.map((e) => ({ country: e.country, message: e.message })),
      });
    }
  }

  try {
    const approved = await approveTable(id);
    return Response.json({
      priceTableId: approved.id,
      version: approved.version,
      contentHash: approved.contentHash,
      approvedAt: approved.approvedAt,
    });
  } catch (error) {
    if (error instanceof PriceTableError && error.code === "superseded") {
      throw new HttpError(409, "superseded", "A newer version has already been approved.");
    }
    throw error;
  }
});
