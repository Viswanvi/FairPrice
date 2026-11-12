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

/** A fake Alex who starts every line but never finishes it (so the visitor cuts him off mid-line). */
async function slowAlex(page: Page): Promise<string[]> {
  const scripts: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        scripts.push(String(msg.text).slice(8));
        ws.send(JSON.stringify({ type: "alex_text", text: "Hi! I'm the" })); // …and he keeps talking
      }
    });
  });
  return scripts;
}

/** Count lines the browser's own voice is asked to say. */
async function countBrowserVoice(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __spoken: number }).__spoken = 0;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.speak = () => void (window as unknown as { __spoken: number }).__spoken++;
    }
  });
}

test("skipping or stopping Alex mid-line never brings in a second voice", async ({ page }) => {
  await connection(page, SLOW);
  await countBrowserVoice(page);
  const scripts = await slowAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar).toContainText("Tour · 1/");
  await expect.poll(() => scripts.length).toBe(1);

  await bar.getByRole("button", { name: "Skip" }).click(); // cut off mid-line
  await expect(bar).toContainText("Tour · 2/");
  await expect.poll(() => scripts.length).toBe(2);
  await bar.getByRole("button", { name: "Stop tour" }).click();
  await expect(bar).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __spoken: number }).__spoken)).toBe(0);
});

test("Pause holds Alex: nothing new is said until Resume, then he picks the step up from his sentence", async ({ page }) => {
  await connection(page, SLOW);
  await countBrowserVoice(page);
  const scripts = await slowAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect.poll(() => scripts.length).toBe(1);

  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(scripts.length).toBe(1); // held: no new line
  await bar.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => scripts.length).toBe(2);
  // He had said "Hi! I'm the", so he goes on from the sentence he was in, not from the top...
  expect(scripts[1]).toBe(line("T1").slice(line("T1").indexOf("I'm the FairPrice guide.")));
  // ...and the line is in the chat once, not again for each Resume.
  await expect(page.getByTestId("assistant-panel").getByText(line("T1"), { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __spoken: number }).__spoken)).toBe(0);
});

/**
 * Like Gemini: the visitor talks over Alex, so he is cut off at once ("interrupted"), and what they
 * said arrives a moment later as a transcript.
 */
async function bargeInAlex(page: Page, said: string): Promise<string[]> {
  const scripts: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        scripts.push(String(msg.text).slice(8));
        if (scripts.length > 1) return; // only the first line is talked over
        ws.send(JSON.stringify({ type: "alex_text", text: "Hi! I'm the" }));
        setTimeout(() => ws.send(JSON.stringify({ type: "interrupted" })), 300);
        setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: said })), 1100);
      }
    });
  });
  return scripts;
}

for (const [said, expectBar] of [
  ["pause", "Tour · 1/"],
  ["wait", "Tour · 1/"],
] as const) {
  test(`saying "${said}" over Alex pauses the SAME step (it doesn't skip first)`, async ({ page }) => {
    await connection(page, SLOW);
    await countBrowserVoice(page);
    const scripts = await bargeInAlex(page, said);
    await page.goto("/");
    await page.getByTestId("assistant-tour-start").click();
    const bar = page.getByTestId("assistant-tour");
    await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(bar).toContainText(expectBar);
    await page.waitForTimeout(1500);
    expect(scripts.length).toBe(1); // the next line was never started
    expect(await page.evaluate(() => (window as unknown as { __spoken: number }).__spoken)).toBe(0);
  });
}

