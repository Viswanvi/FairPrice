import { requireSeller } from "@/lib/auth/session";
import { listProductOrders } from "@/lib/db/orders";
import { getOwnedProduct } from "@/lib/db/products";
import { HttpError, route } from "@/lib/http";

/** Orders for the seller dashboard (newest 500), each with its decision, PayPal IDs and table version. */
export const GET = route(async (_request: Request, ctx: RouteContext<"/api/products/[id]/orders">) => {
  const sellerId = await requireSeller();
  const { id } = await ctx.params;
  const product = await getOwnedProduct(id, sellerId);
  if (!product) throw new HttpError(404, "not_found", "Product not found.");
  const orders = await listProductOrders(product.id);
  return Response.json({ orders, fetchedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
});
