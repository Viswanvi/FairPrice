import type { Order } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { HttpError } from "@/lib/http";
import { insertOrderRow } from "./create";

/**
 * Reserve a re-offer order for a voided order. The price is read from the voided row's
 * offer_cents — never from the request (SPEC section 9). One re-offer per voided order: the
 * voided row is locked while we check, so two clicks can't create two orders.
 *
 * Returns either the existing PayPal order ID, or a new order row (status CREATED) that still
 * needs its PayPal order (attachPayPalOrder).
 */
export async function reserveReoffer(
  previousOrderId: string,
): Promise<{ existingPaypalOrderId: string } | { order: Order; tableVersion: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${previousOrderId} FOR UPDATE`;
      const previous = await tx.order.findUnique({ where: { id: previousOrderId }, include: { priceTable: true } });
      if (!previous) throw new HttpError(404, "not_found", "We couldn't find that checkout, so nothing was charged.");
      const offer = previous.offerCents ?? 0;
      if (previous.status !== "VOIDED" || offer <= 0 || !previous.decision || previous.decision === "MATCH" || previous.decision === "TRAVELER") {
        throw new HttpError(409, "no_offer", "There's no price to offer for this checkout.");
      }

      const existing = await tx.order.findFirst({ where: { previousOrderId: previous.id } });
      if (existing) {
        if (existing.paypalOrderId) return { existingPaypalOrderId: existing.paypalOrderId };
        throw new HttpError(409, "in_progress", "Your new checkout is being prepared. Please try again in a moment.");
      }

      const order = await insertOrderRow(
        {
          productId: previous.productId,
          priceTableId: previous.priceTableId,
          shownCountry: previous.payerCountry ?? previous.shownCountry,
          shownCents: offer,
          previousOrderId: previous.id,
        },
        tx,
      );
      return { order, tableVersion: previous.priceTable.version };
    },
    { timeout: 15_000 },
  );
}