for (const said of ["resume", "continue", "जारी रखो"]) {
  test(`saying "${said}" over a playing line starts that line again; the tour does not pause`, async ({ page }) => {
    await connection(page, SLOW);
    const scripts = await bargeInAlex(page, said);
    await page.goto("/");
    await page.getByTestId("assistant-tour-start").click();
    const bar = page.getByTestId("assistant-tour");
    await expect.poll(() => scripts.length).toBe(2);
    // The same step, from the start, in the language they just spoke.
    const t1 = TOUR.find((s) => s.id === "T1")!.line;
    expect(scripts[1]).toBe(/[ऀ-ॿ]/.test(said) ? t1.hi : t1.en);
    await expect(bar).toContainText(/(Tour|टूर) · 1\//);
    await expect(bar.getByRole("button", { name: "Resume" })).toHaveCount(0);
  });
}

test("after a question pauses the tour, Alex's resume_tour (GCS resume_demo) carries on", async ({ page }) => {
  await connection(page, SLOW);
  const scripts: string[] = [];
  const toolResults: unknown[] = [];
  let socket: { send: (s: string) => void } | null = null;
  await page.routeWebSocket("**/ws/alex", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "tool_response") toolResults.push(msg.responses[0].response);
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        scripts.push(String(msg.text).slice(8));
        if (scripts.length > 1) return;
        ws.send(JSON.stringify({ type: "alex_text", text: "Hi! I'm the" }));
        setTimeout(() => ws.send(JSON.stringify({ type: "interrupted" })), 300);
        setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: "how much is it in India?" })), 900);
      }
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assistant-panel")).toContainText("I heard something, so I paused");
  // The visitor says "okay, let's carry on" in their own words; Alex (Gemini) calls resume_tour.
  socket!.send(JSON.stringify({ type: "tool_call", calls: [{ id: "r1", name: "resume_tour", args: {} }] }));
  await expect.poll(() => scripts.length).toBe(2);
  expect(scripts[1]).toBe(line("T1"));
  expect(toolResults[0]).toMatchObject({ ok: true });
  await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible();
});

test('"skip" by voice: one step only, no pause from Gemini\'s stray turn end, no "SCRIPT:" in the chat', async ({ page }) => {
  await connection(page, SLOW);
  const scripts: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        scripts.push(String(msg.text).slice(8));
        if (scripts.length === 1) {
          // The visitor says "skip please" over line 1; the words arrive in two pieces.
          ws.send(JSON.stringify({ type: "alex_text", text: "Hi! I'm the" }));
          setTimeout(() => ws.send(JSON.stringify({ type: "interrupted" })), 300);
          setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: "skip" })), 900);
          setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: " please" })), 1300);
        } else if (scripts.length === 2) {
          // Line 2: he reads the marker aloud, and Gemini ends its own reply to "skip" (a stray interrupt).
          ws.send(JSON.stringify({ type: "alex_text", text: "SCRIPT: First, how" }));
          setTimeout(() => ws.send(JSON.stringify({ type: "interrupted" })), 200);
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "alex_text", text: " prices are set." }));
            ws.send(JSON.stringify({ type: "turn_complete" }));
          }, 1200);
        }
      }
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar).toContainText("Tour · 3/"); // 1 → (skip) → 2 said in full → 3
  await expect.poll(() => scripts.length).toBe(3);
  expect(scripts).toEqual([line("T1"), line("T2"), line("T3")]); // each once: no double skip, no repeat
  await expect(bar.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await expect(page.getByTestId("assistant-panel")).not.toContainText("SCRIPT");
});

