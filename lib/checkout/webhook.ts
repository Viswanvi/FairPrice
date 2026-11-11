import { z } from "zod";
import { insertAuditLog } from "@/lib/db/audit-log";
import { prisma } from "@/lib/db/client";
import { recordWebhookEvent } from "@/lib/db/webhook-events";
import { HttpError, jsonError } from "@/lib/http";
import type { PayPalClient } from "@/lib/paypal/client";
import { PayPalError, WebhookConfigError } from "@/lib/paypal/errors";
import { finalizeOrder, type FinalizeDeps } from "./finalizeOrder";

/**
 * What to do with a VERIFIED, first-time PayPal webhook event. Every path goes through the same
 * idempotent finalizeOrder, so a webhook racing the browser's finalize call is harmless.
 *
 * Field paths: CHECKOUT.ORDER.APPROVED carries the order as `resource` (resource.id = order ID).
 * Payment events are expected to reference it at resource.supplementary_data.related_ids.order_id.
 * Webhooks were NOT covered by the Phase 2 spike, so both are parsed defensively: anything that
 * doesn't match is recorded as "unmatched" and nothing else happens. Confirm with a real event in
 * Phase 14 (docs/PROGRESS.md).
 */

export const webhookEventSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.unknown(),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

const orderResource = z.looseObject({ id: z.string().min(1) });
const paymentResource = z.looseObject({
  id: z.string().optional(),
  supplementary_data: z.looseObject({ related_ids: z.looseObject({ order_id: z.string().min(1) }) }),
});

export const HANDLED_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
] as const;

/** The PayPal order ID an event refers to, or null. */
export function relatedPayPalOrderId(event: WebhookEvent): string | null {
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const r = orderResource.safeParse(event.resource);
    return r.success ? r.data.id : null;
  }
  const r = paymentResource.safeParse(event.resource);
  return r.success ? r.data.supplementary_data.related_ids.order_id : null;
}

/** The resource's own ID (order, authorization or capture), for storage. */
export function resourceIdOf(event: WebhookEvent): string | null {
  const r = z.looseObject({ id: z.string() }).safeParse(event.resource);
  return r.success ? r.data.id : null;
}

export interface WebhookDeps extends FinalizeDeps {
  paypal: FinalizeDeps["paypal"] & Pick<PayPalClient, "verifyWebhookSignature">;
}

/**
 * The whole webhook request (CLAUDE.md rule 7), kept out of the route so it can be tested:
 * 1. verify the signature with PayPal BEFORE anything else — invalid → 401, no side effects;
 * 2. store the event ID once — a duplicate delivery → 200 and nothing else;
 * 3. hand it to the same idempotent finalizeOrder path. If that fails, the event is forgotten so
 *    PayPal's retry is processed instead of being ignored as a duplicate.
 */
export async function handleWebhookRequest(rawBody: string, headers: Headers, deps: WebhookDeps): Promise<Response> {
  let verified: boolean;
  try {
    verified = await deps.paypal.verifyWebhookSignature(headers, rawBody);
  } catch (error) {
    if (error instanceof WebhookConfigError) {
      return jsonError(503, "webhook_not_configured", "Webhooks aren't set up yet (PAYPAL_WEBHOOK_ID is empty).");
    }
    if (error instanceof PayPalError) {
      // PayPal retries webhooks that don't get a 2xx, so a temporary failure is safe to report.
      return jsonError(502, "verification_unavailable", "Couldn't verify the webhook with PayPal right now.");
    }
    throw error;
  }
  if (!verified) return jsonError(401, "invalid_signature", "Webhook signature verification failed.");

  const parsed = webhookEventSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) throw new HttpError(400, "invalid_event", "Unrecognised webhook event.");
  const event = parsed.data;

  const isNew = await recordWebhookEvent({
    eventId: event.id,
    eventType: event.event_type,
    resourceId: resourceIdOf(event),
    verified: true,
    payload: event,
  });
  if (!isNew) return Response.json({ received: true, duplicate: true });

  try {
    const outcome = await handleWebhookEvent(event, deps);
    return Response.json({ received: true, outcome });
  } catch (error) {
    await prisma.webhookEvent.delete({ where: { eventId: event.id } }).catch(() => undefined);
    console.error("[webhook] handling failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return jsonError(500, "handling_failed", "The event couldn't be processed; PayPal will retry.");
  }
}

export async function handleWebhookEvent(event: WebhookEvent, deps: FinalizeDeps): Promise<string> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.event_type)) return `ignored ${event.event_type}`;

  const paypalOrderId = relatedPayPalOrderId(event);
  if (!paypalOrderId) return "unmatched: no order ID in the event";
  const order = await prisma.order.findUnique({ where: { paypalOrderId }, select: { id: true, status: true } });
  if (!order) return "unmatched: unknown order";

  let outcome: string;
  if (event.event_type === "PAYMENT.CAPTURE.DENIED") {
    // PayPal reversed a capture we recorded as complete: a person must look at it.
    if (order.status === "CAPTURED") {
      await prisma.order.update({ where: { id: order.id }, data: { status: "NEEDS_REVIEW" } });
      outcome = "capture denied: marked for review";
    } else {
      outcome = `capture denied: order already ${order.status}`;
    }
  } else {
    const result = await finalizeOrder(paypalOrderId, deps);
    outcome = `finalize → ${result.result}`;
  }
  await insertAuditLog({ orderId: order.id, step: "webhook", outcome, detail: { eventId: event.id, eventType: event.event_type } }).catch(
    () => undefined,
  );
  return outcome;
}
