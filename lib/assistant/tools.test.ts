import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TOOLS,
  productCard,
  rankProducts,
  runTool,
  type AssistantData,
  type PublishedProduct,
  type ToolContext,
} from "./tools";

const PRODUCTS: PublishedProduct[] = [
  {
    id: "bench-design-templates",
    title: "Grid & Grain: 120 Figma UI Templates for Startups",
    description: "Figma templates for landing pages and dashboards.",
    baseCents: 3900,
    rows: [
      { country: "IN", priceCents: 1600 },
      { country: "US", priceCents: 3900 },
    ],
  },
  {
    id: "bench-ebook",
    title: "Quiet Focus: A Practical Guide to Deep Work at Home",
    description: "An ebook about remote work and focus.",
    baseCents: 1900,
    rows: [{ country: "IN", priceCents: 900 }],
  },
];

const data: AssistantData = {
  publishedProducts: async () => PRODUCTS,
  sellerProducts: async (sellerId) =>
    sellerId === "demo-seller" ? [{ id: "bench-ebook", title: "Quiet Focus", status: "approved" }] : [],
};

const buyer = (o: Partial<ToolContext> = {}): ToolContext => ({
  displayCountry: "IN",
  asParam: null,
  sellerId: null,
  pathname: "/",
  ...o,
});
const seller = (o: Partial<ToolContext> = {}): ToolContext => buyer({ sellerId: "demo-seller", ...o });
const json = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("tool list", () => {
  it("has no tool that could pay, approve or change a price", () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.name).not.toMatch(/pay|approve|price_edit|refund|password/);
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
    const press = ASSISTANT_TOOLS.find((t) => t.name === "press_button")!;
    expect(JSON.stringify(press.input_schema)).not.toContain("approve");
  });
});

describe("rankProducts / productCard", () => {
  it("ranks by keywords, title first", () => {
    expect(rankProducts(PRODUCTS, "figma design templates")[0].id).toBe("bench-design-templates");
    expect(rankProducts(PRODUCTS, "ebook about focus")[0].id).toBe("bench-ebook");
    expect(rankProducts(PRODUCTS, "kitchen knives")).toEqual([]);
  });

  it("prices from the approved table for the visitor's country, else the standard price", () => {
    expect(productCard(PRODUCTS[0], buyer())).toMatchObject({ priceText: "$16", standardText: "$39", fairFor: "India" });
    expect(productCard(PRODUCTS[0], buyer({ displayCountry: "FR" }))).toMatchObject({ priceText: "$39", fairFor: null });
    expect(productCard(PRODUCTS[0], buyer({ displayCountry: null }))).toMatchObject({ priceText: "$39", fairFor: null });
    expect(productCard(PRODUCTS[0], buyer({ displayCountry: "US" })).fairFor).toBe("the United States");
  });

  it("keeps the demo override when opening a product", () => {
    expect(productCard(PRODUCTS[0], buyer({ asParam: "IN" })).path).toBe("/p/bench-design-templates?as=IN");
    expect(productCard(PRODUCTS[0], buyer()).path).toBe("/p/bench-design-templates");
  });
});

describe("runTool — buyer", () => {
  it("search_products returns server-priced matches with seller text marked as data", async () => {
    const out = await runTool("search_products", { query: "figma templates" }, buyer(), data);
    const result = json(out.result) as { matches: Array<Record<string, string>> };
    expect(result.matches[0]).toMatchObject({ id: "bench-design-templates", price_for_this_visitor: "$16", fair_price_for: "India" });
    expect(result.matches[0].title).toMatch(/^<product_data>.*<\/product_data>$/);
    expect(out.products.map((p) => p.id)).toEqual(["bench-design-templates"]);
    expect(out.actions).toEqual([]);
  });

  it("search_products with no match lists what is on sale", async () => {
    const out = await runTool("search_products", { query: "kitchen knives" }, buyer(), data);
    expect(json(out.result)).toMatchObject({ matches: [] });
    expect((json(out.result).on_sale as unknown[]).length).toBe(2);
  });

  it("open_product navigates only to products on sale", async () => {
    const opened = await runTool("open_product", { product_id: "bench-design-templates" }, buyer({ asParam: "IN" }), data);
    expect(opened.actions).toEqual([{ type: "navigate", path: "/p/bench-design-templates?as=IN" }]);
    const unknown = await runTool("open_product", { product_id: "not-for-sale" }, buyer(), data);
    expect(unknown.isError).toBe(true);
    expect(unknown.actions).toEqual([]);
  });

  it("point_to highlights the PayPal button", async () => {
    const out = await runTool("point_to", { target: "paypal_button" }, buyer(), data);
    expect(out.actions).toEqual([{ type: "highlight", target: "paypal_button" }]);
  });
});

