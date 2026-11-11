import type { OrderDecision, OrderStatus } from "@prisma/client";
import { prisma, type Db } from "./client";

/**
 * One order as the seller dashboard shows it: the decision, the amounts, the PayPal IDs and
 * the exact approved table version (and its hash) that priced it. No buyer personal data
 * exists in the database to begin with — only countries and PayPal IDs.
 */
export interface OrderView {
  id: string;
  createdAt: string;
  shownCountry: string | null;
  payerCountry: string | null;
  shownCents: number;
  eligibleCents: number | null;
  chargedCents: number | null;
  offerCents: number | null;
  decision: OrderDecision | null;
  status: OrderStatus;
  paymentType: string | null;
  paypalOrderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  previousOrderId: string | null;
  tableVersion: number;
  tableHash: string;
}

/** Newest orders for a product (default 500), joined to the table version that priced each one. */
export async function listProductOrders(productId: string, limit = 500, db: Db = prisma): Promise<OrderView[]> {
  const orders = await db.order.findMany({
    where: { productId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { priceTable: { select: { version: true, contentHash: true } } },
  });
  return orders.map((o) => ({
    id: o.id,
    createdAt: o.createdAt.toISOString(),
    shownCountry: o.shownCountry,
    payerCountry: o.payerCountry,
    shownCents: o.shownCents,
    eligibleCents: o.eligibleCents,
    chargedCents: o.chargedCents,
    offerCents: o.offerCents,
    decision: o.decision,
    status: o.status,
    paymentType: o.paymentType,
    paypalOrderId: o.paypalOrderId,
    authorizationId: o.authorizationId,
    captureId: o.captureId,
    previousOrderId: o.previousOrderId,
    tableVersion: o.priceTable.version,
    tableHash: o.priceTable.contentHash,
  }));
}
