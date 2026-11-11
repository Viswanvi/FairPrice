import { z } from "zod";
import { requireSeller } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { readJson, route } from "@/lib/http";

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    sourceUrl: z.url({ protocol: /^https?$/ }).max(2000).nullish(),
    description: z.string().trim().max(20_000).nullish(),
    baseCents: z.number().int().min(100).max(1_000_000),
    minCents: z.number().int().min(0),
    maxDiscountPct: z.number().int().min(0).max(95),
    goal: z.enum(["revenue", "reach"]),
    requirePaypal: z.boolean().default(true),
  })
  .refine((b) => b.minCents <= b.baseCents, { message: "minimum price can't be above the base price", path: ["minCents"] })
  .refine((b) => Boolean(b.sourceUrl || b.description), {
    message: "add a product link or a description",
    path: ["description"],
  });

/** Create a product (seller only). Amounts are whole US cents. */
export const POST = route(async (request: Request) => {
  const sellerId = await requireSeller();
  const body = await readJson(request, bodySchema);
  const product = await prisma.product.create({
    data: {
      sellerId,
      title: body.title,
      sourceUrl: body.sourceUrl ?? null,
      description: body.description || null,
      baseCents: body.baseCents,
      minCents: body.minCents,
      maxDiscountPct: body.maxDiscountPct,
      goal: body.goal,
      requirePaypal: body.requirePaypal,
    },
  });
  return Response.json({ productId: product.id }, { status: 201 });
});
