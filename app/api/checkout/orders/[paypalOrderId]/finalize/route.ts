import { finalizeOrder } from "@/lib/checkout/finalizeOrder";
import { HttpError, route } from "@/lib/http";
import { paypalClient } from "@/lib/paypal/server";

/**
 * POST /api/checkout/orders/:paypalOrderId/finalize — authorize, read the payer country, decide,
 * capture or void. Idempotent: calling it again returns the stored result with no PayPal calls.
 */
export const POST = route(async (_request: Request, ctx: RouteContext<"/api/checkout/orders/[paypalOrderId]/finalize">) => {
  const { paypalOrderId } = await ctx.params;
  if (!/^[A-Z0-9]{5,40}$/.test(paypalOrderId)) throw new HttpError(400, "invalid_request", "That isn't a valid PayPal order ID.");
  const result = await finalizeOrder(paypalOrderId, { paypal: paypalClient() });
  return Response.json(result);
});
