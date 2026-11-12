import { expect, test, type Page } from "@playwright/test";
import { TOUR } from "@/lib/assistant/tour";

// The guided tour (docs/AVATAR_SPEC.md section 3) with Alex mocked out: no Gemini call is made.
// Alex's socket is replaced by a fake that confirms each line at once, or refused (then the
// browser voice speaks; headless voices are removed, so each line just shows as text).

/** Pretend the browser reports this connection, and has no installed voices. */
async function connection(page: Page, c: { effectiveType: string; downlink: number; saveData: boolean }) {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, "connection", { get: () => value, configurable: true });
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices = () => [];
  }, c);
}

const FAST = { effectiveType: "4g", downlink: 10, saveData: false };
const SLOW = { effectiveType: "3g", downlink: 1.2, saveData: false };

/** A fake Alex: says each SCRIPT line (instantly) and records what the app sent him. */
async function fakeAlex(page: Page): Promise<{ setup: Array<Record<string, unknown>>; scripts: string[] }> {
  const seen = { setup: [] as Array<Record<string, unknown>>, scripts: [] as string[] };
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") {
        seen.setup.push(msg);
        ws.send(JSON.stringify({ type: "ready", mode: msg.modality === "AUDIO" ? "audio" : "video" }));
      } else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        const line = String(msg.text).slice("SCRIPT: ".length);
        seen.scripts.push(line);
        ws.send(JSON.stringify({ type: "alex_text", text: line }));
        ws.send(JSON.stringify({ type: "turn_complete" }));
      }
    });
  });
  return seen;
}

const line = (id: string) => TOUR.find((s) => s.id === id)!.line.en;

test("Alex gives the tour word for word, waits at the PayPal step, and can be skipped", async ({ page }) => {
  await connection(page, FAST);
  const alex = await fakeAlex(page);
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

  // Alex was asked to say only the tour's own lines, word for word, each shown once.
  for (const text of alex.scripts) expect(TOUR.map((s) => s.line.en)).toContain(text);
  await expect(panel.getByText(line("T3"), { exact: true })).toHaveCount(1);
});

test("typing 'stop' or pressing Stop tour ends the tour", async ({ page }) => {
  await connection(page, FAST);
  await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar).toBeVisible();

  await page.getByTestId("assistant-panel").getByPlaceholder("Or type here…").fill("stop");
  await page.getByTestId("assistant-panel").getByRole("button", { name: "Send" }).click();
  await expect(bar).toHaveCount(0);

  await page.getByRole("button", { name: "Close guide" }).click();
  await page.evaluate(() => sessionStorage.removeItem("fp_assistant_welcome_seen"));
  await page.reload();
  await page.getByTestId("assistant-tour-start").click();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Stop tour" }).click();
  await expect(bar).toHaveCount(0);
});

test("on a slow connection Alex starts as voice only (no video is asked for)", async ({ page }) => {
  await connection(page, SLOW);
  const alex = await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T1"));
  await expect(page.getByTestId("assistant-avatar")).toBeHidden();
  expect(alex.setup[0]).toMatchObject({ modality: "AUDIO" });
});

test("if Alex can't connect, the tour still runs with the browser voice (or text)", async ({ page }) => {
  await connection(page, FAST);
  await page.routeWebSocket("**/ws/alex", (ws) => ws.close());
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T3"));
  await expect(page.getByTestId("assistant-avatar")).toBeHidden();
});

test("the visitor can switch the guide to text", async ({ page }) => {
  await connection(page, FAST);
  await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const output = page.getByTestId("assistant-output");
  await expect(output.getByRole("radio", { name: "Video" })).toBeVisible();
  await output.getByRole("radio", { name: "Text" }).click();
  await expect(output.getByRole("radio", { name: "Text" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T3")); // the tour goes on
});

test("asking 'walk me through the demo' starts the tour", async ({ page }) => {
  await connection(page, SLOW);
  const alex = await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(page.getByTestId("assistant-main")).toHaveText(/Alex is listening/);
  await panel.getByPlaceholder("Or type here…").fill("can you walk me through the demo");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("assistant-tour")).toBeVisible();
  await expect(panel).toContainText(line("T1"));
  expect(alex.scripts[0]).toBe(line("T1"));
});
