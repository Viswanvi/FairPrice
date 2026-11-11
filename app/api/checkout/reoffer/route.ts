import { z } from "zod";
import { attachPayPalOrder } from "@/lib/checkout/create";
import { reserveReoffer } from "@/lib/checkout/reoffer";
import { readJson, route } from "@/lib/http";
import { paypalClient } from "@/lib/paypal/server";

// previousOrderId only — the offered price comes from the voided order row, never the body.
const bodySchema = z.object({ previousOrderId: z.string().min(1).max(100) }).strict();

/** POST /api/checkout/reoffer — a new PayPal order at the price offered after a void. */
export const POST = route(async (request: Request) => {
  const { previousOrderId } = await readJson(request, bodySchema);
  const reserved = await reserveReoffer(previousOrderId);
  if ("existingPaypalOrderId" in reserved) {
    return Response.json({ paypalOrderId: reserved.existingPaypalOrderId });
  }
  const { paypalOrderId } = await attachPayPalOrder(reserved.order, reserved.tableVersion, paypalClient());
  return Response.json({ paypalOrderId }, { status: 201 });
});
