import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { REGIONS, regionSchema, type TargetCountry } from "./data";
import { netAfterFeesCents } from "./fees";
import { feeFloorCents, formulaTable, type FeeConfig } from "./formula";
import { AUDIENCE_SYSTEM_PROMPT, PRICING_SYSTEM_PROMPT, PROMPT_VERSION, wrapProductPage } from "./prompts";
import { validateTable, type CandidateRow, type ValidatedRow, type ValidationIssue } from "./validator";

/**
 * The two AI calls (docs/SPEC.md section 7) and the pipeline around them.
 *
 * - Structured outputs (`output_config.format` via `beta.messages.parse`) make the API return
 *   JSON in our schema; Zod re-checks it. No `temperature`: the current API rejects sampling
 *   parameters on Claude Sonnet 5.5, so consistency comes from the schema and `effort: "low"`.
 * - Server-side refusal fallback (`fallbacks: "default"`, beta) re-runs a declined request on a
 *   fallback model inside the same call.
 * - JSON/Zod failure → retry once with the error. Validator errors → re-ask once listing them.
 *   Rows still failing → formula price, flagged "formula_fallback".
 * - The model has no tools. AI output becomes a DRAFT table only (CLAUDE.md rule 5).
 *
 * The client is passed in, so tests use a fake without any production switch.
 */

export interface AiClient {
  beta: { messages: { parse: Anthropic["beta"]["messages"]["parse"] } };
}

export interface AiDeps {
  client: AiClient;
  model: string;
}

export type AiErrorCode = "invalid_output" | "refused" | "ai_unavailable";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

const relevance = z.enum(["high", "medium", "low"]);

export const audienceProfileSchema = z.object({
  category: z.string(),
  language: z.string(),
  buyerType: z.enum(["individual", "business"]),
  shareability: z.enum(["low", "medium", "high"]),
  regions: z.array(z.object({ region: regionSchema, relevance, reason: z.string() })),
});
export type AudienceProfile = z.infer<typeof audienceProfileSchema>;

const pricingOutputSchema = z.object({
  productSummary: z.string(),
  rows: z.array(
    z.object({
      country: z.string(),
      priceUsd: z.number(),
      discountPct: z.number(),
      relevance,
      reason: z.string(),
      flags: z.array(z.string()),
    }),
  ),
});
type PricingOutput = z.infer<typeof pricingOutputSchema>;

export interface CallStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose output failed JSON/Zod/shape checks. */
  invalidOutputs: number;
  /** Models that actually answered (differs from the requested model after a fallback). */
  models: string[];
}

const newStats = (): CallStats => ({ calls: 0, inputTokens: 0, outputTokens: 0, invalidOutputs: 0, models: [] });

const MAX_TOKENS = 16_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** One structured call, retried once if the output can't be used. */
async function callStructured<S extends z.ZodType>(
  deps: AiDeps,
  stats: CallStats,
  request: { system: string; user: string; schema: S; check?: (data: z.infer<S>) => string[] },
): Promise<z.infer<S>> {
  let note = "";
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    stats.calls++;
    let response;
    try {
      response = await deps.client.beta.messages.parse({
        model: deps.model,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(request.schema) },
        system: request.system,
        messages: [{ role: "user", content: request.user + note }],
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        // The SDK has already retried rate limits, timeouts and 5xx errors.
        throw new AiError("ai_unavailable", `The AI service returned an error (${error.status ?? "network"}).`);
      }
      stats.invalidOutputs++;
      problem = error instanceof Error ? error.message : String(error);
      note = retryNote(problem);
      continue;
    }

    stats.inputTokens += response.usage?.input_tokens ?? 0;
    stats.outputTokens += response.usage?.output_tokens ?? 0;
    if (response.model && !stats.models.includes(response.model)) stats.models.push(response.model);

    if (response.stop_reason === "refusal") {
      throw new AiError("refused", "The AI declined to answer this request.");
    }
    if (response.stop_reason === "max_tokens") {
      problem = "the reply was cut off before it finished";
    } else {
      const parsed = request.schema.safeParse(response.parsed_output);
      if (!parsed.success) {
        problem = `the reply didn't match the required JSON shape (${parsed.error.issues[0]?.message ?? "invalid"})`;
      } else {
        const issues = request.check?.(parsed.data) ?? [];
        if (issues.length === 0) return parsed.data;
        problem = issues.join("; ");
      }
    }
    stats.invalidOutputs++;
    note = retryNote(problem);
  }
  throw new AiError("invalid_output", `The AI's reply couldn't be used: ${problem}`);
}

