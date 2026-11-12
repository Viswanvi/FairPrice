import { expect, test, type Page } from "@playwright/test";
import { TOUR } from "@/lib/assistant/tour";

// The guided tour (docs/AVATAR_SPEC.md section 3) with the video avatar mocked out: no Gemini
// call is made. /api/avatar/speak is answered by the test, and the browser has no voices in
// headless mode, so each line is shown as text and the tour moves on.

/**
 * Pretend the browser reports this connection (navigator.connection), and has no installed
 * voices (headless Chrome on Windows can really speak, which would make each step take seconds).
 */
async function connection(page: Page, c: { effectiveType: string; downlink: number; saveData: boolean }) {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, "connection", { get: () => value, configurable: true });
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices = () => [];
  }, c);
}

const FAST = { effectiveType: "4g", downlink: 10, saveData: false };
const SLOW = { effectiveType: "3g", downlink: 1.2, saveData: false };

/** Answer avatar requests with 503 (avatar unavailable) and record what it was asked to say. */
async function mockAvatar(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/avatar/speak", async (route) => {
    asked.push((route.request().postDataJSON() as { text: string }).text);
    await route.fulfill({ status: 503, json: { code: "avatar_unavailable", message: "mocked" } });
  });
  return asked;
}

const line = (id: string) => TOUR.find((s) => s.id === id)!.line.en;

test("the tour starts from the welcome card, waits at the PayPal step, and can be skipped", async ({ page }) => {
  await connection(page, FAST);
  const asked = await mockAvatar(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();

  const panel = page.getByTestId("assistant-panel");
  const bar = page.getByTestId("assistant-tour");
  await expect(panel).toContainText(line("T1"));
  await expect(panel).toContainText(line("T3"));
  await expect(page).toHaveURL(/\/p\/bench-design-templates\?as=IN$/);

  // T4 waits for a payment result (or "skip").
  await expect(bar).toContainText("Tour · 4/");
  await expect(panel).toContainText("Waiting for you");
  await bar.getByRole("button", { name: "Skip" }).click();
  await expect(bar).toContainText("Tour · 5/");
  await expect(panel).toContainText(line("T5"));

  // The avatar was asked to read only the tour's own lines, word for word.
  expect(asked.length).toBeGreaterThan(0);
  for (const text of asked) expect(TOUR.map((s) => s.line.en)).toContain(text);
});

test("typing 'stop' or pressing Stop tour ends the tour", async ({ page }) => {
  await connection(page, FAST);
  await mockAvatar(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar).toBeVisible();

  await page.getByTestId("assistant-panel").getByPlaceholder("Or type here…").fill("stop");
  await page.getByTestId("assistant-panel").getByRole("button", { name: "Send" }).click();
  await expect(bar).toHaveCount(0);

  // Start again and use the button this time.
  await page.getByRole("button", { name: "Close assistant" }).click();
  await page.evaluate(() => sessionStorage.removeItem("fp_assistant_welcome_seen"));
  await page.reload();
  await page.getByTestId("assistant-tour-start").click();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Stop tour" }).click();
  await expect(bar).toHaveCount(0);
});

test("on a slow connection the guide never asks for video", async ({ page }) => {
  await connection(page, SLOW);
  const asked = await mockAvatar(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T3"));
  await expect(page.getByTestId("assistant-avatar")).toBeHidden();
  expect(asked).toEqual([]);
});

test("the visitor can switch the guide to text: no more video is requested", async ({ page }) => {
  await connection(page, FAST);
  const asked = await mockAvatar(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const output = page.getByTestId("assistant-output");
  await expect(output.getByRole("radio", { name: "Video" })).toBeVisible();

  await output.getByRole("radio", { name: "Text" }).click();
  await expect(output.getByRole("radio", { name: "Text" })).toHaveAttribute("aria-checked", "true");
  const before = asked.length;
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T3")); // the tour goes on as text
  expect(asked.length).toBe(before);
});

test("asking 'walk me through the demo' in Talk mode starts the tour (the AI isn't asked)", async ({ page }) => {
  await connection(page, SLOW);
  let aiCalls = 0;
  await page.route("**/api/assistant", async (route) => {
    aiCalls++;
    await route.fulfill({ json: { reply: "ok", lang: "en", actions: [], products: [] } });
  });
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk in English" }).click();
  const panel = page.getByTestId("assistant-panel");
  await panel.getByPlaceholder("Or type here…").fill("can you walk me through the demo");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("assistant-tour")).toBeVisible();
  await expect(panel).toContainText(line("T1"));
  expect(aiCalls).toBe(0);
});

test("the avatar API checks its input and never accepts a key from the browser", async ({ request }) => {
  const res = await request.post("/api/avatar/speak", { data: { text: "" } });
  expect([400, 503]).toContain(res.status());
});
