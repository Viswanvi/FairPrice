import "server-only";
import { prisma } from "@/lib/db/client";
import { priceRowsSchema } from "@/lib/db/types";
import type { AssistantData, PublishedProduct, SellerProductSummary } from "./tools";

/** Database access for the assistant's tools. Only products with an APPROVED table are on sale. */
export const assistantData: AssistantData = {
  async publishedProducts(): Promise<PublishedProduct[]> {
    const products = await prisma.product.findMany({
      where: { priceTables: { some: { status: "approved" } } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        description: true,
        baseCents: true,
        priceTables: { where: { status: "approved" }, orderBy: { version: "desc" }, take: 1, select: { rows: true } },
      },
    });
    return products.flatMap((p) => {
      const rows = priceRowsSchema.safeParse(p.priceTables[0]?.rows);
      if (!rows.success) return [];
      return [{ id: p.id, title: p.title, description: p.description, baseCents: p.baseCents, rows: rows.data }];
    });
  },

  async sellerProducts(sellerId: string): Promise<SellerProductSummary[]> {
    const products = await prisma.product.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true, priceTables: { orderBy: { version: "desc" }, select: { status: true } } },
    });
    return products.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.priceTables.some((t) => t.status === "approved")
        ? "approved"
        : p.priceTables.length > 0
          ? "draft"
          : "no_prices",
    }));
  },
};