function retryNote(problem: string): string {
  return `\n\nYour previous reply could not be used: ${problem}. Reply again with JSON that follows the required shape exactly.`;
}

// ---------- Call 1: audience analysis ----------

export interface AudienceResult {
  profile: AudienceProfile;
  meta: { promptVersion: string; truncated: boolean; latencyMs: number; stats: CallStats };
}

function regionCoverageIssues(profile: AudienceProfile): string[] {
  const counts = new Map<string, number>();
  for (const r of profile.regions) counts.set(r.region, (counts.get(r.region) ?? 0) + 1);
  const missing = REGIONS.filter((r) => !counts.has(r));
  const repeated = [...counts].filter(([, n]) => n > 1).map(([r]) => r);
  return [
    ...(missing.length ? [`regions missing: ${missing.join(", ")}`] : []),
    ...(repeated.length ? [`regions listed more than once: ${repeated.join(", ")}`] : []),
  ];
}

export async function analyzeAudience(deps: AiDeps, productText: string): Promise<AudienceResult> {
  const started = Date.now();
  const stats = newStats();
  const { wrapped, truncated } = wrapProductPage(productText);
  const profile = await callStructured(deps, stats, {
    system: AUDIENCE_SYSTEM_PROMPT,
    user: `Analyze who buys this product.\n\n${wrapped}`,
    schema: audienceProfileSchema,
    check: regionCoverageIssues,
  });
  // Present regions in the canonical order.
  profile.regions.sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
  return { profile, meta: { promptVersion: PROMPT_VERSION, truncated, latencyMs: Date.now() - started, stats } };
}

// ---------- Call 2: country pricing ----------

export interface PricingInput {
  product: { baseCents: number; minCents: number; maxDiscountPct: number; goal: "revenue" | "reach" };
  profile: AudienceProfile;
  targets: ReadonlyArray<TargetCountry>;
  ratios: ReadonlyMap<string, number | null>;
  fees: FeeConfig;
}

export interface PricedRow extends ValidatedRow {
  region: string;
  formulaPriceCents: number;
  netCents: number;
}

export interface PricingResult {
  productSummary: string;
  rows: PricedRow[];
  formulaRows: { country: string; priceCents: number; discountPct: number; flags: string[] }[];
  warnings: ValidationIssue<"price_inversion">[];
  meta: {
    promptVersion: string;
    latencyMs: number;
    stats: CallStats;
    /** Validator errors in the AI's first answer, and after the re-ask (before fallback). */
    firstErrors: number;
    finalErrors: number;
    reasked: boolean;
    fallbackCountries: string[];
    /** Set when the AI produced no usable table at all and every row is the formula price. */
    aiFailure: AiErrorCode | null;
  };
}

const toCents = (usd: number) => Math.round(usd * 100);
const toUsd = (cents: number) => Math.round(cents) / 100;

function toCandidates(output: PricingOutput): CandidateRow[] {
  return output.rows.map((r) => ({
    country: r.country,
    priceCents: Number.isFinite(r.priceUsd) ? toCents(r.priceUsd) : Number.NaN,
    discountPct: r.discountPct,
    relevance: r.relevance,
    reason: r.reason.trim(),
    flags: r.flags,
  }));
}

