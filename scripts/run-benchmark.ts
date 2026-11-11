/**
 * Phase 12: formula-versus-AI benchmark (docs/SPEC.md section 7).
 *
 *   npm run benchmark
 *
 * For each invented product in data/benchmark-products.json: run the real AI pipeline once
 * (audience analysis → pricing → validator → formula fallback for failing rows) next to the
 * formula, compute the comparison, and write data/benchmark-results.json — committed, so the
 * demo never waits on the AI. Costs roughly $0.08 per product on Claude Sonnet 5.5.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { aiScriptEnvSchema, EnvError, parseEnv } from "../lib/env-schema";
import { analyzeAudience, priceCountries, type AiDeps } from "../lib/pricing/ai";
import {
  benchmarkFileSchema,
  DEEP_DISCOUNT_PCT,
  summarizeBenchmark,
  type BenchmarkFile,
  type BenchmarkProduct,
} from "../lib/pricing/benchmark";
import { feeConfig, priceLevelRatio, targetCountries } from "../lib/pricing/data";
import { feeFloorCents } from "../lib/pricing/formula";
import { PROMPT_VERSION } from "../lib/pricing/prompts";

const productsSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string(),
      baseCents: z.number().int(),
      minCents: z.number().int(),
      maxDiscountPct: z.number(),
      goal: z.enum(["revenue", "reach"]),
    }),
  ),
});
type Input = z.infer<typeof productsSchema>["products"][number];

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function benchmarkOne(deps: AiDeps, p: Input, floor: number): Promise<BenchmarkProduct> {
  const started = Date.now();
  const audience = await analyzeAudience(deps, `${p.title}\n\n${p.description}`);
  const targets = targetCountries();
  const pricing = await priceCountries(deps, {
    product: p,
    profile: audience.profile,
    targets,
    ratios: new Map(targets.map((t) => [t.code, priceLevelRatio(t.code)])),
    fees: feeConfig(),
  });
  const formula = new Map(pricing.formulaRows.map((r) => [r.country, r]));
  const rows = pricing.rows.map((r) => ({
    country: r.country,
    region: r.region,
    relevance: r.relevance,
    formulaPriceCents: formula.get(r.country)!.priceCents,
    formulaDiscountPct: formula.get(r.country)!.discountPct,
    aiPriceCents: r.priceCents,
    aiDiscountPct: r.discountPct,
    reason: r.reason,
    flags: r.flags,
  }));
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description,
    baseCents: p.baseCents,
    minCents: p.minCents,
    maxDiscountPct: p.maxDiscountPct,
    goal: p.goal,
    audience: audience.profile,
    productSummary: pricing.productSummary,
    rows,
    ...summarizeBenchmark(rows, floor),
    meta: {
      fallbackCountries: pricing.meta.fallbackCountries,
      reasked: pricing.meta.reasked,
      latencyMs: Date.now() - started,
      models: [...new Set([...audience.meta.stats.models, ...pricing.meta.stats.models])],
    },
  };
}

async function main(): Promise<void> {
  const env = parseEnv(aiScriptEnvSchema, process.env);
  const inputs = productsSchema.parse(
    JSON.parse(readFileSync(path.join(process.cwd(), "data", "benchmark-products.json"), "utf8")),
  ).products;
  const deps: AiDeps = {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }),
    model: env.AI_MODEL,
  };
  const floor = feeFloorCents(feeConfig());
  console.log(`Benchmark: ${inputs.length} products · model ${env.AI_MODEL} · prompts ${PROMPT_VERSION}\n`);

  const products: BenchmarkProduct[] = [];
  for (const p of inputs) {
    let result: BenchmarkProduct | null = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        result = await benchmarkOne(deps, p, floor);
      } catch (error) {
        console.log(`  ${p.id}: attempt ${attempt} failed — ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!result) throw new Error(`Benchmark failed for ${p.id}; nothing written.`);
    products.push(result);

    const c = result.counts;
    const avg = result.averageDiscountByRelevance;
    console.log(`${p.id} (${(result.meta.latencyMs / 1000).toFixed(0)}s${result.meta.fallbackCountries.length ? `, ${result.meta.fallbackCountries.length} formula fallback rows` : ""})`);
    console.log(`  >${DEEP_DISCOUNT_PCT}% off in low-relevance countries: formula ${c.deepDiscountLowRelevance.formula} · AI ${c.deepDiscountLowRelevance.ai}`);
    console.log(`  below the ${usd(floor)} fee floor:                formula ${c.belowFeeFloor.formula} · AI ${c.belowFeeFloor.ai}`);
    console.log(`  avg discount  high ${avg.high.formula}% → ${avg.high.ai}% · medium ${avg.medium.formula}% → ${avg.medium.ai}% · low ${avg.low.formula}% → ${avg.low.ai}%  (formula → AI)`);
    for (const code of result.biggestDifferences) {
      const r = result.rows.find((x) => x.country === code)!;
      console.log(`  ${code} (${r.relevance}): formula ${usd(r.formulaPriceCents)} → AI ${usd(r.aiPriceCents)} — ${r.reason}`);
    }
    console.log("");
  }

  const file: BenchmarkFile = benchmarkFileSchema.parse({
    note:
      "Five INVENTED products priced for 42 countries by the purchasing-power formula and by FairPrice's AI (checked by the same validator). " +
      "Generated by scripts/run-benchmark.ts against the real API. Descriptive only: there is no sales data, so no conversion or revenue claims.",
    generatedAt: new Date().toISOString(),
    model: env.AI_MODEL,
    promptVersion: PROMPT_VERSION,
    feeFloorCents: floor,
    deepDiscountPct: DEEP_DISCOUNT_PCT,
    products,
  });
  writeFileSync(path.join(process.cwd(), "data", "benchmark-results.json"), JSON.stringify(file, null, 2) + "\n", "utf8");
  console.log("Wrote data/benchmark-results.json");
}

main().catch((error: unknown) => {
  console.error(error instanceof EnvError ? error.message : error instanceof Error ? error.message : error);
  process.exit(1);
});
