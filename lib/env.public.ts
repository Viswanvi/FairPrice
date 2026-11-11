/**
 * The only environment values the browser may see. Next.js inlines NEXT_PUBLIC_* at
 * build time, so each must be referenced literally as process.env.NEXT_PUBLIC_<NAME>.
 * Their validation happens on the server in lib/env-schema.ts.
 */
export const publicEnv = {
  paypalClientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "",
  paypalEnvironment: "sandbox" as const,
};
