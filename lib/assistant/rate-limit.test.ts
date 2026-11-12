import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit per key within the window, then frees up as time passes", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, true]);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true); // other visitors unaffected
    t = 1001;
    expect(limiter.take("a")).toBe(true);
  });
});
