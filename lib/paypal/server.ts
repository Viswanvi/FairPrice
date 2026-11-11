import "server-only";
import { env } from "@/lib/env";
import { createPayPalClient, type PayPalCallEvent, type PayPalClient } from "./client";

/**
 * The app's PayPal client, configured from validated env (sandbox only). Server-only: the
 * client secret can never reach the browser. Pass `onCall` to record each call (audit_log).
 */
export function paypalClient(onCall?: (event: PayPalCallEvent) => void | Promise<void>): PayPalClient {
  return createPayPalClient({
    apiBase: env.PAYPAL_API_BASE,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    appBaseUrl: env.APP_BASE_URL,
    onCall,
  });
}
