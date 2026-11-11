import { z } from "zod";
import { attachPayPalOrder, insertOrderRow, loadCheckoutProduct } from "@/lib/checkout/create";
import { priceForCountry } from "@/lib/checkout/pricing";
import { env } from "@/lib/env";
import { displayCountry } from "@/lib/geo/country";
import { readJson, route } from "@/lib/http";
import { paypalClient } from "@/lib/paypal/server";

// Body is productId ONLY: no buyer-facing endpoint accepts a price (CLAUDE.md rule 1).
const bodySchema = z.object({ productId: z.string().min(1).max(100) }).strict();

/**
 * POST /api/checkout/orders[?as=XX] — re-resolve the display country and the approved table on
 * the server, create our order row, then the PayPal AUTHORIZE order. Returns paypalOrderId.
 */
export const POST = route(async (request: Request) => {
  const { productId } = await readJson(request, bodySchema);
  const { product, table } = await loadCheckoutProduct(productId);
  const geo = await displayCountry({
    headers: request.headers,
    as: new URL(request.url).searchParams.get("as"),
    overrideEnabled: env.DEMO_GEO_OVERRIDE,
  });
  const { priceCents } = priceForCountry(table.rows, geo.country, product.baseCents);

  const order = await insertOrderRow({
    productId: product.id,
    priceTableId: table.id,
    shownCountry: geo.country,
    shownCents: priceCents,
  });
  const { paypalOrderId } = await attachPayPalOrder(order, table.version, paypalClient());
  return Response.json({ paypalOrderId }, { status: 201 });
});
