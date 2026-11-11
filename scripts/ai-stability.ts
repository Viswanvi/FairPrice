/**
 * Phase 9: AI stability check (docs/SPEC.md section 12, contract tests).
 *
 *   npm run ai:stability -- --runs 3 [--product bench-us-tax-guide] [--concurrency 3]
 *
 * Runs the full pipeline (audience analysis → pricing → validator → fallback) N times per
 * benchmark product with the real API and reports: schema pass rate (share of AI calls whose
 * output was usable first time), validator errors in the AI's first table and after the
 * re-ask, rows that fell back to the formula, latency, tokens, and India/Brazil discounts.
 * Every run costs money — default is 3 runs per product. Writes data/ai-stability-results.json.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { aiScriptEnvSchema, EnvError, parseEnv } from "../lib/env-schema";
import { AiError, analyzeAudience, priceCountries, type AiDeps } from "../lib/pricing/ai";
import { feeConfig, priceLevelRatio, targetCountries } from "../lib/pricing/data";
import { PROMPT_VERSION } from "../lib/pricing/prompts";

const productsSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      baseCents: z.number().int(),
      minCents: z.number().int(),
      maxDiscountPct: z.number(),
      goal: z.enum(["revenue", "reach"]),
    }),
  ),
});
type BenchProduct = z.infer<typeof productsSchema>["products"][number];

// Published per-million-token prices, for a rough cost line only.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-haiku-5-5": [0.1, 0.5],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface RunResult {
  product: string;
  run: number;
  ok: boolean;
  error?: string;
  calls: number;
  invalidOutputs: number;
  firstErrors: number;
  finalErrors: number;
  reasked: boolean;
  fallbackRows: number;
  aiFailure: string | null;
  warnings: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  models: string[];
  discounts: Record<string, number>;
}

const WATCH = ["US", "IN", "BR", "NG", "DE", "JP"];

async function runOnce(deps: AiDeps, product: BenchProduct, run: number): Promise<RunResult> {
  const started = Date.now();
  const base: RunResult = {
    product: product.id, run, ok: false, calls: 0, invalidOutputs: 0, firstErrors: 0, finalErrors: 0,
    reasked: false, fallbackRows: 0, aiFailure: null, warnings: 0, latencyMs: 0, inputTokens: 0,
    outputTokens: 0, models: [], discounts: {},
  };
  try {
    const audience = await analyzeAudience(deps, `${product.title}\n\n${product.description}`);
    const targets = targetCountries();
    const pricing = await priceCountries(deps, {
      product,
      profile: audience.profile,
      targets,
      ratios: new Map(targets.map((t) => [t.code, priceLevelRatio(t.code)])),
      fees: feeConfig(),
    });
    const s1 = audience.meta.stats;
    const s2 = pricing.meta.stats;
    return {
      ...base,
      ok: true,
      calls: s1.calls + s2.calls,
      invalidOutputs: s1.invalidOutputs + s2.invalidOutputs,
      firstErrors: pricing.meta.firstErrors,
      finalErrors: pricing.meta.finalErrors,
      reasked: pricing.meta.reasked,
      fallbackRows: pricing.meta.fallbackCountries.length,
      aiFailure: pricing.meta.aiFailure,
      warnings: pricing.warnings.length,
      latencyMs: Date.now() - started,
      inputTokens: s1.inputTokens + s2.inputTokens,
      outputTokens: s1.outputTokens + s2.outputTokens,
      models: [...new Set([...s1.models, ...s2.models])],
      discounts: Object.fromEntries(
        pricing.rows.filter((r) => WATCH.includes(r.country)).map((r) => [r.country, r.discountPct]),
      ),
    };
  } catch (error) {
    return {
      ...base,
      latencyMs: Date.now() - started,
      error: error instanceof AiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error),
    };
  }
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main(): Promise<void> {
  const env = parseEnv(aiScriptEnvSchema, process.env);
  const runs = Number(arg("runs") ?? 3);
  const concurrency = Number(arg("concurrency") ?? 3);
  const only = arg("product");
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("--runs must be 1–50");

  const all = productsSchema.parse(
    JSON.parse(readFileSync(path.join(process.cwd(), "data", "benchmark-products.json"), "utf8")),
  ).products;
  const products = only ? all.filter((p) => p.id === only) : all;
  if (products.length === 0) throw new Error(`No benchmark product ${only}`);

  const deps: AiDeps = {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }),
    model: env.AI_MODEL,
  };
  const tasks = products.flatMap((p) => Array.from({ length: runs }, (_, i) => ({ p, run: i + 1 })));
  console.log(`AI stability: ${products.length} product(s) × ${runs} run(s) = ${tasks.length} pipelines, model ${env.AI_MODEL}, prompts ${PROMPT_VERSION}\n`);

  let done = 0;
  const results = await pool(tasks, concurrency, async ({ p, run }) => {
    const r = await runOnce(deps, p, run);
    done++;
    console.log(
      `  [${String(done).padStart(2)}/${tasks.length}] ${p.id} #${run}: ` +
        (r.ok
          ? `ok · ${(r.latencyMs / 1000).toFixed(1)}s · first-table errors ${r.firstErrors} · fallback rows ${r.fallbackRows} · IN −${r.discounts.IN ?? "?"}% BR −${r.discounts.BR ?? "?"}%`
          : `FAILED · ${r.error}`),
    );
    return r;
  });

  console.log("\nSummary per product");
  const summary = products.map((p) => {
    const rs = results.filter((r) => r.product === p.id);
    const ok = rs.filter((r) => r.ok);
    const calls = ok.reduce((a, r) => a + r.calls, 0);
    const invalid = ok.reduce((a, r) => a + r.invalidOutputs, 0);
    const row = {
      product: p.id,
      runs: rs.length,
      pipelinesOk: ok.length,
      schemaPassRate: calls ? (calls - invalid) / calls : 0,
      avgFirstTableErrors: avg(ok.map((r) => r.firstErrors)),
      reaskRate: ok.length ? ok.filter((r) => r.reasked).length / ok.length : 0,
      avgFallbackRows: avg(ok.map((r) => r.fallbackRows)),
      wholeTableFallbacks: ok.filter((r) => r.aiFailure).length,
      avgWarnings: avg(ok.map((r) => r.warnings)),
      avgLatencySec: avg(ok.map((r) => r.latencyMs / 1000)),
      avgDiscountPct: Object.fromEntries(WATCH.map((c) => [c, avg(ok.map((r) => r.discounts[c] ?? 0))])),
    };
    console.log(
      `  ${p.id.padEnd(24)} pipelines ${row.pipelinesOk}/${row.runs} · schema pass ${(row.schemaPassRate * 100).toFixed(0)}% · ` +
        `first-table errors ${row.avgFirstTableErrors.toFixed(1)} · fallback rows ${row.avgFallbackRows.toFixed(1)} · ` +
        `${row.avgLatencySec.toFixed(1)}s · discounts IN ${row.avgDiscountPct.IN.toFixed(0)}% BR ${row.avgDiscountPct.BR.toFixed(0)}% ` +
        `NG ${row.avgDiscountPct.NG.toFixed(0)}% DE ${row.avgDiscountPct.DE.toFixed(0)}%`,
    );
    return row;
  });

  const input = results.reduce((a, r) => a + r.inputTokens, 0);
  const output = results.reduce((a, r) => a + r.outputTokens, 0);
  const price = PRICES[env.AI_MODEL];
  const cost = price ? (input / 1e6) * price[0] + (output / 1e6) * price[1] : null;
  console.log(
    `\nTokens: ${input} in, ${output} out` + (cost !== null ? ` · estimated cost $${cost.toFixed(2)}` : "") +
      ` · models answering: ${[...new Set(results.flatMap((r) => r.models))].join(", ") || "none"}`,
  );

  writeFileSync(
    path.join(process.cwd(), "data", "ai-stability-results.json"),
    JSON.stringify(
      { note: "Generated by scripts/ai-stability.ts against the real API. Benchmark products are invented.", ranAt: new Date().toISOString(), model: env.AI_MODEL, promptVersion: PROMPT_VERSION, runsPerProduct: runs, summary, runs: results },
      null,
      2,
    ) + "\n",
  );
  console.log("Wrote data/ai-stability-results.json");
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof EnvError ? error.message : error instanceof Error ? error.message : error);
  process.exit(1);
});
