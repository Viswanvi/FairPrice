import { z } from "zod";

/**
 * Environment schema shared by the Next.js server (lib/env.ts) and tsx scripts
 * (lib/env.script.ts). Every variable in .env.example is listed here.
 *
 * Error messages name the variable and the problem, never the value.
 */

const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

const required = (name: string) =>
  z
    .string({ error: `${name} is missing` })
    .trim()
    .min(1, { error: `${name} is empty`, abort: true });

// Blank values in .env files arrive as "" — treat them as "not set".
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const booleanFlag = (name: string) =>
  z
    .enum(["true", "false", ""], { error: `${name} must be "true" or "false"` })
    .optional()
    .transform((v) => v === "true");

export const serverEnvSchema = z.object({
  // PayPal (sandbox only — CLAUDE.md money-safety rule 8)
  PAYPAL_CLIENT_ID: required("PAYPAL_CLIENT_ID"),
  PAYPAL_CLIENT_SECRET: required("PAYPAL_CLIENT_SECRET"),
  // Optional until deployment; the webhook route returns 503 while it is unset.
  PAYPAL_WEBHOOK_ID: optional,
  PAYPAL_API_BASE: required("PAYPAL_API_BASE")
    .transform((v) => v.replace(/\/+$/, ""))
    .refine((v) => v === SANDBOX_API_BASE, {
      error: `PAYPAL_API_BASE must be ${SANDBOX_API_BASE} (sandbox only)`,
    }),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: required("NEXT_PUBLIC_PAYPAL_CLIENT_ID"),
  NEXT_PUBLIC_PAYPAL_ENVIRONMENT: z.literal("sandbox", {
    error: 'NEXT_PUBLIC_PAYPAL_ENVIRONMENT must be "sandbox"',
  }),

  // App
  APP_BASE_URL: required("APP_BASE_URL")
    .pipe(z.url({ error: "APP_BASE_URL must be a full URL, e.g. http://localhost:3000" }))
    .transform((v) => v.replace(/\/+$/, "")),

  // AI
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  AI_MODEL: required("AI_MODEL"),

  // Database
  DATABASE_URL: required("DATABASE_URL").refine(
    (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
    { error: "DATABASE_URL must be a postgresql:// connection string" },
  ),

  // Seller sign-in
  SESSION_SECRET: required("SESSION_SECRET").refine((v) => v.length >= 32, {
    error: "SESSION_SECRET must be at least 32 characters",
  }),
  SELLER_DEMO_PASSWORD: required("SELLER_DEMO_PASSWORD").refine((v) => v.length >= 8, {
    error: "SELLER_DEMO_PASSWORD must be at least 8 characters",
  }),

  // Demo only: ?as=XX simulates the visitor's IP country for the DISPLAYED price.
  DEMO_GEO_OVERRIDE: booleanFlag("DEMO_GEO_OVERRIDE"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...problems.map((p) => `  - ${p}`),
        "Copy .env.example to .env and fill in the values.",
      ].join("\n"),
    );
    this.name = "EnvError";
  }
}

/**
 * The PayPal subset, for scripts that only talk to the PayPal sandbox (spike-paypal).
 * They should not fail because an unrelated variable (e.g. a seller password) is blank.
 */
export const paypalScriptEnvSchema = serverEnvSchema.pick({
  PAYPAL_CLIENT_ID: true,
  PAYPAL_CLIENT_SECRET: true,
  PAYPAL_API_BASE: true,
});

/** The AI subset, for scripts that only call the Anthropic API (ai-stability, run-benchmark). */
export const aiScriptEnvSchema = serverEnvSchema.pick({ ANTHROPIC_API_KEY: true, AI_MODEL: true });

/** Parse and validate env vars. Throws EnvError listing every problem by variable name. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}

/** Validate env vars against any schema. Throws EnvError naming each bad variable. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".");
    return issue.message.includes(name) ? issue.message : `${name}: ${issue.message}`;
  });
  throw new EnvError(problems);
}
