import { parseServerEnv } from "./env-schema";

/**
 * Validated environment for standalone tsx scripts (scripts/*.ts), which run outside
 * Next.js and cannot import the `server-only` marker. Never import this from app/.
 * npm scripts load .env with Node's --env-file-if-exists.
 */
export const env = parseServerEnv(process.env);
