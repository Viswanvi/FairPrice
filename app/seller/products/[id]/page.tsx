import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSellerPage } from "@/lib/auth/session";
import { listProductOrders } from "@/lib/db/orders";
import { getApprovedTable, getLatestTable, type StoredPriceTable } from "@/lib/db/price-tables";
import { getOwnedProduct } from "@/lib/db/products";
import { env } from "@/lib/env";
import { audienceProfileSchema } from "@/lib/pricing/ai";
import { checkStoredRows } from "@/lib/pricing/table-check";
import type { ProductView, RowView, TableView } from "./types";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "Product · FairPrice" };

function toTableView(table: StoredPriceTable, product: { baseCents: number; minCents: number; maxDiscountPct: number }): TableView {
  const rows = table.rows as unknown as RowView[];
  return {
    id: table.id,
    version: table.version,
    status: table.status,
    rows,
    formulaRows: table.formulaRows.map((r) => ({ country: r.country, priceCents: r.priceCents, discountPct: r.discountPct })),
    contentHash: table.contentHash,
    approvedAt: table.approvedAt?.toISOString() ?? null,
    warnings: checkStoredRows(rows, product).warnings.map((w) => ({ country: w.country, message: w.message })),
  };
}

export default async function ProductPage({ params }: PageProps<"/seller/products/[id]">) {
  const sellerId = await requireSellerPage();
  const { id } = await params;
  const product = await getOwnedProduct(id, sellerId);
  if (!product) notFound();

  const [latest, approved, orders] = await Promise.all([
    getLatestTable(product.id),
    getApprovedTable(product.id),
    listProductOrders(product.id),
  ]);
  const profile = audienceProfileSchema.safeParse(product.audienceProfile);

  const productView: ProductView = {
    id: product.id,
    title: product.title,
    sourceUrl: product.sourceUrl,
    description: product.description,
    baseCents: product.baseCents,
    minCents: product.minCents,
    maxDiscountPct: product.maxDiscountPct,
    goal: product.goal,
    requirePaypal: product.requirePaypal,
    audienceProfile: profile.success ? profile.data : null,
  };

  return (
    <Workspace
      product={productView}
      latest={latest ? toTableView(latest, product) : null}
      live={
        approved
          ? { id: approved.id, version: approved.version, contentHash: approved.contentHash, approvedAt: approved.approvedAt?.toISOString() ?? null }
          : null
      }
      pageUrl={`${env.APP_BASE_URL}/p/${product.id}`}
      orders={orders}
    />
  );
}
