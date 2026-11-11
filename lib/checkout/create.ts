import type { Order, Product } from "@prisma/client";
import { insertAuditLog } from "@/lib/db/audit-log";
import { prisma, type Db } from "@/lib/db/client";
import { getApprovedTable, type StoredPriceTable } from "@/lib/db/price-tables";
import { HttpError } from "@/lib/http";
import type { PayPalClient } from "@/lib/paypal/client";
import { PayPalError } from "@/lib/paypal/errors";
import { customIdFor } from "./pricing";

/**
 * Creating checkout orders. The server owns every amount (CLAUDE.md rule 1): callers pass the
 * price they resolved from the APPROVED table (or a stored offer), never a browser value.
 */

/** A product that can be bought: exists and has an approved price table. */
export async function loadCheckoutProduct(productId: string): Promise<{ product: Product; table: StoredPriceTable }> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new HttpError(404, "not_found", "This product doesn't exist.");
  const table = await getApprovedTable(product.id);
  if (!table) throw new HttpError(409, "not_available", "This product isn't on sale yet.");
  return { product, table };
}

export interface NewOrder {
  productId: string;
  priceTableId: string;
  shownCountry: string | null;
  shownCents: number;
  previousOrderId?: string | null;
}

export function insertOrderRow(data: NewOrder, db: Db = prisma): Promise<Order> {
  return db.order.create({
    data: {
      productId: data.productId,
      priceTableId: data.priceTableId,
      shownCountry: data.shownCountry,
      shownCents: data.shownCents,
      previousOrderId: data.previousOrderId ?? null,
      status: "CREATED",
    },
  });
}

/**
 * Create the PayPal order for an order row and store its ID. If PayPal fails, nothing was
 * approved or charged, so the row is deleted (the audit log keeps the attempt).
 */
export async function attachPayPalOrder(
  order: Order,
  tableVersion: number,
  paypal: Pick<PayPalClient, "createOrder">,
): Promise<{ orderId: string; paypalOrderId: string }> {
  const requestId = `${order.id}:create`;
  try {
    const created = await paypal.createOrder({
      amountCents: order.shownCents,
      customId: customIdFor(order.productId, tableVersion, order.shownCountry),
      invoiceId: `fp-${order.id}`,
      requestId,
    });
    await prisma.order.update({ where: { id: order.id }, data: { paypalOrderId: created.id } });
    await insertAuditLog({
      orderId: order.id,
      step: "create",
      requestId,
      outcome: created.status,
      detail: { paypalOrderId: created.id, amountCents: order.shownCents, shownCountry: order.shownCountry },
    });
    return { orderId: order.id, paypalOrderId: created.id };
  } catch (error) {
    await insertAuditLog({
      orderId: order.id,
      step: "create",
      requestId,
      outcome: error instanceof PayPalError ? `ERROR ${error.paypalName}` : "ERROR",
      detail: error instanceof PayPalError ? { status: error.status, debugId: error.debugId, issue: error.issue } : undefined,
    }).catch(() => undefined);
    await prisma.order.delete({ where: { id: order.id } }).catch(() => undefined);
    if (error instanceof PayPalError) {
      throw new HttpError(502, "paypal_unavailable", "We couldn't start the PayPal checkout. Please try again.");
    }
    throw error;
  }
}
