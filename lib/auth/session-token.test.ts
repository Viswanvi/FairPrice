import { describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, SESSION_TTL_SECONDS, verifySessionToken } from "./session-token";

const SECRET = "s".repeat(32);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

describe("session tokens", () => {
  it("round-trips the seller ID", () => {
    expect(verifySessionToken(createSessionToken("demo-seller", NOW, SECRET), NOW, SECRET)).toBe("demo-seller");
  });

  it("expires after the TTL", () => {
    const token = createSessionToken("demo-seller", NOW, SECRET);
    expect(verifySessionToken(token, NOW + (SESSION_TTL_SECONDS - 1) * 1000, SECRET)).toBe("demo-seller");
    expect(verifySessionToken(token, NOW + SESSION_TTL_SECONDS * 1000, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    expect(verifySessionToken(createSessionToken("demo-seller", NOW, "x".repeat(32)), NOW, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const [, sig] = createSessionToken("demo-seller", NOW, SECRET).split(".");
    const forged = Buffer.from(JSON.stringify({ sid: "other", exp: 9_999_999_999 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, NOW, SECRET)).toBeNull();
  });

  it("rejects missing and malformed tokens", () => {
    for (const bad of [undefined, "", "abc", "a.b.c", ".", "x."]) {
      expect(verifySessionToken(bad, NOW, SECRET)).toBeNull();
    }
  });
});

describe("passwordMatches", () => {
  it("accepts the right password and rejects others", () => {
    expect(passwordMatches("demo-pass-123", "demo-pass-123")).toBe(true);
    expect(passwordMatches("demo-pass-124", "demo-pass-123")).toBe(false);
    expect(passwordMatches("", "demo-pass-123")).toBe(false);
  });

  it("never matches when no password is configured", () => {
    expect(passwordMatches("", "")).toBe(false);
  });
});
