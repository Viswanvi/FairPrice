/**
 * Seed the demo seller and demo product. Safe to run repeatedly (upserts with fixed IDs).
 * Run with `npm run db:seed` (Prisma loads DATABASE_URL from .env).
 *
 * No price table is seeded: the AI generates one and the seller approves it (Phase 9/10).
 * Benchmark products live in data/benchmark-products.json and are read from there.
 */
import { PrismaClient } from "@prisma/client";
import { DEMO_PRODUCT_ID, DEMO_SELLER_ID } from "../lib/db/demo";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const seller = await prisma.seller.upsert({
    where: { id: DEMO_SELLER_ID },
    update: { name: "Demo Seller" },
    create: { id: DEMO_SELLER_ID, name: "Demo Seller" },
  });

  const productData = {
    sellerId: seller.id,
    title: "Full-Stack JavaScript Bootcamp",
    sourceUrl: null,
    description:
      "An invented demo product: a self-paced online bootcamp covering HTML, CSS, JavaScript, " +
      "React, Node.js and databases, with weekly projects, code reviews and a final portfolio app. " +
      "Lessons are in English with subtitles, and lifetime access is included.",
    baseCents: 9900,
    minCents: 1500,
    maxDiscountPct: 70,
    goal: "reach" as const,
    requirePaypal: true,
  };
  const product = await prisma.product.upsert({
    where: { id: DEMO_PRODUCT_ID },
    update: productData,
    create: { id: DEMO_PRODUCT_ID, ...productData },
  });

  console.log(`Seeded seller "${seller.name}" (${seller.id})`);
  console.log(`Seeded product "${product.title}" (${product.id}): base ${product.baseCents} cents`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
