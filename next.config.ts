import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components is off on purpose: the buyer page and quote read the request IP
  // (headers()) on every request, and plain dynamic rendering keeps that simple.
  cacheComponents: false,
  partialPrefetching: false,
  // Playwright runs its own dev server with a separate build folder, so it never collides with
  // a dev server you already have open (see playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // geoip-lite reads its data files from disk at runtime; bundling would break those paths.
  serverExternalPackages: ["geoip-lite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
