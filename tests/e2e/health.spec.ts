import { expect, test } from "@playwright/test";

test("GET /api/health reports the app and database as up, uncached", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, db: true });
  expect(res.headers()["cache-control"]).toContain("no-store");
});
