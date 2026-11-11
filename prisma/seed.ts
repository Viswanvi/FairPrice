/**
 * Seed the demo seller, the demo product and the five benchmark products. Safe to run
 * repeatedly: fixed IDs, upserts, and a benchmark product only gets a table if it has none.
 *
 *   Local:    npm run db:seed            (Prisma loads DATABASE_URL from .env)
 *   Deployed: run once from your machine with DATABASE_URL set to the Render database's
 *             External URL — see README "Deploy to Render".
 *
 * The demo product gets no price table: the AI generates one and the seller approves it.
 * Each benchmark product gets its committed AI table (data/benchmark-results.json) as an
 * unapproved DRAFT version 1, checked by the validator first. Nothing seeded here reaches
 * checkout until a seller approves it (CLAUDE.md rule 5).
 */
import type { Prisma } from "@prisma/client";
import benchmarkJson from "../data/benchmark-results.json";
import { prisma } from "../lib/db/client";
import { DEMO_PRODUCT_ID, DEMO_SELLER_ID } from "../lib/db/demo";
import { createDraftTable } from "../lib/db/price-tables";
import { benchmarkFileSchema } from "../lib/pricing/benchmark";
import { benchmarkDraft } from "../lib/pricing/benchmark-draft";

async function seedDemo(): Promise<void> {
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

async function seedBenchmarkProducts(): Promise<void> {
  const benchmark = benchmarkFileSchema.parse(benchmarkJson);
  for (const p of benchmark.products) {
    const draft = benchmarkDraft(p); // throws on stale or rule-breaking data: nothing is written

    // An existing product is left exactly as the seller has it.
    await prisma.product.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        sellerId: DEMO_SELLER_ID,
        title: p.title,
        sourceUrl: null,
        description: p.description,
        baseCents: p.baseCents,
        minCents: p.minCents,
        maxDiscountPct: p.maxDiscountPct,
        goal: p.goal,
        requirePaypal: true,
        audienceProfile: draft.audienceProfile as Prisma.InputJsonValue,
      },
    });

    const existing = await prisma.priceTable.count({ where: { productId: p.id } });
    if (existing > 0) {
      console.log(`Benchmark product ${p.id}: already has a price table, left as is`);
      continue;
    }
    const table = await createDraftTable({ productId: p.id, rows: draft.rows, formulaRows: draft.formulaRows });
    console.log(`Benchmark product ${p.id}: DRAFT version ${table.version} with ${draft.rows.length} countries`);
  }
}

async function main(): Promise<void> {
  await seedDemo();
  await seedBenchmarkProducts();
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
