import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AssistantError, cleanReply, detectLang, MAX_STEPS, runAssistant, type AssistantClient } from "./run";
import type { AssistantRequest } from "./schema";
import type { AssistantData, ToolContext } from "./tools";

// ---------- fake client (test-only; production passes the real Anthropic client) ----------

type Fake = { content: Array<Record<string, unknown>>; stop_reason: string } | { throws: unknown };

function fakeClient(responses: Fake[]) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("fake client: no more responses queued");
          if ("throws" in next) throw next.throws;
          return next;
        },
      },
    },
  } as unknown as AssistantClient;
  return { client, requests };
}

const data: AssistantData = {
  publishedProducts: async () => [
    {
      id: "bench-design-templates",
      title: "Grid & Grain: 120 Figma UI Templates",
      description: "Figma templates.",
      baseCents: 3900,
      rows: [{ country: "IN", priceCents: 1600 }],
    },
  ],
  sellerProducts: async () => [],
};
const ctx: ToolContext = { displayCountry: "IN", asParam: "IN", sellerId: null, pathname: "/" };
const request = (text: string, lang: "en" | "hi" = "en"): AssistantRequest => ({
  lang,
  messages: [{ role: "user", text }],
  path: "/?as=IN",
});
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

describe("runAssistant", () => {
  it("runs the tools Claude asks for and returns the reply, page actions and product cards", async () => {
    const { client, requests } = fakeClient([
      { content: [toolUse("t1", "search_products", { query: "figma templates" })], stop_reason: "tool_use" },
      { content: [toolUse("t2", "open_product", { product_id: "bench-design-templates" })], stop_reason: "tool_use" },
      { content: [text("I found **Grid & Grain** for 16 dollars. Press the yellow PayPal button to buy.")], stop_reason: "end_turn" },
    ]);
    const result = await runAssistant({ client, model: "claude-sonnet-5-5", data }, request("I want figma templates"), ctx);

    expect(result.reply).toBe("I found Grid & Grain for 16 dollars. Press the yellow PayPal button to buy.");
    expect(result.lang).toBe("en");
    expect(result.actions).toEqual([{ type: "navigate", path: "/p/bench-design-templates?as=IN" }]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ priceText: "$16", fairFor: "India" });

    // The app context goes in as an operator (system) message, and tool results go back to Claude.
    const first = requests[0];
    expect(first).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "low" }, tool_choice: { type: "auto" } });
    const firstMessages = first.messages as Array<{ role: string; content: unknown }>;
    expect(firstMessages.at(-1)).toMatchObject({ role: "system" });
    expect(String(firstMessages.at(-1)!.content)).toContain("Visitor's country for prices shown: India");
    const third = requests[2].messages as Array<{ role: string; content: unknown }>;
    const lastToolResult = third.at(-1)!.content as Array<{ type: string; content: string }>;
    expect(lastToolResult[0].type).toBe("tool_result");
    expect(lastToolResult[0].content).toContain("$16");
  });

  it("the last allowed step forbids tools, so the visitor always gets a reply", async () => {
    const loops: Fake[] = Array.from({ length: MAX_STEPS - 1 }, (_, i) => ({
      content: [toolUse(`t${i}`, "point_to", { target: "paypal_button" })],
      stop_reason: "tool_use",
    }));
    const { client, requests } = fakeClient([...loops, { content: [text("Press the PayPal button.")], stop_reason: "end_turn" }]);
    const result = await runAssistant({ client, model: "m", data }, request("how do I pay"), ctx);
    expect(requests).toHaveLength(MAX_STEPS);
    expect(requests.at(-1)).toMatchObject({ tool_choice: { type: "none" } });
    expect(result.reply).toBe("Press the PayPal button.");
  });

  it("replies in Hindi when the visitor speaks Hindi", async () => {
    const { client } = fakeClient([{ content: [text("आपके लिए कीमत 16 डॉलर है।")], stop_reason: "end_turn" }]);
    const result = await runAssistant({ client, model: "m", data }, request("मुझे टेम्पलेट चाहिए", "en"), ctx);
    expect(result.lang).toBe("hi");
  });

  it("a refusal becomes a polite fallback in the visitor's language", async () => {
    const { client } = fakeClient([{ content: [], stop_reason: "refusal" }]);
    const result = await runAssistant({ client, model: "m", data }, request("कुछ और", "hi"), ctx);
    expect(result.lang).toBe("hi");
    expect(result.reply).toContain("प्रोडक्ट");
    expect(result.actions).toEqual([]);
  });

  it("an API outage becomes an AssistantError (the route turns it into a friendly 503)", async () => {
    const { client } = fakeClient([{ throws: new Anthropic.APIConnectionError({ message: "down" }) }]);
    await expect(runAssistant({ client, model: "m", data }, request("hello"), ctx)).rejects.toBeInstanceOf(AssistantError);
  });
});

describe("detectLang / cleanReply", () => {
  it("detects Hindi from Devanagari, else English", () => {
    expect(detectLang("मुझे figma templates चाहिए", "en")).toBe("hi");
    expect(detectLang("I want templates", "hi")).toBe("en");
    expect(detectLang("I want the भारत price for this course", "hi")).toBe("en");
    expect(detectLang("123 ?!", "hi")).toBe("hi");
  });

  it("strips markdown and bounds the length", () => {
    expect(cleanReply("**Hello**  _there_\n# yes")).toBe("Hello there yes");
    expect(cleanReply("a".repeat(2000)).length).toBeLessThanOrEqual(700);
  });
});
