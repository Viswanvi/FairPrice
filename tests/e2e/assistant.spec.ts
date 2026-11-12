import { expect, test } from "@playwright/test";
import { E2E } from "./fixtures";

// Voice assistant UI. The AI is not called: /api/assistant is answered by the test (route mock),
// so these runs are free and deterministic. Speech itself needs a real microphone and voices,
// so it is checked by hand; here the visitor types.

test("first visit shows the welcome card, Hindi first for the India demo; 'Explore on my own' hides it", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=IN`);
  const welcome = page.getByTestId("assistant-welcome");
  await expect(welcome).toBeVisible();
  const buttons = welcome.getByRole("button");
  await expect(buttons.nth(0)).toHaveText("3 मिनट का टूर देखें"); // the tour comes first (AVATAR_SPEC section 2)
  await expect(buttons.nth(1)).toHaveText("हिन्दी में बोलें");
  await expect(buttons.nth(2)).toHaveText("Talk in English");

  await welcome.getByRole("button", { name: /Explore on my own/ }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByTestId("assistant-launcher")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("assistant-welcome")).toHaveCount(0); // remembered for this visit
});

test("a typed request shows the reply and product card, and the assistant opens the product page", async ({ page }) => {
  const requests: Array<{ lang: string; messages: Array<{ role: string; text: string }>; path: string }> = [];
  await page.route("**/api/assistant", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        reply: "I found the E2E buyer course. The price for you in India is 35 dollars. I've opened it.",
        lang: "en",
        actions: [{ type: "navigate", path: `/p/${E2E.buyerProduct}?as=IN` }],
        products: [
          {
            id: E2E.buyerProduct,
            title: "E2E buyer course",
            priceText: "$35",
            standardText: "$99",
            fairFor: "India",
            path: `/p/${E2E.buyerProduct}?as=IN`,
          },
        ],
      },
    });
  });

  await page.goto("/?as=IN");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk in English" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel).toContainText("Do you want to buy something, or sell your own product?");

  await panel.getByPlaceholder("Or type here…").fill("I want a coding course");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel).toContainText("The price for you in India is 35 dollars.");
  await expect(panel).toContainText("$35 · fair price for India");
  await expect(page).toHaveURL(new RegExp(`/p/${E2E.buyerProduct}\\?as=IN$`));
  await expect(page.getByRole("heading", { name: "E2E buyer course" })).toBeVisible();
  await expect(panel).toBeVisible(); // the conversation stays open across pages

  expect(requests[0]).toMatchObject({ lang: "en", path: "/?as=IN" });
  expect(requests[0].messages).toEqual([{ role: "user", text: "I want a coding course" }]);
});

test("switching to Hindi changes the assistant's language", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk in English" }).click();
  const panel = page.getByTestId("assistant-panel");
  await panel.getByRole("radio", { name: "हिं" }).click();
  await expect(panel.getByPlaceholder("या यहाँ लिखें…")).toBeVisible();
  await expect(panel.getByRole("button", { name: "भेजें" })).toBeVisible();
});

test("the assistant API checks its input", async ({ request }) => {
  const res = await request.post("/api/assistant", { data: { lang: "fr", messages: [], path: "nope" } });
  expect(res.status()).toBe(400);
});
