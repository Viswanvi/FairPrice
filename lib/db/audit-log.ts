import type { Prisma } from "@prisma/client";
import { sanitize } from "../sanitize";
import { prisma, type Db } from "./client";

/** Steps written to audit_log (docs/SPEC.md section 8). */
export type AuditStep = "create" | "authorize" | "decide" | "capture" | "void" | "webhook";

export interface AuditEntry {
  orderId?: string | null;
  step: AuditStep;
  /** The PayPal-Request-Id used, if any. */
  requestId?: string | null;
  outcome: string;
  /** Any extra context. Sanitized before storage: no names, emails or addresses. */
  detail?: unknown;
}

export async function insertAuditLog(entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      orderId: entry.orderId ?? null,
      step: entry.step,
      requestId: entry.requestId ?? null,
      outcome: entry.outcome,
      detail: entry.detail == null ? undefined : (sanitize(entry.detail) as Prisma.InputJsonValue),
    },
  });
}