test("stray turn ends from Gemini don't finish a line early: no leaked caption, and the next skip still works", async ({ page }) => {
  await connection(page, SLOW);
  const scripts: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    const sayIt = (text: string, after = 0) =>
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "alex_text", text }));
        ws.send(JSON.stringify({ type: "turn_complete" }));
      }, after);
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        const text = String(msg.text).slice(8);
        scripts.push(text);
        if (text === line("T4")) {
          sayIt(text);
          // The visitor says "Skip." at the waiting step.
          setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: "Skip." })), 1500);
        } else if (text === line("T5")) {
          // Gemini first ends its own reply to "Skip." (interrupted, then turn_complete), THEN says the line.
          ws.send(JSON.stringify({ type: "interrupted" }));
          ws.send(JSON.stringify({ type: "turn_complete" }));
          // He speaks it over several seconds, like the real Alex: a caption piece every half second,
          // with one longer gap in the middle.
          const words = text.split(" ");
          words.forEach((w, i) => {
            const at = 1500 + i * 120 + (i > words.length / 2 ? 2500 : 0);
            setTimeout(() => ws.send(JSON.stringify({ type: "alex_text", text: (i ? " " : "") + w })), at);
          });
          const endAt = 1500 + words.length * 120 + 2700;
          setTimeout(() => ws.send(JSON.stringify({ type: "turn_complete" })), endAt);
          setTimeout(() => ws.send(JSON.stringify({ type: "user_text", text: "Skip, Alex." })), endAt + 2000);
        } else if (text === line("T6")) {
          ws.send(JSON.stringify({ type: "interrupted" }));
          ws.send(JSON.stringify({ type: "turn_complete" }));
          sayIt(text, 1000);
        } else sayIt(text);
      }
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const panel = page.getByTestId("assistant-panel");
  test.setTimeout(120_000);
  // While he is still saying T5, the tour must not treat the line as finished ("Waiting for you").
  await expect.poll(() => scripts.includes(line("T5")), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(4000);
  await expect(panel).not.toContainText("Waiting for you");
  // T6 is said in full and the tour goes on to the seller part.
  await expect.poll(() => scripts.includes(line("T6")), { timeout: 40_000 }).toBe(true);
  await expect.poll(() => scripts.length, { timeout: 30_000 }).toBeGreaterThan(scripts.indexOf(line("T6")) + 1);
  // Each line asked once, each shown once (no second bubble from a leaked caption).
  for (const id of ["T4", "T5", "T6"]) {
    expect(scripts.filter((s) => s === line(id)).length, id).toBe(1);
    await expect(panel.getByText(line(id), { exact: true })).toHaveCount(1);
  }
  await expect(panel.getByText(/^(offered|reserves|cancelled|charged)/)).toHaveCount(0);
  expect(await panel.locator("p.rounded-2xl").count()).toBeLessThanOrEqual(scripts.length + 2); // lines + the two "Skip" bubbles
});

test("a line cut off by noise (nobody spoke) simply starts again", async ({ page }) => {
  await connection(page, SLOW);
  const scripts: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text" && String(msg.text).startsWith("SCRIPT: ")) {
        scripts.push(String(msg.text).slice(8));
        ws.send(JSON.stringify({ type: "alex_text", text: "Hi! I'm" }));
        if (scripts.length === 1) setTimeout(() => ws.send(JSON.stringify({ type: "interrupted" })), 300);
        else ws.send(JSON.stringify({ type: "turn_complete" }));
      }
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect.poll(() => scripts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  expect(scripts.slice(0, 3)).toEqual([line("T1"), line("T1"), line("T2")]); // line 1 again, then on
  await expect(page.getByTestId("assistant-tour").getByRole("button", { name: "Resume" })).toHaveCount(0);
});

test('saying "skip" over Alex skips exactly one step', async ({ page }) => {
  await connection(page, SLOW);
  const scripts = await bargeInAlex(page, "skip");
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect(page.getByTestId("assistant-tour")).toContainText("Tour · 2/");
  await expect.poll(() => scripts.length).toBe(2);
  expect(scripts[1]).toBe(line("T2"));
});

test("talking over Alex with a question pauses the tour so he can answer; Resume continues", async ({ page }) => {
  await connection(page, SLOW);
  const scripts = await bargeInAlex(page, "what does this cost in India?");
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 10_000 });
  await expect(bar).toContainText("Tour · 1/");
  await bar.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => scripts.length).toBe(2);
  expect(scripts[1]).toBe(line("T1")); // the step starts again
});

/**
 * A stand-in for Chrome's speech recognition: it "hears" whatever window.__say holds (once), so the
 * local "continue" listener that runs while Alex is paused can be tested headless.
 */
