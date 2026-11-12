import type Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_SYSTEM_PROMPT, assistantContext, type AssistantContextInput } from "@/lib/assistant/prompt";
import { ASSISTANT_TOOLS } from "@/lib/assistant/tools";

/**
 * Alex: the FairPrice guide with Gemini Live as its brain (the GCS "Alex" setup). It follows the
 * SAME rules and uses the SAME tools as the Claude assistant (lib/assistant/prompt.ts and
 * tools.ts); this file only adds how a live video avatar delivers them, and converts the tool
 * list to Gemini's format. Prices still come only from the server's tools.
 */

export const ALEX_PROMPT_VERSION = "2026-11-12.alex1";

const ALEX_ADDENDUM = `About you: your name is Alex. You are FairPrice's AI guide, shown as a video avatar. You are an AI, not a person, and not a representative of PayPal; say so if asked.

You hear the visitor through their microphone and reply out loud. Reply in the language they speak; if they switch language, switch with them. Never ask which language they want.

Messages from the app (not the visitor) start with "APP:" or "SCRIPT:".
- Never say the words "SCRIPT" or "APP" aloud; they are markers, not part of the text.
- "SCRIPT:" means: say the text after it aloud exactly, word for word, in the language it is written in, then stop. Add nothing before or after it, and don't call tools for it.
- "APP:" gives you a fact or an instruction from the page (for example, that the visitor opened the guide). Follow it briefly.

If the visitor asks for a tour, a demo or a walkthrough, call start_tour and say nothing else.
While the tour runs, if the visitor says "skip", "next", "stop" or "pause", say nothing: the app handles it.
When the tour is paused (the visitor talked over you, or asked a question), answer their question briefly. When they ask to continue, carry on, go on or resume, in any language, or say they have no more questions, call resume_tour and say nothing else: the app sends you the next line.`;

/** The full instruction for one Alex session: the shared rules, Alex's delivery, then the page context. */
export function alexSystemInstruction(ctx: AssistantContextInput): string {
  return `${ASSISTANT_SYSTEM_PROMPT}\n\n${ALEX_ADDENDUM}\n\n${assistantContext(ctx)}`;
}

/** Gemini's function-declaration schema (an OpenAPI subset with upper-case types). */
export interface GeminiSchema {
  type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "OBJECT" | "ARRAY";
  description?: string;
  enum?: string[];
  nullable?: boolean;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
}

export interface GeminiFunction {
  name: string;
  description: string;
  parameters?: GeminiSchema;
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

/** JSON Schema (as written for Claude) → Gemini schema. `anyOf: [X, null]` becomes X with nullable. */
export function toGeminiSchema(s: JsonSchema): GeminiSchema {
  if (s.anyOf) {
    const real = s.anyOf.filter((a) => a.type !== "null");
    if (real.length !== 1) throw new Error("only anyOf [type, null] is supported");
    return { ...toGeminiSchema({ ...real[0], description: s.description ?? real[0].description }), nullable: true };
  }
  const type = (s.type ?? "string").toUpperCase() as GeminiSchema["type"];
  const out: GeminiSchema = { type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required?.length) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

/** Tools the browser runs itself (no server data involved). */
export const CLIENT_TOOLS: GeminiFunction[] = [
  { name: "start_tour", description: "Start the guided 3-minute tour of FairPrice when the visitor asks for a tour, demo or walkthrough." },
  {
    name: "resume_tour",
    description:
      "Continue the paused tour from where it stopped, when the visitor asks to continue, carry on, go on or resume (in any language), or has no more questions.",
  },
];

/** The same tools the Claude assistant has, plus start_tour, in Gemini's format. */
export function alexTools(tools: Anthropic.Beta.BetaTool[] = ASSISTANT_TOOLS): GeminiFunction[] {
  const server = tools.map((t) => {
    const schema = t.input_schema as JsonSchema;
    const hasParams = schema.properties && Object.keys(schema.properties).length > 0;
    return { name: t.name, description: t.description ?? "", ...(hasParams ? { parameters: toGeminiSchema(schema) } : {}) };
  });
  return [...server, ...CLIENT_TOOLS];
}
