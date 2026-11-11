import { requireSeller } from "@/lib/auth/session";
import { createDraftTable } from "@/lib/db/price-tables";
import { getOwnedProduct } from "@/lib/db/products";
import { HttpError, route } from "@/lib/http";
import { AiError, audienceProfileSchema, priceCountries } from "@/lib/pricing/ai";
import { aiDeps, aiHttpError } from "@/lib/pricing/ai-client";
import { feeConfig, priceLevelRatio, targetCountries } from "@/lib/pricing/data";

/**
 * AI call 2 + validator + formula baseline → a new DRAFT price table. Nothing here reaches
 * checkout until the seller approves it (CLAUDE.md rule 5).
 */
export const POST = route(async (_request: Request, ctx: RouteContext<"/api/products/[id]/price-tables">) => {
  const sellerId = await requireSeller();
  const { id } = await ctx.params;
  const product = await getOwnedProduct(id, sellerId);
  if (!product) throw new HttpError(404, "not_found", "Product not found.");

  const profile = audienceProfileSchema.safeParse(product.audienceProfile);
  if (!profile.success) {
    throw new HttpError(409, "analyze_first", "Run the audience analysis before generating prices.");
  }

  const targets = targetCountries();
  let result;
  try {
    result = await priceCountries(aiDeps(), {
      product: {
        baseCents: product.baseCents,
        minCents: product.minCents,
        maxDiscountPct: product.maxDiscountPct,
        goal: product.goal,
      },
      profile: profile.data,
      targets,
      ratios: new Map(targets.map((t) => [t.code, priceLevelRatio(t.code)])),
      fees: feeConfig(),
    });
  } catch (error) {
    if (error instanceof AiError) throw aiHttpError(error);
    throw error;
  }

  const table = await createDraftTable({ productId: product.id, rows: result.rows, formulaRows: result.formulaRows });
  return Response.json(
    {
      priceTableId: table.id,
      version: table.version,
      rows: table.rows,
      formulaRows: table.formulaRows,
      warnings: result.warnings,
      productSummary: result.productSummary,
      meta: {
        promptVersion: result.meta.promptVersion,
        latencyMs: result.meta.latencyMs,
        models: result.meta.stats.models,
        reasked: result.meta.reasked,
        fallbackCountries: result.meta.fallbackCountries,
        aiFailure: result.meta.aiFailure,
      },
    },
    { status: 201 },
  );
});
