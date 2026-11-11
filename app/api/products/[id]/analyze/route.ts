import type { Prisma } from "@prisma/client";
import { requireSeller } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getOwnedProduct } from "@/lib/db/products";
import { HttpError, route } from "@/lib/http";
import { AiError, analyzeAudience } from "@/lib/pricing/ai";
import { aiDeps, aiHttpError } from "@/lib/pricing/ai-client";
import { fetchProductPageText, PageFetchError } from "@/lib/pricing/page-text";

/** AI call 1: who buys this product. Stores the profile on the product. */
export const POST = route(async (_request: Request, ctx: RouteContext<"/api/products/[id]/analyze">) => {
  const sellerId = await requireSeller();
  const { id } = await ctx.params;
  const product = await getOwnedProduct(id, sellerId);
  if (!product) throw new HttpError(404, "not_found", "Product not found.");

  let pageText = "";
  let pageNote: string | null = null;
  if (product.sourceUrl) {
    try {
      pageText = (await fetchProductPageText(product.sourceUrl)).text;
    } catch (error) {
      if (!(error instanceof PageFetchError)) throw error;
      if (!product.description) throw new HttpError(422, "page_fetch_failed", error.message);
      pageNote = `We couldn't read the product link (${error.message}), so we used your description.`;
    }
  }
  const text = [product.title, product.description ?? "", pageText].filter(Boolean).join("\n\n");

  try {
    const { profile, meta } = await analyzeAudience(aiDeps(), text);
    await prisma.product.update({
      where: { id: product.id },
      data: { audienceProfile: profile as Prisma.InputJsonValue },
    });
    return Response.json({
      audienceProfile: profile,
      notes: [pageNote, meta.truncated ? "Your product text was long, so only the first part was analyzed." : null].filter(
        Boolean,
      ),
      meta: { promptVersion: meta.promptVersion, latencyMs: meta.latencyMs, models: meta.stats.models },
    });
  } catch (error) {
    if (error instanceof AiError) throw aiHttpError(error);
    throw error;
  }
});
