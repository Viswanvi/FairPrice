import { expect, test, type Page } from "@playwright/test";
import { E2E, sellerPassword } from "./fixtures";

// These tests change shared data (edit, approve), so they run in order.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/seller/sign-in");
  await page.getByLabel("Password").fill(sellerPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/seller$/);
}

test("signed-out visitors are sent to sign-in, and a wrong password is refused", async ({ page }) => {
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/sign-in$/);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  // (Next.js's route announcer also has role="alert", so match the message itself.)
  await expect(page.getByRole("alert").filter({ hasText: "That password isn't right." })).toBeVisible();
});

test("the product list shows the seeded products", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("link", { name: /E2E seller course/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /E2E buyer course/ })).toContainText("Approved");
});

test("product setup validates limits, then opens the workspace", async ({ page }) => {
  await signIn(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("Product name").fill(`${E2E.titlePrefix} new product - delete me`);
  await page.getByLabel("Or describe it").fill("An E2E test product description.");
  await page.getByLabel("Base price (USD)").fill("10");
  await page.getByLabel("Minimum price (USD)").fill("20");
  await expect(page.getByText("Can't be above the base price.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  await page.getByLabel("Minimum price (USD)").fill("3");
  await expect(page.getByText("No country will pay less than $3.")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Analyze audience" })).toBeVisible();
});

test("editing a price: a rejected edit turns red, a valid edit saves", async ({ page }) => {
  await signIn(page);
  await page.goto(`/seller/products/${E2E.sellerProduct}`);
  await expect(page.getByRole("heading", { name: "Version 1" })).toBeVisible();

  const price = page.locator('[row-id="IN"] [col-id="price"]');
  await expect(price).toHaveText("$35");

  await price.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await expect(price).toHaveClass(/cell-invalid/);
  await expect(price).toHaveText("$35"); // the saved price is unchanged

  await price.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("39");
  await page.keyboard.press("Enter");
  await expect(price).toHaveText("$39");
  await expect(price).not.toHaveClass(/cell-invalid/);
  await expect(page.locator('[row-id="IN"] [col-id="discountPct"]')).toHaveText("−61%");
});

test("Formula vs AI shows the difference column", async ({ page }) => {
  await signIn(page);
  await page.goto(`/seller/products/${E2E.sellerProduct}`);
  await page.getByRole("radio", { name: "Formula vs AI" }).click();
  await expect(page.getByRole("columnheader", { name: /Difference/ })).toBeVisible();
  await expect(page.locator('[row-id="IN"] [col-id="diff"]')).toContainText("+$9");
});

test("approving publishes the page with link, embed and fingerprint", async ({ page }) => {
  await signIn(page);
  await page.goto(`/seller/products/${E2E.sellerProduct}`);
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByRole("heading", { name: "Your product page is live" })).toBeVisible();
  await expect(page.getByText(`/p/${E2E.sellerProduct}`, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("<iframe", { exact: false })).toBeVisible();
  await expect(page.getByText("Fingerprint", { exact: true })).toBeVisible();
});

test("the orders tab shows the empty state", async ({ page }) => {
  await signIn(page);
  await page.goto(`/seller/products/${E2E.sellerProduct}`);
  await page.getByRole("button", { name: "Orders" }).click();
  await expect(page.getByText("No orders yet.")).toBeVisible();
});
