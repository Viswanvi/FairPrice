import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { countryPhrase } from "@/lib/checkout/messages";
import { priceForCountry } from "@/lib/checkout/pricing";
import { formatUsd } from "@/lib/seller/format";
import {
  HIGHLIGHTABLE,
  PRESSABLE,
  type ClientAction,
  type ProductCard,
  type ProductFormFields,
} from "./schema";

/**
 * The assistant's tools: a fixed, safe list. Pure apart from the injected data access, so it
 * is tested without a database. Prices always come from the APPROVED table via the same
 * priceForCountry() the buyer page uses; the AI only relays what these return. Seller-provided
 * text (titles, descriptions) is returned inside <product_data> tags and treated as data.
 * Nothing here can pay, approve, change a price or handle a password.
 */

export interface PublishedProduct {
  id: string;
  title: string;
  description: string | null;
  baseCents: number;
  rows: ReadonlyArray<{ country: string; priceCents: number }>;
}

export interface SellerProductSummary {
  id: string;
  title: string;
  status: "approved" | "draft" | "no_prices";
}

export interface AssistantData {
  publishedProducts(): Promise<PublishedProduct[]>;
  sellerProducts(sellerId: string): Promise<SellerProductSummary[]>;
}

export interface ToolContext {
  /** Visitor's display country (IP or demo override); for the price shown only. */
  displayCountry: string | null;
  /** The demo override in the current URL, kept when opening product pages. */
  asParam: string | null;
  sellerId: string | null;
  /** Current path without query. */
  pathname: string;
}

export interface ToolOutcome {
  /** JSON text returned to the model. */
  result: string;
  isError?: boolean;
  actions: ClientAction[];
  products: ProductCard[];
}

const SELLER_PAGES = {
  seller_home: "/seller",
  new_product: "/seller/products/new",
} as const;
const PUBLIC_PAGES = { home: "/", benchmark: "/benchmark", seller_sign_in: "/seller/sign-in" } as const;
const PAGES = ["home", "benchmark", "seller_sign_in", "seller_home", "new_product", "seller_product"] as const;
const NULLABLE_STRING = { anyOf: [{ type: "string" }, { type: "null" }] };
const NULLABLE_NUMBER = { anyOf: [{ type: "number" }, { type: "null" }] };

export const ASSISTANT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_products",
    description:
      "Search the products on sale in FairPrice. Write the query as a few English keywords even when the visitor speaks Hindi " +
      "(e.g. 'figma design templates'). Returns up to 3 matches with the price for this visitor, already computed by the server.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "English keywords." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "open_product",
    description: "Open a product's buyer page so the visitor can see the price and pay with PayPal. Use an id from search_products.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "go_to",
    description:
      "Open a FairPrice page: home, benchmark (formula vs AI comparison), seller_sign_in, seller_home (the seller's products), " +
      "new_product (seller: create a product), seller_product (seller: one product's workspace; needs product_id).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        page: { type: "string", enum: [...PAGES] },
        product_id: { anyOf: [{ type: "string" }, { type: "null" }], description: "Only for seller_product; else null." },
      },
      required: ["page", "product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_my_products",
    description: "For a signed-in seller: their products and whether each has approved prices, a draft, or no prices yet.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "fill_new_product_form",
    description:
      "For a signed-in seller: fill the 'new product' form with what they told you (opens the form if needed). Only include " +
      "fields the seller actually said; use null for the rest. Prices are US dollars. The seller then checks the form and " +
      "presses Continue (or asks you to).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        title: NULLABLE_STRING,
        description: NULLABLE_STRING,
        base_price_usd: NULLABLE_NUMBER,
        minimum_price_usd: NULLABLE_NUMBER,
        max_discount_pct: NULLABLE_NUMBER,
        goal: { anyOf: [{ type: "string", enum: ["reach", "revenue"] }, { type: "null" }] },
      },
      required: ["title", "description", "base_price_usd", "minimum_price_usd", "max_discount_pct", "goal"],
      additionalProperties: false,
    },
  },
  {
    name: "press_button",
    description:
      "For a signed-in seller, press a setup button on the current page: continue_setup (save the new product form), " +
      "analyze_audience (AI audience analysis), continue_to_prices, generate_prices (AI price suggestions). " +
      "There is no approve button here: only the seller can approve prices.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { button: { type: "string", enum: [...PRESSABLE] } },
      required: ["button"],
      additionalProperties: false,
    },
  },
  {
    name: "point_to",
    description:
      "Scroll to and highlight something on the current page: paypal_button (buyer pays here), approve_button (seller approves " +
      "prices here), password_field (seller types the password here), price_table.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { target: { type: "string", enum: [...HIGHLIGHTABLE] } },
      required: ["target"],
      additionalProperties: false,
    },
  },
];

