import type { Prisma } from "@prisma/client";
import { sanitize } from "../sanitize";
import { prisma, type Db } from "./client";

export interface WebhookEventInput {
  eventId: string;
  eventType: string;
  resourceId?: string | null;
  verified: boolean;
  /** The raw event. Sanitized before storage: no names, emails or addresses. */
  payload: unknown;
}

/**
 * Store a PayPal webhook event once. Returns true if it was new, false if this event ID was
 * already stored (a duplicate delivery — the caller must not act on it again).
 * Uses INSERT ... ON CONFLICT DO NOTHING, so it is safe inside a caller's transaction.
 */
export async function recordWebhookEvent(event: WebhookEventInput, db: Db = prisma): Promise<boolean> {
  const { count } = await db.webhookEvent.createMany({
    data: [
      {
        eventId: event.eventId,
        eventType: event.eventType,
        resourceId: event.resourceId ?? null,
        verified: event.verified,
        payload: (sanitize(event.payload) ?? {}) as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}
