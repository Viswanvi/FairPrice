import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./fixtures";

// The guide: Alex (Gemini Live, via the /ws/alex bridge) started only from a button. No AI is
// called here: Alex's socket is either refused (so the earlier Claude + voice guide takes over,
// answered by a route mock) or replaced by a scripted fake that behaves like the bridge.

/** Alex can't connect: the page falls back to the earlier guide. */
async function noAlex(page: Page) {
  await page.routeWebSocket("**/ws/alex", (ws) => ws.close());
}

test("first visit shows the welcome card: tour, Talk to Alex, explore; no language choice", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=IN`);
  const welcome = page.getByTestId("assistant-welcome");
  await expect(welcome).toBeVisible();
  const buttons = welcome.getByRole("button");
  await expect(buttons).toHaveText(["Take the 3-minute tour", "Talk to Alex", "Explore on my own"]);
  await expect(welcome).toContainText("I'm Alex, FairPrice's AI guide");

  await welcome.getByRole("button", { name: "Explore on my own" }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("assistant-welcome")).toHaveCount(0); // remembered for this visit
});

test("Alex runs the same tools as the assistant: his search returns the server's price and a product card", async ({ page }) => {
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; path: string }> = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/alex/tool")) toolCalls.push(r.postDataJSON());
  });
  let setup: Record<string, unknown> | null = null;
  // A fake bridge: ready → (visitor types) → tool call → (tool result) → Alex's caption.
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") {
        setup = msg;
        ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      } else if (msg.type === "text" && !String(msg.text).startsWith("APP:")) {
        ws.send(JSON.stringify({ type: "tool_call", calls: [{ id: "c1", name: "search_products", args: { query: "e2e buyer course" } }] }));
      } else if (msg.type === "tool_response") {
        const result = JSON.parse(msg.responses[0].response.result);
        const price = result.matches[0].price_for_this_visitor;
        ws.send(JSON.stringify({ type: "alex_text", text: `I found it. The price for you is ${price}.` }));
        ws.send(JSON.stringify({ type: "turn_complete" }));
      }
    });
  });

  await page.goto("/?as=IN");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(page.getByTestId("assistant-main")).toHaveText(/Alex is listening/);

  await panel.getByPlaceholder("Or type here…").fill("I want a coding course");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel).toContainText("The price for you is $35.");
  await expect(panel).toContainText("$35 · fair price for India");
  expect(toolCalls[0]).toMatchObject({ name: "search_products", path: "/?as=IN" });
  expect(setup).toMatchObject({ type: "setup" });
  expect(JSON.stringify(setup)).not.toMatch(/system|tools|instruction/); // Alex's rules are set on the server
});

test("if Alex can't start, the earlier guide answers, opens the product page and shows the card", async ({ page }) => {
  await noAlex(page);
  const requests: Array<{ lang: string; messages: Array<{ role: string; text: string }>; path: string }> = [];
  await page.route("**/api/assistant", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        reply: "I found the E2E buyer course. The price for you in India is 35 dollars. I've opened it.",
        lang: "en",
        actions: [{ type: "navigate", path: `/p/${E2E.buyerProduct}?as=IN` }],
        products: [
          { id: E2E.buyerProduct, title: "E2E buyer course", priceText: "$35", standardText: "$99", fairFor: "India", path: `/p/${E2E.buyerProduct}?as=IN` },
        ],
      },
    });
  });

  await page.goto("/?as=IN");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel).toContainText("Do you want to buy something, or sell your own product?");
  await expect(panel).toContainText("Alex isn't available right now");

  await panel.getByPlaceholder("Or type here…").fill("I want a coding course");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel).toContainText("The price for you in India is 35 dollars.");
  await expect(panel).toContainText("$35 · fair price for India");
  await expect(page).toHaveURL(new RegExp(`/p/${E2E.buyerProduct}\\?as=IN$`));
  await expect(panel).toBeVisible(); // the conversation stays open across pages
  expect(requests[0].messages).toEqual([{ role: "user", text: "I want a coding course" }]);
});

test("the guide switches its own words to Hindi when the conversation is in Hindi", async ({ page }) => {
  await noAlex(page);
  await page.route("**/api/assistant", (route) => route.fulfill({ json: { reply: "नमस्ते!", lang: "hi", actions: [], products: [] } }));
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("radio", { name: "हिं" })).toHaveCount(0); // no language switch on screen
  await panel.getByPlaceholder("Or type here…").fill("नमस्ते");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByPlaceholder("या यहाँ लिखें…")).toBeVisible();
});

test("the guide's APIs check their input; Alex's setup is not open to browsers", async ({ request }) => {
  expect((await request.post("/api/assistant", { data: { lang: "fr", messages: [], path: "nope" } })).status()).toBe(400);
  expect((await request.post("/api/alex/setup", { data: { path: "/" } })).status()).toBe(403);
  expect((await request.post("/api/alex/tool", { data: { name: "approve_prices", args: {}, path: "/" } })).status()).toBe(400);
});
