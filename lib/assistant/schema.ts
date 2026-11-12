import { z } from "zod";

/**
 * Shapes for the FairPrice voice assistant (POST /api/assistant). The assistant guides buyers
 * and sellers: it finds products, opens pages, fills the seller's product form and presses
 * the safe setup buttons. It never pays, approves or edits prices, or touches passwords.
 */

/** Languages with written UI text and a browser voice preset; any other language code also works. */
export const ASSISTANT_LANGS = ["en", "hi"] as const;
/** A language code such as "en", "hi", "es" or "pt-BR" (AVATAR_SPEC section 7: any language). */
export const assistantLangSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, { error: "lang must be a language code" });
export type AssistantLang = string;

export const MAX_TURNS = 20;
export const MAX_TURN_CHARS = 600;

export const assistantRequestSchema = z.object({
  lang: assistantLangSchema,
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().trim().min(1).max(MAX_TURN_CHARS),
      }),
    )
    .min(1)
    .max(MAX_TURNS)
    // Zod 4 still runs refinements after .min() fails, so guard the empty case here.
    .refine((m) => m.length === 0 || (m[0].role === "user" && m[m.length - 1].role === "user"), {
      message: "The conversation must start and end with the visitor.",
    }),
  /** The page the visitor is on, path + query (e.g. "/p/abc?as=IN"). */
  path: z.string().max(300).startsWith("/"),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

/** Buttons the assistant may press for a seller. "Approve" is deliberately not here. */
export const PRESSABLE = ["continue_setup", "analyze_audience", "continue_to_prices", "generate_prices"] as const;
export type Pressable = (typeof PRESSABLE)[number];

/** Things the assistant may point at (scroll to and highlight). */
export const HIGHLIGHTABLE = ["paypal_button", "approve_button", "password_field", "price_table"] as const;
export type Highlightable = (typeof HIGHLIGHTABLE)[number];

export interface ProductFormFields {
  title?: string;
  description?: string;
  baseUsd?: number;
  minUsd?: number;
  maxDiscountPct?: number;
  goal?: "reach" | "revenue";
}

export type ClientAction =
  | { type: "navigate"; path: string }
  | { type: "fill_product_form"; fields: ProductFormFields }
  | { type: "press"; target: Pressable }
  | { type: "highlight"; target: Highlightable };

/** A product the assistant found, with the price computed on the server for this visitor. */
export interface ProductCard {
  id: string;
  title: string;
  /** "$16" — the price for the visitor's display country (or the standard price). */
  priceText: string;
  standardText: string;
  /** "India" when this is the fair price for the visitor's country, else null. */
  fairFor: string | null;
  path: string;
}

export interface AssistantResponse {
  reply: string;
  lang: AssistantLang;
  actions: ClientAction[];
  products: ProductCard[];
}
