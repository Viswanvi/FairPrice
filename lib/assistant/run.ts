import Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_SYSTEM_PROMPT, assistantContext } from "./prompt";
import type { AssistantLang, AssistantRequest, AssistantResponse, ClientAction, ProductCard } from "./schema";
import { ASSISTANT_TOOLS, runTool, type AssistantData, type ToolContext } from "./tools";

/**
 * The assistant's tool loop. Claude picks from the fixed tools in ./tools; the server runs them
 * and collects the page actions for the browser. The client is injected so tests use a fake.
 *
 * Speed: the project's model (AI_MODEL) at effort "low", short replies, at most MAX_STEPS
 * calls, and the stable system prompt + tools cached. The last step allows no tools, so the
 * visitor always gets a reply.
 */

export interface AssistantClient {
  beta: { messages: { create: Anthropic["beta"]["messages"]["create"] } };
}

export interface AssistantDeps {
  client: AssistantClient;
  model: string;
  data: AssistantData;
}

export class AssistantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantError";
  }
}

export const MAX_STEPS = 4;
const MAX_TOKENS = 2048;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_REPLY_CHARS = 700;

const FALLBACK_REPLY: Record<string, string> = {
  en: "Sorry, I can't help with that. I can find a product for you or help you set one up for sale.",
  hi: "माफ़ कीजिए, मैं इसमें मदद नहीं कर सकता। मैं आपके लिए कोई प्रोडक्ट ढूँढ सकता हूँ या बेचने के लिए प्रोडक्ट सेट करने में मदद कर सकता हूँ।",
};

/**
 * "hi" when Hindi words carry the sentence, else "en". Counts words, not letters, so Hindi with
 * English product names mixed in ("मुझे figma templates चाहिए") is still Hindi. Any other
 * language (Spanish, Tamil…) can't be told apart by script here, so it keeps the visitor's
 * chosen language unless the text is clearly Hindi.
 */
export function detectLang(text: string, fallback: AssistantLang): AssistantLang {
  const words = text.split(/\s+/).filter(Boolean);
  const hindi = words.filter((w) => /[ऀ-ॿ]/.test(w)).length;
  const english = words.filter((w) => /[A-Za-z]/.test(w) && !/[ऀ-ॿ]/.test(w)).length;
  if (hindi === 0 && english === 0) return fallback;
  if (fallback !== "en" && fallback !== "hi") return hindi > english ? "hi" : fallback;
  return hindi > 0 && hindi * 2 >= english ? "hi" : "en";
}

/** Plain speakable text: no markdown symbols, single spaces, bounded length. */
export function cleanReply(text: string): string {
  const plain = text.replace(/[*_#`>|]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > MAX_REPLY_CHARS ? `${plain.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : plain;
}

export async function runAssistant(
  deps: AssistantDeps,
  request: AssistantRequest,
  ctx: ToolContext,
): Promise<AssistantResponse> {
  const latestUser = request.messages[request.messages.length - 1].text;
  const lang = detectLang(latestUser, request.lang);

  const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map((m) => ({ role: m.role, content: m.text }));
  messages.push({
    role: "system",
    content: assistantContext({
      pathname: ctx.pathname,
      displayCountry: ctx.displayCountry,
      sellerSignedIn: ctx.sellerId !== null,
      lang,
    }),
  });

  const actions: ClientAction[] = [];
  const products = new Map<string, ProductCard>();
  let reply = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await deps.client.beta.messages.create({
        model: deps.model,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "low" },
        cache_control: { type: "ephemeral" },
        system: ASSISTANT_SYSTEM_PROMPT,
        tools: ASSISTANT_TOOLS,
        tool_choice: lastStep ? { type: "none" } : { type: "auto" },
        messages,
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw new AssistantError(`AI unavailable (${error.status ?? "network"})`);
      throw error;
    }

    if (response.stop_reason === "refusal") {
      reply = (FALLBACK_REPLY[lang] ?? FALLBACK_REPLY.en);
      break;
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      reply = text;
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const outcome = await runTool(use.name, use.input, ctx, deps.data);
      actions.push(...outcome.actions);
      for (const card of outcome.products) products.set(card.id, card);
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.result, is_error: outcome.isError ?? false });
    }
    messages.push({ role: "user", content: results });
  }

  const cleaned = cleanReply(reply) || (FALLBACK_REPLY[lang] ?? FALLBACK_REPLY.en);
  return { reply: cleaned, lang: detectLang(cleaned, lang), actions, products: [...products.values()] };
}
