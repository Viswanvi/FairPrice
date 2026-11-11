import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database integration tests: `npm run test:db`. Uses DATABASE_URL from .env and cleans up
// every row it creates. Kept out of `npm test` so unit tests stay fast and offline.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on variables already set in the environment.
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
