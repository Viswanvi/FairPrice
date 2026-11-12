import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { AiError, type AiDeps } from "./ai";

/** The real Anthropic client for API routes (server only; the key never reaches the browser). */
let client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  return client;
}

export function aiDeps(): AiDeps {
  return { client: anthropicClient(), model: env.AI_MODEL };
}

/** Map AI failures to friendly HTTP errors. */
export function aiHttpError(error: AiError): HttpError {
  switch (error.code) {
    case "refused":
      return new HttpError(502, "ai_refused", "The AI declined to analyze this product. Try a shorter, plainer description.");
    case "invalid_output":
      return new HttpError(502, "ai_invalid_output", "The AI's answer couldn't be used. Please try again.");
    case "ai_unavailable":
      return new HttpError(503, "ai_unavailable", "The AI service is busy or unreachable. Please try again in a minute.");
  }
}
