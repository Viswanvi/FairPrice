import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHealth } from "./health";

describe("checkHealth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("database answers → 200 { ok: true, db: true }", async () => {
    const result = await checkHealth(async () => [{ "?column?": 1 }]);
    expect(result).toEqual({ status: 200, body: { ok: true, db: true } });
  });

  it("database throws → 503 { ok: false, db: false }, logging only the error name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Can't reach database server at secret-host.example:5432");
    error.name = "PrismaClientInitializationError";

    const result = await checkHealth(async () => {
      throw error;
    });

    expect(result).toEqual({ status: 503, body: { ok: false, db: false } });
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0].join(" ");
    expect(logged).toContain("PrismaClientInitializationError");
    expect(logged).not.toContain("secret-host");
  });

  it("database never answers → 503 once the timeout passes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const result = await checkHealth(() => new Promise(() => {}), 25);
    expect(result).toEqual({ status: 503, body: { ok: false, db: false } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a late failure after the timeout doesn't cause an unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkHealth(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 50)),
      10,
    );
    expect(result.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 80)); // let the late rejection fire
  });
});
