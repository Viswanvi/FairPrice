import type { Product } from "@prisma/client";
import { prisma, type Db } from "./client";

/** A product only if it belongs to this seller (otherwise null, so routes answer 404). */
export async function getOwnedProduct(id: string, sellerId: string, db: Db = prisma): Promise<Product | null> {
  const product = await db.product.findUnique({ where: { id } });
  return product && product.sellerId === sellerId ? product : null;
}
