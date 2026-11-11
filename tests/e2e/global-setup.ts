import { prisma } from "../../lib/db/client";
import { DEMO_SELLER_ID } from "../../lib/db/demo";
import { approveTable, createDraftTable } from "../../lib/db/price-tables";
import { E2E, formulaRows, tableRows } from "./fixtures";
import globalTeardown from "./global-teardown";

/** Seed the e2e products (removing leftovers from an interrupted run first). */
export default async function globalSetup(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI: DATABASE_URL comes from the environment.
  }
  await globalTeardown();

  await prisma.seller.upsert({ where: { id: DEMO_SELLER_ID }, update: {}, create: { id: DEMO_SELLER_ID, name: "Demo Seller" } });
  const product = (id: string, title: string) =>
    prisma.product.create({
      data: {
        id,
        sellerId: DEMO_SELLER_ID,
        title,
        description: "E2E test product. A self-paced course used only by the automated browser tests.",
        baseCents: 9900,
        minCents: 1500,
        maxDiscountPct: 70,
        goal: "reach",
        requirePaypal: true,
      },
    });

  await product(E2E.buyerProduct, "E2E buyer course");
  const buyerTable = await createDraftTable({ productId: E2E.buyerProduct, rows: tableRows, formulaRows });
  await approveTable(buyerTable.id);

  await product(E2E.sellerProduct, "E2E seller course");
  await prisma.product.update({
    where: { id: E2E.sellerProduct },
    data: {
      audienceProfile: {
        category: "E2E course",
        language: "English",
        buyerType: "individual",
        shareability: "medium",
        regions: [{ region: "South Asia", relevance: "high", reason: "E2E reason." }],
      },
    },
  });
  await createDraftTable({ productId: E2E.sellerProduct, rows: tableRows, formulaRows });

  await product(E2E.unpublishedProduct, "E2E unpublished course");
  await prisma.$disconnect();
}