export async function priceCountries(deps: AiDeps, input: PricingInput): Promise<PricingResult> {
  const started = Date.now();
  const stats = newStats();
  const { product, profile, targets, ratios, fees } = input;
  const floorCents = feeFloorCents(fees);
  const formula = formulaTable(
    product,
    targets.map((t) => ({ code: t.code, ratio: ratios.get(t.code) ?? null })),
    fees,
  );
  const formulaByCountry = new Map(formula.map((r) => [r.country, r]));
  const regionRelevance = new Map(profile.regions.map((r) => [r.region, r.relevance]));
  const validate = (rows: CandidateRow[]) =>
    validateTable({ rows, product, targets: targets.map((t) => t.code), ratios, feeFloorCents: floorCents });

  const request = {
    basePriceUsd: toUsd(product.baseCents),
    minPriceUsd: toUsd(product.minCents),
    maxDiscountPct: product.maxDiscountPct,
    goal: product.goal,
    audienceProfile: profile,
    countries: targets.map((t) => ({
      code: t.code,
      region: t.region,
      priceLevelRatio: ratios.get(t.code) ?? null,
      formulaPriceUsd: toUsd(formulaByCountry.get(t.code)!.priceCents),
      feeFloorUsd: toUsd(floorCents),
    })),
  };
  const user = `Price this product for every country below.\n\n${JSON.stringify(request, null, 2)}`;

  let output: PricingOutput | null = null;
  let aiFailure: AiErrorCode | null = null;
  let firstErrors = 0;
  let finalErrors = 0;
  let reasked = false;

  try {
    output = await callStructured(deps, stats, { system: PRICING_SYSTEM_PROMPT, user, schema: pricingOutputSchema });
    const first = validate(toCandidates(output));
    firstErrors = finalErrors = first.errors.length;
    if (first.errors.length > 0) {
      reasked = true;
      const list = first.errors.map((e) => `- ${e.message}`).join("\n");
      try {
        const second = await callStructured(deps, stats, {
          system: PRICING_SYSTEM_PROMPT,
          user: `${user}\n\nYour previous table broke these rules:\n${list}\nFix those rows and return the full table again.`,
          schema: pricingOutputSchema,
        });
        const secondErrors = validate(toCandidates(second)).errors.length;
        if (secondErrors <= first.errors.length) {
          output = second;
          finalErrors = secondErrors;
        }
      } catch (error) {
        if (error instanceof AiError && error.code === "ai_unavailable") throw error;
        // Keep the first answer; its failing rows fall back to the formula below.
      }
    }
  } catch (error) {
    if (!(error instanceof AiError) || error.code === "ai_unavailable") throw error;
    aiFailure = error.code; // invalid output or refusal: the whole table uses the formula
  }

  // Merge: valid AI rows, formula for everything else.
  const checked = output ? validate(toCandidates(output)) : null;
  const failing = new Set(checked?.errors.map((e) => e.country) ?? []);
  const aiRows = new Map((checked?.rows ?? []).filter((r) => !failing.has(r.country)).map((r) => [r.country, r]));
  const fallbackCountries: string[] = [];

  const merged: CandidateRow[] = targets.map((t) => {
    const ai = aiRows.get(t.code);
    if (ai) return ai;
    fallbackCountries.push(t.code);
    const f = formulaByCountry.get(t.code)!;
    const why = aiFailure
      ? "the AI didn't return a usable table"
      : (checked?.errors.find((e) => e.country === t.code)?.message ?? "the AI didn't price this country");
    return {
      country: t.code,
      priceCents: f.priceCents,
      relevance: regionRelevance.get(t.region as (typeof REGIONS)[number]) ?? "medium",
      reason: `Formula price used because ${why}.`,
      flags: [...f.flags, "formula_fallback"],
    };
  });

  const final = validate(merged);
  if (final.errors.length > 0) {
    // Formula rows satisfy every rule by construction; reaching this is a bug.
    throw new Error(`Merged price table failed validation: ${final.errors.map((e) => e.message).join("; ")}`);
  }

  const regionOf = new Map(targets.map((t) => [t.code, t.region]));
  return {
    productSummary: output?.productSummary.trim() ?? "",
    rows: final.rows.map((r) => ({
      ...r,
      region: regionOf.get(r.country)!,
      formulaPriceCents: formulaByCountry.get(r.country)!.priceCents,
      netCents: netAfterFeesCents(r.priceCents, fees, r.country),
    })),
    formulaRows: formula,
    warnings: final.warnings,
    meta: {
      promptVersion: PROMPT_VERSION,
      latencyMs: Date.now() - started,
      stats,
      firstErrors,
      finalErrors,
      reasked,
      fallbackCountries,
      aiFailure,
    },
  };
}
