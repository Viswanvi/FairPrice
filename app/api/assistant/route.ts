import { headers } from "next/headers";
import { anthropicClient } from "@/lib/pricing/ai-client";
import { assistantData } from "@/lib/assistant/data";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { AssistantError, runAssistant } from "@/lib/assistant/run";
import { assistantRequestSchema } from "@/lib/assistant/schema";
import { currentSellerId } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { clientIp, displayCountry } from "@/lib/geo/country";
import { HttpError, readJson, route } from "@/lib/http";

/**
 * POST /api/assistant — one turn of the voice assistant. Public (buyers use it), so it is rate
 * limited per IP. Returns the reply text plus page actions for the browser; it never moves
 * money, approves prices or sees passwords (lib/assistant/tools.ts).
 */

const limiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });

const BUSY: Record<string, string> = {
  en: "I'm getting a lot of questions right now. Please wait a minute and try again.",
  hi: "अभी बहुत सारे सवाल आ रहे हैं। कृपया एक मिनट रुककर फिर से कोशिश करें।",
};
const UNAVAILABLE: Record<string, string> = {
  en: "The assistant can't reach the AI right now. You can still explore the page yourself.",
  hi: "असिस्टेंट अभी AI से जुड़ नहीं पा रहा है। आप पेज खुद भी देख सकते हैं।",
};

export const POST = route(async (request: Request) => {
  const body = await readJson(request, assistantRequestSchema);
  const h = await headers();

  if (!limiter.take(clientIp(h) ?? "unknown")) throw new HttpError(429, "rate_limited", (BUSY[body.lang] ?? BUSY.en));

  const url = new URL(body.path, "http://localhost");
  const geo = await displayCountry({ headers: h, as: url.searchParams.get("as"), overrideEnabled: env.DEMO_GEO_OVERRIDE });
  const sellerId = await currentSellerId();

  try {
    const deps = { client: anthropicClient(), model: env.AI_MODEL, data: assistantData };
    const result = await runAssistant(deps, body, {
      displayCountry: geo.country,
      asParam: geo.overridden ? geo.country : null,
      sellerId,
      pathname: url.pathname,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AssistantError) {
      console.error("[assistant]", error.message); // status code only; no conversation text
      throw new HttpError(503, "assistant_unavailable", (UNAVAILABLE[body.lang] ?? UNAVAILABLE.en));
    }
    throw error;
  }
});
