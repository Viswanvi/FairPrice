import { loadCheckoutProduct } from "@/lib/checkout/create";
import { buildQuote } from "@/lib/checkout/quote";
import { env } from "@/lib/env";
import { displayCountry } from "@/lib/geo/country";
import { HttpError, route } from "@/lib/http";

/**
 * GET /api/quote?productId=…[&as=XX] — the approved price for the visitor's display country.
 * The country comes from the IP (or the demo override); it only sets the SHOWN price.
 */
export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  if (!productId) throw new HttpError(400, "invalid_request", "productId is required.");

  const { product, table } = await loadCheckoutProduct(productId);
  const geo = await displayCountry({
    headers: request.headers,
    as: url.searchParams.get("as"),
    overrideEnabled: env.DEMO_GEO_OVERRIDE,
  });
  return Response.json(buildQuote(product, table, geo), { headers: { "Cache-Control": "no-store" } });
});
