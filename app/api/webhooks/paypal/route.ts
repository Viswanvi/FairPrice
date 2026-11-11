import { handleWebhookRequest } from "@/lib/checkout/webhook";
import { route } from "@/lib/http";
import { paypalClient } from "@/lib/paypal/server";

/**
 * POST /api/webhooks/paypal — verify the signature first (401 if invalid, no side effects), store
 * the event once, then the same idempotent finalize path. Logic and tests: lib/checkout/webhook.ts.
 */
export const POST = route(async (request: Request) =>
  handleWebhookRequest(await request.text(), request.headers, { paypal: paypalClient() }),
);
