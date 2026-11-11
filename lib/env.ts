import "server-only";
import { parseServerEnv } from "./env-schema";

/**
 * Validated server environment. Importing this from a client component fails the build
 * (`server-only`), so secrets can never reach the browser.
 *
 * Browser code uses lib/env.public.ts instead. tsx scripts use lib/env.script.ts.
 */
export const env = parseServerEnv(process.env);
