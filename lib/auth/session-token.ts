import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Seller session tokens: base64url(JSON {sid, exp}) + "." + base64url(HMAC-SHA256(secret, payload)).
 * Pure functions (time and secret passed in) so they can be unit-tested.
 */

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(sellerId: string, nowMs: number, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sid: sellerId, exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The seller ID if the token is authentic and unexpired, otherwise null. */
export function verifySessionToken(token: string | undefined, nowMs: number, secret: string): string | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid?: unknown; exp?: unknown };
    if (typeof data.sid !== "string" || typeof data.exp !== "number") return null;
    return data.exp > Math.floor(nowMs / 1000) ? data.sid : null;
  } catch {
    return null;
  }
}

/** Constant-time password comparison (hashing first makes the lengths equal). */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && expected.length > 0;
}
