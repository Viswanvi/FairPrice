import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { alexSystemInstruction, alexTools, ALEX_PROMPT_VERSION } from "@/lib/alex/gemini";
import { assistantLangSchema } from "@/lib/assistant/schema";
import { currentSellerId } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { displayCountry } from "@/lib/geo/country";
import { HttpError, readJson, route } from "@/lib/http";

/**
 * POST /api/alex/setup — INTERNAL: called only by the Alex bridge (lib/alex/bridge.mjs) when a
 * visitor starts Alex, never by the browser. Returns Alex's instruction (the assistant's rules +
 * page context) and tools, so a browser can't change what Alex is told. The bridge forwards the
 * visitor's cookie and IP, so "signed in" and the display country are the visitor's own.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({ path: z.string().max(300).startsWith("/"), lang: assistantLangSchema.optional() });

function isBridge(key: string | null): boolean {
  if (!key) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(env.SESSION_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST = route(async (request: Request) => {
  const h = await headers();
  if (!isBridge(h.get("x-alex-bridge"))) throw new HttpError(403, "forbidden", "Not available.");
  const { path, lang } = await readJson(request, bodySchema);
  const url = new URL(path, "http://localhost");
  const geo = await displayCountry({ headers: h, as: url.searchParams.get("as"), overrideEnabled: env.DEMO_GEO_OVERRIDE });
  const sellerId = await currentSellerId();
  return Response.json(
    {
      version: ALEX_PROMPT_VERSION,
      system: alexSystemInstruction({ pathname: url.pathname, displayCountry: geo.country, sellerSignedIn: sellerId !== null, lang: lang ?? "en" }),
      tools: alexTools(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