async function fakeBrowserEars(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __say: string; SpeechRecognition: unknown; webkitSpeechRecognition: unknown };
    w.__say = "";
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      private timer: ReturnType<typeof setTimeout> | null = null;
      start() {
        this.timer = setTimeout(() => {
          const said = w.__say;
          w.__say = "";
          if (said) this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: said }], { isFinal: true })] });
          this.onend?.();
        }, 200);
      }
      stop() {
        this.abort();
      }
      abort() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.onend?.();
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  });
}

const say = (page: Page, words: string) => page.evaluate((s) => ((window as unknown as { __say: string }).__say = s), words);

test('saying "continue" carries on a tour paused with the Pause button', async ({ page }) => {
  await connection(page, SLOW);
  await fakeBrowserEars(page);
  const scripts = await slowAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect.poll(() => scripts.length).toBe(1);
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("assistant-panel")).toContainText("Say “continue”");
  await say(page, "okay continue");
  await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(() => scripts.length).toBe(2);
});

test('after saying "pause" over Alex, saying "continue" carries on', async ({ page }) => {
  await connection(page, SLOW);
  await fakeBrowserEars(page);
  const scripts = await bargeInAlex(page, "pause");
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
  await say(page, "जारी रखो");
  await expect.poll(() => scripts.length).toBe(2);
  expect(scripts[1]).toBe(line("T1"));
});

test('in Talk mode, Pause holds Alex and saying "continue" (or typing it) releases him', async ({ page }) => {
  await connection(page, SLOW);
  await fakeBrowserEars(page);
  await slowAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const holdButton = page.getByTestId("assistant-hold");
  await holdButton.click();
  await expect(holdButton).toHaveText("Resume");
  await say(page, "continue please");
  await expect(holdButton).toHaveText("Pause");
});

