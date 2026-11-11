import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside React Server Components; tests run server code directly.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    // tests/db needs a real database: run it with `npm run test:db` (vitest.db.config.mts).
    exclude: ["node_modules/**", "tests/e2e/**", "tests/db/**", ".next/**"],
  },
});