describe("runTool — seller", () => {
  it("seller-only tools send a signed-out visitor to sign in to TYPE the password", async () => {
    for (const [name, input] of [
      ["go_to", { page: "new_product", product_id: null }],
      ["list_my_products", {}],
      ["fill_new_product_form", { title: "X", description: null, base_price_usd: null, minimum_price_usd: null, max_discount_pct: null, goal: null }],
      ["press_button", { button: "analyze_audience" }],
    ] as const) {
      const out = await runTool(name, input, buyer(), data);
      expect(out.actions).toEqual([
        { type: "navigate", path: "/seller/sign-in" },
        { type: "highlight", target: "password_field" },
      ]);
      expect(json(out.result)).toMatchObject({ signed_in: false });
    }
  });

  it("go_to opens seller pages, and only the seller's own products", async () => {
    expect((await runTool("go_to", { page: "new_product", product_id: null }, seller(), data)).actions).toEqual([
      { type: "navigate", path: "/seller/products/new" },
    ]);
    expect((await runTool("go_to", { page: "seller_product", product_id: "bench-ebook" }, seller(), data)).actions).toEqual([
      { type: "navigate", path: "/seller/products/bench-ebook" },
    ]);
    const other = await runTool("go_to", { page: "seller_product", product_id: "bench-design-templates" }, seller(), data);
    expect(other.isError).toBe(true);
    expect((await runTool("go_to", { page: "admin", product_id: null }, seller(), data)).isError).toBe(true);
  });

  it("fill_new_product_form opens the form if needed and fills only what was said", async () => {
    const input = { title: "My Ebook", description: null, base_price_usd: 19, minimum_price_usd: 4, max_discount_pct: null, goal: "reach" };
    const elsewhere = await runTool("fill_new_product_form", input, seller({ pathname: "/seller" }), data);
    expect(elsewhere.actions).toEqual([
      { type: "navigate", path: "/seller/products/new" },
      { type: "fill_product_form", fields: { title: "My Ebook", baseUsd: 19, minUsd: 4, goal: "reach" } },
    ]);
    const onForm = await runTool("fill_new_product_form", input, seller({ pathname: "/seller/products/new" }), data);
    expect(onForm.actions.map((a) => a.type)).toEqual(["fill_product_form"]);
  });

  it("fill_new_product_form refuses impossible values", async () => {
    const base = { title: null, description: null, max_discount_pct: null, goal: null };
    const minAboveBase = await runTool("fill_new_product_form", { ...base, base_price_usd: 10, minimum_price_usd: 20 }, seller(), data);
    expect(minAboveBase.isError).toBe(true);
    expect(minAboveBase.actions).toEqual([]);
    const negative = await runTool("fill_new_product_form", { ...base, base_price_usd: -5, minimum_price_usd: null }, seller(), data);
    expect(negative.isError).toBe(true);
  });

  it("press_button presses setup buttons but never Approve", async () => {
    expect((await runTool("press_button", { button: "generate_prices" }, seller(), data)).actions).toEqual([
      { type: "press", target: "generate_prices" },
    ]);
    const approve = await runTool("press_button", { button: "approve" }, seller(), data);
    expect(approve.isError).toBe(true);
    expect(approve.actions).toEqual([]);
  });

  it("an unknown tool is an error", async () => {
    expect((await runTool("pay_now", {}, seller(), data)).isError).toBe(true);
  });
});
