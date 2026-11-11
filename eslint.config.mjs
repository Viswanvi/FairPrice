import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // App code reads secrets only through lib/env.ts (guarded by `server-only`).
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/env.script", "**/lib/env.script"],
              message: "Use @/lib/env (server) or @/lib/env.public (browser) in app code.",
            },
          ],
        },
      ],
    },
  },
  {
    // CLAUDE.md money-safety rule 4: decide() is pure — no DB, network, AI, clock or randomness.
    files: ["lib/eligibility/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/db",
                "@/lib/db/**",
                "@/lib/paypal",
                "@/lib/paypal/**",
                "@/lib/pricing",
                "@/lib/pricing/**",
                "@/lib/geo",
                "@/lib/geo/**",
                "@/lib/env*",
                "**/db/**",
                "**/paypal/**",
                "**/pricing/**",
                "@prisma/*",
                "@anthropic-ai/*",
                "node:*",
                "next",
                "next/**",
              ],
              message: "lib/eligibility must stay pure (CLAUDE.md money-safety rule 4).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "No network in lib/eligibility." },
        { name: "process", message: "No environment access in lib/eligibility." },
        { name: "performance", message: "No clock in lib/eligibility." },
        { name: "crypto", message: "No randomness in lib/eligibility." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "No clock in lib/eligibility." },
        { object: "Math", property: "random", message: "No randomness in lib/eligibility." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "No clock in lib/eligibility." },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-e2e/**",
    ".geoip/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/spike-output/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
