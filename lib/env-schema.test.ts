import { describe, expect, it } from "vitest";
import { EnvError, parseEnv, parseServerEnv, paypalScriptEnvSchema } from "./env-schema";

const valid = {
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
  PAYPAL_WEBHOOK_ID: "",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "client-id",
  NEXT_PUBLIC_PAYPAL_ENVIRONMENT: "sandbox",
  APP_BASE_URL: "http://localhost:3000/",
  ANTHROPIC_API_KEY: "test-key",
  AI_MODEL: "claude-sonnet-5-5",
  DATABASE_URL: "postgresql://fairprice:fairprice@localhost:5432/fairprice",
  SESSION_SECRET: "x".repeat(32),
  SELLER_DEMO_PASSWORD: "demo-pass-123",
  DEMO_GEO_OVERRIDE: "true",
};

function problemsFor(source: Record<string, string | undefined>): string[] {
  try {
    parseServerEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseServerEnv", () => {
  it("accepts a complete sandbox configuration", () => {
    const env = parseServerEnv(valid);
    expect(env.PAYPAL_WEBHOOK_ID).toBeUndefined();
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
    expect(env.DEMO_GEO_OVERRIDE).toBe(true);
  });

  it("names a missing variable in the error", () => {
    const { ANTHROPIC_API_KEY: _omit, ...rest } = valid;
    expect(problemsFor(rest)).toEqual(["ANTHROPIC_API_KEY is missing"]);
  });

  it("treats a blank required variable as empty", () => {
    expect(problemsFor({ ...valid, PAYPAL_CLIENT_SECRET: "  " })).toEqual([
      "PAYPAL_CLIENT_SECRET is empty",
    ]);
  });

  it("reports only the first problem for a blank variable", () => {
    expect(problemsFor({ ...valid, SELLER_DEMO_PASSWORD: "" })).toEqual([
      "SELLER_DEMO_PASSWORD is empty",
    ]);
  });

  it("rejects the live PayPal API base", () => {
    expect(problemsFor({ ...valid, PAYPAL_API_BASE: "https://api-m.paypal.com" })).toEqual([
      "PAYPAL_API_BASE must be https://api-m.sandbox.paypal.com (sandbox only)",
    ]);
  });

  it("lists every problem at once without echoing values", () => {
    const problems = problemsFor({ ...valid, SESSION_SECRET: "short", AI_MODEL: undefined });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).not.toContain("short");
  });

  it("PayPal script subset ignores unrelated blank variables", () => {
    const env = parseEnv(paypalScriptEnvSchema, { ...valid, SELLER_DEMO_PASSWORD: "" });
    expect(env.PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });

  it("PayPal script subset still rejects the live API base", () => {
    expect(() =>
      parseEnv(paypalScriptEnvSchema, { ...valid, PAYPAL_API_BASE: "https://api-m.paypal.com" }),
    ).toThrow(/sandbox only/);
  });

  it("defaults DEMO_GEO_OVERRIDE to false", () => {
    expect(parseServerEnv({ ...valid, DEMO_GEO_OVERRIDE: undefined }).DEMO_GEO_OVERRIDE).toBe(
      false,
    );
  });
});