const STOPWORDS = new Set(["a", "an", "the", "for", "to", "of", "and", "or", "in", "on", "with", "i", "want", "need", "buy", "some", "my"]);

function keywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
}

/** Products ranked by keyword overlap (title counts double). Pure. */
export function rankProducts(products: ReadonlyArray<PublishedProduct>, query: string): PublishedProduct[] {
  const words = keywords(query);
  const scored = products.map((p) => {
    const title = p.title.toLowerCase();
    const text = `${title} ${(p.description ?? "").toLowerCase()}`;
    const score = words.reduce((s, w) => s + (title.includes(w) ? 2 : 0) + (text.includes(w) ? 1 : 0), 0);
    return { p, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.p);
}

function productPath(id: string, ctx: ToolContext): string {
  return `/p/${encodeURIComponent(id)}${ctx.asParam ? `?as=${encodeURIComponent(ctx.asParam)}` : ""}`;
}

/** The card for one product: price for this visitor from the approved table, formatted on the server. */
export function productCard(p: PublishedProduct, ctx: ToolContext): ProductCard {
  const { priceCents, inTable } = priceForCountry(p.rows, ctx.displayCountry, p.baseCents);
  return {
    id: p.id,
    title: p.title,
    priceText: formatUsd(priceCents),
    standardText: formatUsd(p.baseCents),
    fairFor: inTable && ctx.displayCountry ? countryPhrase(ctx.displayCountry) : null,
    path: productPath(p.id, ctx),
  };
}

const ok = (result: unknown, actions: ClientAction[] = [], products: ProductCard[] = []): ToolOutcome => ({
  result: JSON.stringify(result),
  actions,
  products,
});
const fail = (message: string): ToolOutcome => ({ result: JSON.stringify({ error: message }), isError: true, actions: [], products: [] });

const notSignedIn = (): ToolOutcome =>
  ok(
    { signed_in: false, note: "The seller is not signed in. The sign-in page is now open; the seller must TYPE the password themselves." },
    [{ type: "navigate", path: "/seller/sign-in" }, { type: "highlight", target: "password_field" }],
  );

const goToInput = z.object({ page: z.enum(PAGES), product_id: z.string().nullable() });
const fillInput = z.object({
  title: z.string().trim().max(120).nullable(),
  description: z.string().trim().max(2000).nullable(),
  base_price_usd: z.number().min(1).max(10_000).nullable(),
  minimum_price_usd: z.number().min(0.5).max(10_000).nullable(),
  max_discount_pct: z.number().min(0).max(90).nullable(),
  goal: z.enum(["reach", "revenue"]).nullable(),
});

/** Run one tool call. Unknown tools and bad input come back as errors the model can read. */
export async function runTool(name: string, input: unknown, ctx: ToolContext, data: AssistantData): Promise<ToolOutcome> {
  switch (name) {
    case "search_products": {
      const parsed = z.object({ query: z.string().max(200) }).safeParse(input);
      if (!parsed.success) return fail("query must be a short string");
      const all = await data.publishedProducts();
      const matches = rankProducts(all, parsed.data.query).slice(0, 3);
      const cards = matches.map((p) => productCard(p, ctx));
      if (cards.length === 0) {
        return ok({
          matches: [],
          note: "No product matched. These are on sale:",
          on_sale: all.slice(0, 6).map((p) => ({ id: p.id, title: `<product_data>${p.title}</product_data>` })),
        });
      }
      return ok(
        {
          matches: cards.map((c, i) => ({
            id: c.id,
            title: `<product_data>${c.title}</product_data>`,
            summary: `<product_data>${(matches[i].description ?? "").slice(0, 240)}</product_data>`,
            price_for_this_visitor: c.priceText,
            standard_price: c.standardText,
            fair_price_for: c.fairFor,
          })),
        },
        [],
        cards,
      );
    }

    case "open_product": {
      const parsed = z.object({ product_id: z.string().max(100) }).safeParse(input);
      if (!parsed.success) return fail("product_id is required");
      const product = (await data.publishedProducts()).find((p) => p.id === parsed.data.product_id);
      if (!product) return fail("No product on sale has that id. Search first.");
      const card = productCard(product, ctx);
      return ok(
        { opened: card.path, price_for_this_visitor: card.priceText, next_step: "The visitor pays with the PayPal button on that page." },
        [{ type: "navigate", path: card.path }],
        [card],
      );
    }

    case "go_to": {
      const parsed = goToInput.safeParse(input);
      if (!parsed.success) return fail("unknown page");
      const { page, product_id } = parsed.data;
      if (page in PUBLIC_PAGES) {
        const path = PUBLIC_PAGES[page as keyof typeof PUBLIC_PAGES];
        const actions: ClientAction[] = [{ type: "navigate", path }];
        if (page === "seller_sign_in") actions.push({ type: "highlight", target: "password_field" });
        return ok({ opened: path }, actions);
      }
      if (!ctx.sellerId) return notSignedIn();
      if (page === "seller_product") {
        if (!product_id) return fail("seller_product needs product_id (use list_my_products)");
        const mine = await data.sellerProducts(ctx.sellerId);
        if (!mine.some((p) => p.id === product_id)) return fail("That product isn't one of this seller's products.");
        const path = `/seller/products/${encodeURIComponent(product_id)}`;
        return ok({ opened: path }, [{ type: "navigate", path }]);
      }
      const path = SELLER_PAGES[page as keyof typeof SELLER_PAGES];
      return ok({ opened: path }, [{ type: "navigate", path }]);
    }

    case "list_my_products": {
      if (!ctx.sellerId) return notSignedIn();
      const mine = await data.sellerProducts(ctx.sellerId);
      return ok({ products: mine.map((p) => ({ id: p.id, title: `<product_data>${p.title}</product_data>`, status: p.status })) });
    }

    case "fill_new_product_form": {
      if (!ctx.sellerId) return notSignedIn();
      const parsed = fillInput.safeParse(input);
      if (!parsed.success) {
        return fail(`Can't use those values: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      const f = parsed.data;
      if (f.base_price_usd !== null && f.minimum_price_usd !== null && f.minimum_price_usd > f.base_price_usd) {
        return fail("The minimum price can't be above the base price. Ask the seller again.");
      }
      const fields: ProductFormFields = {};
      if (f.title) fields.title = f.title;
      if (f.description) fields.description = f.description;
      if (f.base_price_usd !== null) fields.baseUsd = Math.round(f.base_price_usd * 100) / 100;
      if (f.minimum_price_usd !== null) fields.minUsd = Math.round(f.minimum_price_usd * 100) / 100;
      if (f.max_discount_pct !== null) fields.maxDiscountPct = Math.round(f.max_discount_pct);
      if (f.goal) fields.goal = f.goal;
      const actions: ClientAction[] = [];
      if (ctx.pathname !== SELLER_PAGES.new_product) actions.push({ type: "navigate", path: SELLER_PAGES.new_product });
      actions.push({ type: "fill_product_form", fields });
      return ok({ filled: fields, next_step: "Read the values back. The seller presses Continue, or asks you to." }, actions);
    }

    case "press_button": {
      if (!ctx.sellerId) return notSignedIn();
      const parsed = z.object({ button: z.enum(PRESSABLE) }).safeParse(input);
      if (!parsed.success) return fail("That button can't be pressed by the assistant. Only the seller can approve prices.");
      return ok({ pressed: parsed.data.button, note: "The page shows progress; AI steps take up to a minute." }, [
        { type: "press", target: parsed.data.button },
      ]);
    }

    case "point_to": {
      const parsed = z.object({ target: z.enum(HIGHLIGHTABLE) }).safeParse(input);
      if (!parsed.success) return fail("unknown target");
      return ok({ highlighted: parsed.data.target }, [{ type: "highlight", target: parsed.data.target }]);
    }

    default:
      return fail(`unknown tool ${name}`);
  }
}
