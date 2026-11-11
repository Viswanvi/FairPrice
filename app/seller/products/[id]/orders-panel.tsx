"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, cx, ErrorNote, Switch } from "../../../_components/ui";
import type { OrderView } from "@/lib/db/orders";
import { DECISION_INFO, DECISIONS, summarizeOrders } from "@/lib/seller/orders";
import { formatUsd } from "@/lib/seller/format";
import type { DecisionFilter } from "./orders-grid";

const OrdersGrid = dynamic(() => import("./orders-grid").then((m) => m.OrdersGrid), {
  ssr: false,
  loading: () => <div className="h-[560px] animate-pulse rounded-xl bg-surface-2" />,
});

const REFRESH_MS = 5000;
const NEW_HIGHLIGHT_MS = 4000;

export function OrdersPanel({
  productId,
  initialOrders,
  pageUrl,
}: {
  productId: string;
  initialOrders: OrderView[];
  pageUrl: string;
}) {
  const [orders, setOrders] = useState(initialOrders);
  const [filter, setFilter] = useState<DecisionFilter>("all");
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  const known = useRef(new Set(initialOrders.map((o) => o.id)));

  // Refresh every 5 s while the tab is visible and live updates are on.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/products/${productId}/orders`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { orders?: OrderView[]; message?: string } | null;
        if (cancelled) return;
        if (!res.ok || !body?.orders) {
          setError(body?.message ?? "Couldn't refresh orders. Retrying…");
          return;
        }
        const fresh = body.orders.filter((o) => !known.current.has(o.id)).map((o) => o.id);
        fresh.forEach((id) => known.current.add(id));
        setOrders(body.orders);
        setError(null);
        setLastUpdated(Date.now());
        if (fresh.length) {
          setNewIds(new Set(fresh));
          setTimeout(() => !cancelled && setNewIds(new Set()), NEW_HIGHLIGHT_MS);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach the server. Retrying…");
      }
    };
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, productId]);

  // A 1-second clock for "updated Xs ago" and relative times.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const summary = useMemo(() => summarizeOrders(orders), [orders]);
  const secondsAgo = Math.max(0, Math.round((now - lastUpdated) / 1000));

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Orders</h2>
          <p className="mt-1 text-sm text-ink-2">
            {summary.total === 0
              ? "Every checkout appears here with PayPal's decision and IDs."
              : `${summary.total} order${summary.total === 1 ? "" : "s"} · ${formatUsd(summary.capturedCents)} captured from ${summary.captured} · ${summary.notCharged} not charged` +
                (summary.needsReview ? ` · ${summary.needsReview} need review` : "") +
                (summary.inProgress ? ` · ${summary.inProgress} in progress` : "")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-3 tabular-nums" aria-live="polite">
            {live ? `Updated ${secondsAgo < 2 ? "just now" : `${secondsAgo}s ago`}` : "Paused"}
          </span>
          <div className="w-40">
            <Switch id="live" checked={live} onChange={setLive} label="Live updates" />
          </div>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {summary.total === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-6 text-sm">
          <p className="text-ink">No orders yet.</p>
          <p className="text-ink-2">
            Share your product page; each purchase appears here within seconds, with its PayPal IDs and the price table
            version that priced it.
          </p>
          <code className="mt-1 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">{pageUrl}</code>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by decision">
            {(["all", ...DECISIONS] as DecisionFilter[]).map((d) => {
              const count = d === "all" ? summary.total : summary.byDecision[d];
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={filter === d}
                  onClick={() => setFilter(d)}
                  className={cx(
                    "h-7 rounded-full px-3 text-xs font-medium transition-colors",
                    filter === d ? "bg-ink text-bg" : "bg-surface-2 text-ink-2 hover:text-ink",
                  )}
                >
                  {d === "all" ? "All" : DECISION_INFO[d].label} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
          <OrdersGrid orders={orders} filter={filter} now={now} newIds={newIds} />
        </>
      )}
    </Card>
  );
}
