"use client";

import type { ReactNode } from "react";
import { cx } from "../_components/ui";
import { ResultVoice } from "../_components/voice";
import type { CheckoutResult, CheckoutResultCode } from "@/lib/checkout/messages";

/**
 * Buyer result screen (SPEC screen 8). The message text comes from the server (lib/checkout/
 * messages.ts) so the copy rules live in one tested place: it always says whether money moved and
 * never accuses. This component only adds a short title, an icon and the actions passed in.
 */

const TITLES: Record<CheckoutResultCode, { title: string; tone: "ok" | "warn" | "neutral" }> = {
  PAID: { title: "Payment complete", tone: "ok" },
  TRAVELER: { title: "Payment complete", tone: "ok" },
  MISMATCH: { title: "A different price applies", tone: "warn" },
  UNCLEAR: { title: "We couldn't confirm your country", tone: "warn" },
  NOT_PAYPAL: { title: "Card payments pay the standard price", tone: "warn" },
  DECLINED: { title: "Payment not approved", tone: "neutral" },
  REVIEW: { title: "Confirming your payment", tone: "neutral" },
  PENDING: { title: "Waiting for PayPal", tone: "neutral" },
};

export function ResultCard({
  result,
  paypalOrderId,
  children,
}: {
  result: CheckoutResult;
  paypalOrderId: string;
  children?: ReactNode;
}) {
  const { title, tone } = TITLES[result.result];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "flex flex-col gap-4 rounded-xl border p-4",
        tone === "ok" && "border-ok/30 bg-ok-soft",
        tone === "warn" && "border-warn/30 bg-warn-soft",
        tone === "neutral" && "border-line bg-surface-2",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold",
            tone === "ok" ? "bg-ok text-white" : tone === "warn" ? "bg-warn text-white" : "bg-line-strong text-ink",
          )}
        >
          {tone === "ok" ? "✓" : "i"}
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <p className="text-sm leading-relaxed text-ink">{result.message}</p>
          {(result.result === "PAID" || result.result === "TRAVELER") && (
            <p className="text-xs text-ink-3">
              PayPal order <span className="font-mono">{paypalOrderId}</span>
            </p>
          )}
          <ResultVoice result={result} />
        </div>
      </div>
      {children}
    </div>
  );
}
