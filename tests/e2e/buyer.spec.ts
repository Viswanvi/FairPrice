import { expect, test } from "@playwright/test";
import { E2E } from "./fixtures";

// Runs on desktop and on a phone viewport (playwright.config.ts). PayPal approval stays manual.

test("India visitor sees the fair price, the demo banner and the PayPal button", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=IN`);
  await expect(page.getByRole("heading", { name: "E2E buyer course" })).toBeVisible();
  await expect(page.getByText("Demo: simulating a visitor from India.")).toBeVisible();
  await expect(page.getByText("$35", { exact: true })).toBeVisible();
  await expect(page.getByText("Fair price for India, verified by PayPal at checkout")).toBeVisible();
  await expect(page.getByText(/^Standard price \$99$/)).toBeVisible();
  // The official button loads from PayPal's sandbox (needs internet).
  await expect(page.locator("paypal-button")).toBeVisible({ timeout: 30_000 });
  // No horizontal scrolling on any viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("India visitor gets the explanation in Hindi with a Listen button, and can switch language", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=IN`);
  const voice = page.getByTestId("price-voice");
  await expect(voice.getByRole("combobox")).toHaveValue("hi");
  await expect(voice.getByRole("button", { name: "सुनें" })).toBeVisible();
  await expect(voice.locator('p[lang="hi-IN"]')).toContainText("आपकी कीमत 35 डॉलर है, जो भारत के लिए उचित कीमत है।");

  await voice.getByRole("combobox").selectOption("pt-BR");
  await expect(voice.getByRole("button", { name: "Ouvir" })).toBeVisible();
  await expect(voice.locator('p[lang="pt-BR"]')).toContainText("Seu preço é 35 dólares");

  await voice.getByRole("combobox").selectOption("en");
  await expect(voice.getByRole("button", { name: "Listen" })).toBeVisible();
  await expect(voice.locator("p[lang]")).toHaveCount(0); // English is already on the page
});

test("Brazil and Mexico visitors start in Portuguese and Spanish", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=BR`);
  await expect(page.getByTestId("price-voice").getByRole("combobox")).toHaveValue("pt-BR");
  await page.goto(`/p/${E2E.buyerProduct}?as=MX`);
  await expect(page.getByTestId("price-voice").getByRole("combobox")).toHaveValue("es");
  await expect(page.getByTestId("price-voice").getByRole("button", { name: "Escuchar" })).toBeVisible();
});

test("US visitor sees the US price with 'the'", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=US`);
  await expect(page.getByText("Fair price for the United States, verified by PayPal at checkout")).toBeVisible();
  await expect(page.getByText("$99", { exact: true })).toBeVisible();
});

test("a country outside the table pays the standard price, not called 'fair'", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}?as=FR`);
  await expect(page.getByText("Price for France", { exact: true })).toBeVisible();
  await expect(page.getByText("$99", { exact: true })).toBeVisible();
});

test("without an override or a known IP, the standard price is shown and no banner", async ({ page }) => {
  await page.goto(`/p/${E2E.buyerProduct}`);
  await expect(page.getByText("Standard price. PayPal confirms your country at checkout.")).toBeVisible();
  await expect(page.getByText(/Demo: simulating/)).toHaveCount(0);
});

test("an unpublished product isn't on sale, and an unknown one is a 404", async ({ page }) => {
  await page.goto(`/p/${E2E.unpublishedProduct}`);
  await expect(page.getByText("This product isn't on sale yet. Please check back soon.")).toBeVisible();
  const res = await page.goto("/p/e2e-does-not-exist");
  expect(res?.status()).toBe(404);
});

test("the checkout API rejects a request that tries to set a price", async ({ request }) => {
  const res = await request.post("/api/checkout/orders?as=IN", { data: { productId: E2E.buyerProduct, amount: 1 } });
  expect(res.status()).toBe(400);
});
