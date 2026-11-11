import type { Order, OrderDecision, OrderStatus, Prisma } from "@prisma/client";
import { insertAuditLog, type AuditEntry } from "@/lib/db/audit-log";
import { prisma } from "@/lib/db/client";
import { priceRowsSchema } from "@/lib/db/types";
import { decide, type Decision } from "@/lib/eligibility/decide";
import { HttpError } from "@/lib/http";
import type { PayPalClient } from "@/lib/paypal/client";
import { PayPalError, PayPalResponseError } from "@/lib/paypal/errors";
import { resultFromOrder, type CheckoutResult } from "./messages";

/**
 * The ONE idempotent path that finishes a checkout (docs/SPEC.md sections 6 and 9). Called by the
 * browser after approval and by webhooks.
 *
 * Inside a transaction the order row is locked (SELECT … FOR UPDATE), so concurrent calls run one
 * at a time; a call on a finished order returns the stored result with no PayPal calls.
 *
 *   authorize (<orderId>:authorize) → read payer country → decide() on the stored table version →
 *   capture (<orderId>:capture, ≤ authorized, retried on 5xx/network, else NEEDS_REVIEW)
 *   or void (<orderId>:void).
 *
 * Capture happens ONLY when decide() returns CAPTURE (CLAUDE.md rule 3), and only for an amount
 * ≤ the authorized amount (checked again here). If decide() throws, the order is voided.
 */

export type FinalizePayPal = Pick<PayPalClient, "authorizeOrder" | "captureAuthorization" | "voidAuthorization">;

export interface FinalizeDeps {
  paypal: FinalizePayPal;
  /** Injected so tests don't wait for real retry delays. */
  sleep?: (ms: number) => Promise<void>;
}

/** Delays before capture/void retries 1–3 (so up to 4 attempts in total). */
export const RETRY_DELAYS_MS = [500, 1000, 2000];

const FINAL: ReadonlySet<OrderStatus> = new Set(["CAPTURED", "VOIDED", "DECLINED", "NEEDS_REVIEW"]);
const NOT_YET_APPROVED = new Set(["ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"]);
/**
 * PayPal issues that mean the PAYMENT was refused (a final DECLINED). Any other non-retryable
 * error (a 400/415, an unexpected 422…) is treated as our problem, not the buyer's: the order is
 * left open and the caller gets an error, so it can be retried once fixed.
 */
