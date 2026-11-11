"use client";

import {
  INSTANCE_LOADING_STATE,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  usePayPal,
  type OnApproveDataOneTimePayments,
} from "@paypal/react-paypal-js/sdk-v6";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorNote, Spinner } from "../_components/ui";
import type { CheckoutResult } from "@/lib/checkout/messages";
import { publicEnv } from "@/lib/env.public";
import { formatUsd } from "@/lib/seller/format";
import { ResultCard } from "./result-card";

/**
 * PayPal checkout on the buyer page (SDK v6). The browser only ever sends a productId (or a
 * previous order ID for a re-offer) — never an amount. AUTHORIZE intent is set by the server
 * when it creates the order; the v6 browser SDK has no intent/currency settings.
 *
 *   createOrder → POST /api/checkout/orders            → { orderId }
 *   onApprove   → POST /api/checkout/orders/:id/finalize → result screen
 *   re-offer    → POST /api/checkout/reoffer            → fresh PayPal button for the new order
 */

type Phase =
  | { kind: "ready" }
  | { kind: "cancelled" }
  | { kind: "finalizing"; orderId: string }
  | { kind: "result"; orderId: string; result: CheckoutResult }
  | { kind: "error"; message: string; orderId: string | null; retryable?: boolean };

interface ApiResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> & { message?: string };
}

async function post(url: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: ((await res.json().catch(() => ({}))) ?? {}) as ApiResult["data"] };
  } catch {
    return { ok: false, status: 0, data: { message: "We couldn't reach the server. Check your connection. You have not been charged." } };
  }
}

export function CheckoutFlow(props: { productId: string | null; as: string | null; resumeOrderId?: string }) {
  return (
    <PayPalProvider
      clientId={publicEnv.paypalClientId}
      environment={publicEnv.paypalEnvironment}
      components={["paypal-payments"]}
      pageType="checkout"
    >
      <Flow {...props} />
    </PayPalProvider>
  );
}

function Flow({ productId, as, resumeOrderId }: { productId: string | null; as: string | null; resumeOrderId?: string }) {
  const [phase, setPhase] = useState<Phase>(resumeOrderId ? { kind: "finalizing", orderId: resumeOrderId } : { kind: "ready" });
  // A friendly server message from a failed createOrder, shown if the SDK then reports an error.
  const startError = useRef<string | null>(null);

  /** Ask the server to authorize, check the payer country and capture or void. Idempotent. */
  const completeFinalize = useCallback(async (orderId: string) => {
    const res = await post(`/api/checkout/orders/${encodeURIComponent(orderId)}/finalize`);
    if (res.ok) setPhase({ kind: "result", orderId, result: res.data as unknown as CheckoutResult });
    else
      setPhase({
        kind: "error",
        orderId,
        // A missing order won't appear by retrying; network errors, 5xx and 409s might.
        retryable: res.status !== 404 && res.status !== 400,
        message: res.data.message ?? "We couldn't confirm your payment. You have not been charged.",
      });
  }, []);

  const finalize = useCallback(
    async (orderId: string) => {
      setPhase({ kind: "finalizing", orderId });
      await completeFinalize(orderId);
    },
    [completeFinalize],
  );

  // Returning from a full-page PayPal redirect: finish the checkout once.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumeOrderId && !resumed.current) {
      resumed.current = true;
      void completeFinalize(resumeOrderId);
    }
  }, [resumeOrderId, completeFinalize]);

  const startOrder = useCallback(
    async (url: string, body: unknown): Promise<{ orderId: string }> => {
      startError.current = null;
      const res = await post(url, body);
      const orderId = typeof res.data.paypalOrderId === "string" ? res.data.paypalOrderId : null;
      if (!res.ok || !orderId) {
        startError.current = res.data.message ?? "We couldn't start the PayPal checkout. You have not been charged.";
        throw new Error(startError.current);
      }
      return { orderId };
    },
    [],
  );

  const handlers = {
    onApprove: async ({ orderId }: OnApproveDataOneTimePayments) => finalize(orderId),
    onCancel: () => setPhase({ kind: "cancelled" }),
    onError: () =>
      setPhase({
        kind: "error",
        orderId: null,
        message: startError.current ?? "PayPal couldn't complete the payment. You have not been charged.",
      }),
  };

  const buy = () =>
    productId
      ? startOrder(`/api/checkout/orders${as ? `?as=${encodeURIComponent(as)}` : ""}`, { productId })
      : Promise.reject(new Error("No product"));

  if (phase.kind === "finalizing") {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-strong">
        <Spinner />
        <span>
          Confirming your country with PayPal…
          <span className="block text-xs text-ink-2">You won&apos;t be charged more than the price you approved.</span>
        </span>
      </div>
    );
  }

  if (phase.kind === "result") {
    const { result, orderId } = phase;
    const startOver = productId ? (
      <Button variant="secondary" onClick={() => setPhase({ kind: "ready" })}>
        {result.canReoffer ? "Cancel" : "Try again"}
      </Button>
    ) : (
      <Link href={`/p/${result.productId}`} className="text-sm font-medium text-accent-strong underline">
        Back to the product page
      </Link>
    );
    return (
      <ResultCard result={result} paypalOrderId={orderId}>
        {result.canReoffer && result.offerCents && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">Pay {formatUsd(result.offerCents)} with PayPal</p>
            <PayButton createOrder={() => startOrder("/api/checkout/reoffer", { previousOrderId: result.orderId })} {...handlers} />
            {startOver}
          </div>
        )}
        {result.result === "DECLINED" && startOver}
        {result.result === "PENDING" && (
          <Button variant="secondary" onClick={() => void finalize(orderId)}>
            Check again
          </Button>
        )}
      </ResultCard>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {phase.kind === "cancelled" && (
        <p role="status" className="rounded-lg bg-surface-2 px-4 py-2 text-sm text-ink-2">
          Payment cancelled. You have not been charged.
        </p>
      )}
      {phase.kind === "error" && (
        <ErrorNote>
          {phase.message}
          {phase.orderId && phase.retryable && (
            <button type="button" className="ml-2 font-medium underline" onClick={() => void finalize(phase.orderId!)}>
              Try again
            </button>
          )}
        </ErrorNote>
      )}
      {productId && <PayButton createOrder={buy} {...handlers} />}
    </div>
  );
}

/** The official PayPal button (not restyled), with loading and failure states for the SDK. */
function PayButton(props: {
  createOrder: () => Promise<{ orderId: string }>;
  onApprove: (data: OnApproveDataOneTimePayments) => Promise<void>;
  onCancel: () => void;
  onError: () => void;
}) {
  const { loadingStatus, error } = usePayPal();
  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED || error) {
    return (
      <ErrorNote>PayPal couldn&apos;t load. Check your connection and refresh the page. You have not been charged.</ErrorNote>
    );
  }
  if (loadingStatus === INSTANCE_LOADING_STATE.PENDING) {
    return <div aria-label="Loading PayPal" className="h-12 animate-pulse rounded-full bg-surface-2" />;
  }
  return (
    <PayPalOneTimePaymentButton
      type="pay"
      presentationMode="auto"
      createOrder={props.createOrder}
      onApprove={props.onApprove}
      onCancel={props.onCancel}
      onError={props.onError}
    />
  );
}
