import { expect, test } from "@playwright/test";

test("benchmark: the US tax guide shows the formula-vs-AI difference", async ({ page }) => {
  await page.goto("/benchmark?product=bench-us-tax-guide");
  await expect(page.getByRole("heading", { name: "Formula vs AI", level: 1 })).toBeVisible();
  const tile = page.locator("section", { has: page.getByRole("heading", { name: "More than 20% off where the audience is small" }) });
  await expect(tile).toContainText("34");
  await expect(page.getByRole("heading", { name: "Where they differ most" })).toBeVisible();
  await expect(page.locator("paypal-button")).toHaveCount(0);
});

test("benchmark: switching products", async ({ page }) => {
  await page.goto("/benchmark?product=bench-us-tax-guide");
  await page.getByRole("link", { name: "Coding course" }).click();
  await expect(page).toHaveURL(/product=bench-coding-course/);
  await expect(page.getByRole("heading", { name: /Full-Stack TypeScript/ })).toBeVisible();
});