const PAYMENT_REFUSED = new Set([
  "INSTRUMENT_DECLINED",
  "PAYER_CANNOT_PAY",
  "TRANSACTION_REFUSED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "COMPLIANCE_VIOLATION",
  "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
  "CARD_EXPIRED",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorOutcome(error: unknown): { outcome: string; detail: Record<string, unknown> | undefined } {
  if (error instanceof PayPalError) {
    return {
      outcome: `ERROR ${error.issue ?? error.paypalName}`,
      detail: { status: error.status, name: error.paypalName, issue: error.issue, debugId: error.debugId },
    };
  }
  return { outcome: `ERROR ${error instanceof Error ? error.name : "unknown"}`, detail: undefined };
}

export async function finalizeOrder(paypalOrderId: string, deps: FinalizeDeps): Promise<CheckoutResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const found = await prisma.order.findUnique({ where: { paypalOrderId }, select: { id: true } });
  if (!found) throw new HttpError(404, "not_found", "We couldn't find this checkout, so nothing was charged.");
  const orderId = found.id;
  // Audit rows are written outside the transaction so they survive a rollback.
  const audit = (entry: Omit<AuditEntry, "orderId">) => insertAuditLog({ orderId, ...entry }).catch(() => undefined);

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { product: true, priceTable: true },
      });
      if (FINAL.has(order.status)) return resultFromOrder(order);

      const save = async (data: Prisma.OrderUpdateInput): Promise<Order> =>
        tx.order.update({ where: { id: orderId }, data });

      // ---------- 1. Authorize ----------
      const authRequestId = `${orderId}:authorize`;
      let authorized: Awaited<ReturnType<FinalizePayPal["authorizeOrder"]>>;
      try {
        authorized = await deps.paypal.authorizeOrder(paypalOrderId, authRequestId);
      } catch (error) {
        await audit({ step: "authorize", requestId: authRequestId, ...errorOutcome(error) });
        if (error instanceof PayPalError) {
          if (error.status === 422 && error.issue && NOT_YET_APPROVED.has(error.issue)) return resultFromOrder(order);
          if (error.issue && PAYMENT_REFUSED.has(error.issue)) return resultFromOrder(await save({ status: "DECLINED" }));
          if (error.retryable) {
            throw new HttpError(503, "paypal_unavailable", "PayPal didn't respond. Please try again in a moment. You have not been charged.");
          }
          throw new HttpError(502, "paypal_rejected", "PayPal couldn't process this request. You have not been charged.");
        }
        if (error instanceof PayPalResponseError) {
          throw new HttpError(502, "paypal_unexpected", "PayPal sent an unexpected answer. You have not been charged.");
        }
        throw error;
      }

      const auth = authorized.authorization;
      const payer = authorized.payer;
      await audit({
        step: "authorize",
        requestId: authRequestId,
        outcome: auth.status,
        detail: { authorizationId: auth.id, amountCents: auth.amountCents, payerCountry: payer.country, paymentType: payer.paymentType },
      });
      const known = { authorizationId: auth.id, payerCountry: payer.country, paymentType: payer.paymentType };
      if (auth.status !== "CREATED") {
        return resultFromOrder(await save({ ...known, status: auth.status === "DENIED" ? "DECLINED" : "NEEDS_REVIEW" }));
      }

      // ---------- 2. Decide (pure) ----------
      const authorizedCents = auth.amountCents;
      let decision: Decision;
      let decideError: string | null = null;
      try {
        decision = decide({
          authorizedCents,
          payerCountry: payer.country,
          paidWithPayPalAccount: payer.paidWithPayPalAccount,
          table: { version: order.priceTable.version, rows: priceRowsSchema.parse(order.priceTable.rows) },
          standardCents: order.product.baseCents,
          requirePayPalForFairPrice: order.product.requirePaypal,
        });
      } catch (error) {
        // Never capture on an impossible input: void and offer the standard price.
        decideError = error instanceof Error ? error.message : "decide failed";
        decision = { action: "VOID", reason: "UNCLEAR", offerCents: order.product.baseCents };
      }

      // Defence in depth: decide() never returns more than authorized, but check before money moves.
      const captureCents =
        decision.action === "CAPTURE" && decision.amountCents > 0 && decision.amountCents <= authorizedCents
          ? decision.amountCents
          : null;
      const reason: OrderDecision = decision.reason;
      await audit({
        step: "decide",
        outcome: `${captureCents !== null ? "CAPTURE" : "VOID"} ${reason}`,
        detail: { authorizedCents, payerCountry: payer.country, tableVersion: order.priceTable.version, decision, error: decideError },
      });

      // ---------- 3a. Capture (≤ authorized) ----------
      if (captureCents !== null) {
        const requestId = `${orderId}:capture`;
        for (let attempt = 1; ; attempt++) {
          try {
            const capture = await deps.paypal.captureAuthorization(auth.id, {
              amountCents: captureCents,
              invoiceId: `fp-${orderId}`,
              requestId,
            });
            await audit({
              step: "capture",
              requestId,
              outcome: capture.status,
              detail: { captureId: capture.id, amountCents: capture.amountCents, feeCents: capture.feeCents, netCents: capture.netCents, attempt },
            });
            const ok = capture.status === "COMPLETED" && capture.amountCents === captureCents;
            return resultFromOrder(
              await save({
                ...known,
                decision: reason,
                eligibleCents: captureCents,
                captureId: capture.id,
                chargedCents: capture.amountCents,
                offerCents: null,
                status: ok ? "CAPTURED" : "NEEDS_REVIEW",
              }),
            );
          } catch (error) {
            await audit({ step: "capture", requestId, ...errorOutcome(error) });
            if (error instanceof PayPalError && error.retryable && attempt <= RETRY_DELAYS_MS.length) {
              await sleep(RETRY_DELAYS_MS[attempt - 1]);
              continue;
            }
            if (!(error instanceof PayPalError) && !(error instanceof PayPalResponseError)) throw error;
            return resultFromOrder(await save({ ...known, decision: reason, eligibleCents: captureCents, status: "NEEDS_REVIEW" }));
          }
        }
      }

      // ---------- 3b. Void: the buyer is not charged ----------
      const offerCents = decision.action === "VOID" ? decision.offerCents : order.product.baseCents;
      const requestId = `${orderId}:void`;
      for (let attempt = 1; ; attempt++) {
        try {
          const voided = await deps.paypal.voidAuthorization(auth.id, requestId);
          await audit({ step: "void", requestId, outcome: voided.status, detail: { offerCents, attempt } });
          return resultFromOrder(
            await save({
              ...known,
              decision: reason,
              eligibleCents: offerCents,
              offerCents,
              chargedCents: 0,
              status: voided.status === "VOIDED" ? "VOIDED" : "NEEDS_REVIEW",
            }),
          );
        } catch (error) {
          await audit({ step: "void", requestId, ...errorOutcome(error) });
          if (error instanceof PayPalError && error.retryable && attempt <= RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }
          if (!(error instanceof PayPalError) && !(error instanceof PayPalResponseError)) throw error;
          return resultFromOrder(await save({ ...known, decision: reason, offerCents, status: "NEEDS_REVIEW" }));
        }
      }
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}