test("after 20 s of silence Alex pauses; just speaking wakes him and he gets what was said", async ({ page }) => {
  test.setTimeout(90_000);
  await connection(page, SLOW);
  await fakeBrowserEars(page);
  const sent: string[] = [];
  let sockets = 0;
  await page.routeWebSocket("**/ws/alex", (ws) => {
    sockets++;
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
      else if (msg.type === "text") sent.push(String(msg.text));
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const main = page.getByTestId("assistant-main");
  await expect(main).toHaveText(/Alex is listening/);
  await expect(main).toHaveText(/Alex paused · talk or tap/, { timeout: 30_000 }); // 20 s of silence
  await say(page, "I need a figma template");
  await expect(main).toHaveText(/Alex is listening/);
  await expect.poll(() => sent.at(-1)).toBe("I need a figma template");
  expect(sockets).toBe(2); // the same conversation, reconnected
  await expect(page.getByTestId("assistant-panel")).toContainText("I need a figma template");
});

test('when Alex has gone quiet at a waiting step (20 s), saying "skip" still skips and wakes him', async ({ page }) => {
  test.setTimeout(90_000);
  await connection(page, SLOW);
  await fakeBrowserEars(page);
  const alex = await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect(bar).toContainText("Tour · 4/");
  await expect(page.getByTestId("assistant-panel")).toContainText("Waiting for you");
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-testid=assistant-main]") === null), { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(24_000); // the 20 s silence pause closes Alex's stream
  await expect(page.getByTestId("assistant-panel")).not.toContainText("just talk to continue");
  await say(page, "skip");
  await expect(bar).toContainText("Tour · 5/");
  await expect.poll(() => alex.scripts.at(-1)).toBe(line("T5")); // he woke up and said the next line
  expect(alex.setup.length).toBe(2); // reconnected once
  expect(alex.scripts.filter((s) => s === line("T5")).length).toBe(1);
});

test("typing 'continue' carries on a paused tour", async ({ page }) => {
  await connection(page, SLOW);
  const scripts = await slowAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const bar = page.getByTestId("assistant-tour");
  await expect.poll(() => scripts.length).toBe(1);
  await bar.getByRole("button", { name: "Pause" }).click();
  await page.getByTestId("assistant-panel").getByPlaceholder("Or type here…").fill("continue");
  await page.getByTestId("assistant-panel").getByRole("button", { name: "Send" }).click();
  await expect.poll(() => scripts.length).toBe(2);
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

test("on a slow connection the visitor can still pick Video, and Alex switches to it", async ({ page }) => {
  await connection(page, SLOW);
  const alex = await fakeAlex(page);
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  const output = page.getByTestId("assistant-output");
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T1"));
  await expect(output.getByRole("radio", { name: "Voice" })).toHaveAttribute("aria-checked", "true");
  expect(alex.setup[0]).toMatchObject({ modality: "AUDIO" });

  await output.getByRole("radio", { name: "Video" }).click();
  await expect.poll(() => alex.setup.length).toBeGreaterThan(1);
  expect(alex.setup.at(-1)?.modality).toBeUndefined(); // video asked for
  await expect(page.getByTestId("assistant-avatar")).toBeVisible();
  await expect(output.getByRole("radio", { name: "Video" })).toHaveAttribute("aria-checked", "true");
});

test("if Alex can't connect, the tour still runs with the browser voice (or text)", async ({ page }) => {
  await connection(page, FAST);
  await page.routeWebSocket("**/ws/alex", (ws) => ws.close());
  await page.goto("/");
  await page.getByTestId("assistant-tour-start").click();
  await expect(page.getByTestId("assistant-panel")).toContainText(line("T3"));
  await expect(page.getByTestId("assistant-avatar")).toBeHidden();
});

test("when Alex can't connect, the earlier guide greets once, however often Talk is tapped", async ({ page }) => {
  await connection(page, SLOW);
  await page.routeWebSocket("**/ws/alex", (ws) => ws.close());
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const panel = page.getByTestId("assistant-panel");
  const greeting = "Hi! I'm the FairPrice AI guide. Do you want to buy something, or sell your own product?";
  await expect(panel.getByText(greeting, { exact: true })).toHaveCount(1);
  await expect(panel).toContainText("Alex isn't available right now");

  const main = page.getByTestId("assistant-main");
  // The earlier guide listens after greeting: a tap stops that, and the next is "Talk to Alex" again.
  await expect(main).toHaveText(/Listening…|Talk to Alex/);
  if ((await main.textContent())?.includes("Listening")) await main.click();
  await expect(main).toHaveText(/Talk to Alex/);
  await main.click(); // tapped again while Alex is still away
  await page.waitForTimeout(1500);
  await expect(panel.getByText(greeting, { exact: true })).toHaveCount(1);
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

test("ending Alex and talking to him again continues the same conversation, with no second greeting", async ({ page }) => {
  await connection(page, SLOW);
  const setups: Array<Record<string, unknown>> = [];
  const greetings: string[] = [];
  await page.routeWebSocket("**/ws/alex", (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type === "setup") {
        setups.push(msg);
        ws.send(JSON.stringify({ type: "ready", mode: "audio" }));
        ws.send(JSON.stringify({ type: "resume_handle", handle: "conversation-1" }));
      } else if (msg.type === "text" && String(msg.text).startsWith("APP: The visitor just opened the guide")) {
        greetings.push(String(msg.text));
        ws.send(JSON.stringify({ type: "alex_text", text: "Hi, I'm Alex. Buying or selling?" }));
        ws.send(JSON.stringify({ type: "turn_complete" }));
      }
    });
  });
  await page.goto("/");
  await page.getByTestId("assistant-welcome").getByRole("button", { name: "Talk to Alex" }).click();
  const main = page.getByTestId("assistant-main");
  await expect(main).toHaveText(/Alex is listening/);
  await expect(page.getByTestId("assistant-panel")).toContainText("Hi, I'm Alex. Buying or selling?");

  await main.click(); // "Alex is listening · tap to end"
  await expect(main).toHaveText(/Talk to Alex/);
  await main.click(); // talk again
  await expect(main).toHaveText(/Alex is listening/);
  expect(setups).toHaveLength(2);
  expect(setups[1].resume_handle).toBe("conversation-1"); // the same Gemini conversation
  await page.waitForTimeout(1000);
  expect(greetings).toHaveLength(1); // greeted once, not again
});
