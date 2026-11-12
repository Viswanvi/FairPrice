import { headers } from "next/headers";
import { z } from "zod";
import { assistantData } from "@/lib/assistant/data";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { ASSISTANT_TOOLS, runTool } from "@/lib/assistant/tools";
import { currentSellerId } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { clientIp, displayCountry } from "@/lib/geo/country";
import { HttpError, readJson, route } from "@/lib/http";

/**
 * POST /api/alex/tool — runs one of Alex's tool calls with the SAME tools the Claude assistant
 * uses (lib/assistant/tools.ts): search with server-computed prices, open a page, fill the
 * seller form, press a safe setup button, point at something. Nothing can pay, approve, change
 * a price or touch a password. Called by the visitor's browser, so the seller session and display
 * country are the visitor's own.
 */

export const dynamic = "force-dynamic";

const TOOL_NAMES = ASSISTANT_TOOLS.map((t) => t.name) as [string, ...string[]];
const bodySchema = z.object({
  name: z.enum(TOOL_NAMES),
  args: z.record(z.string(), z.unknown()).default({}),
  path: z.string().max(300).startsWith("/"),
});

const limiter = createRateLimiter({ limit: 120, windowMs: 10 * 60_000 });

export const POST = route(async (request: Request) => {
  const body = await readJson(request, bodySchema);
  const h = await headers();
  if (!limiter.take(clientIp(h) ?? "unknown")) throw new HttpError(429, "rate_limited", "Too many requests. Please wait a minute.");
  const url = new URL(body.path, "http://localhost");
  const geo = await displayCountry({ headers: h, as: url.searchParams.get("as"), overrideEnabled: env.DEMO_GEO_OVERRIDE });
  const outcome = await runTool(
    body.name,
    body.args,
    { displayCountry: geo.country, asParam: geo.overridden ? geo.country : null, sellerId: await currentSellerId(), pathname: url.pathname },
    assistantData,
  );
  return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
});
