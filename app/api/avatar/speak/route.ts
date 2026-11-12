import { headers } from "next/headers";
import { z } from "zod";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { avatarConfigured, speakStream } from "@/lib/avatar/live";
import { clientIp } from "@/lib/geo/country";
import { HttpError, readJson, route } from "@/lib/http";

/**
 * POST /api/avatar/speak — the video avatar reads one piece of FairPrice text aloud. Opens a
 * short-lived Gemini Live session on the server (the key stays here) and streams the avatar's
 * video and audio back as NDJSON until the turn ends. 503 when the avatar isn't configured;
 * the browser then keeps its own voice.
 *
 * The text is what the page already shows (the assistant's reply, a tour line or a payment
 * result); the avatar only reads it. ponytail: the route doesn't prove the text came from
 * FairPrice, so anyone could make it read 800 characters within the rate limit. Sign replies
 * with SESSION_SECRET if that is ever abused.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ text: z.string().trim().min(1).max(800) });

// About two tours plus some talk per visitor in half an hour; the browser's own budget is tighter.
const limiter = createRateLimiter({ limit: 40, windowMs: 30 * 60_000 });

export const POST = route(async (request: Request) => {
  if (!avatarConfigured()) throw new HttpError(503, "avatar_unavailable", "The video avatar isn't set up.");
  const { text } = await readJson(request, bodySchema);
  if (!limiter.take(clientIp(await headers()) ?? "unknown")) {
    throw new HttpError(429, "rate_limited", "Too many avatar turns. Using voice instead.");
  }
  return new Response(speakStream(text, request.signal), {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
});
