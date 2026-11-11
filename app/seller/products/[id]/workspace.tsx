"use client";

import Link from "next/link";
import { useState } from "react";
import { cx } from "../../../_components/ui";
import { formatUsd } from "@/lib/seller/format";
import type { OrderView } from "@/lib/db/orders";
import { AudiencePanel } from "./audience-panel";
import { OrdersPanel } from "./orders-panel";
import { PricesPanel } from "./prices-panel";
import { PublishPanel } from "./publish-panel";
import type { LiveView, ProductView, TableView } from "./types";

type Step = "audience" | "prices" | "publish" | "orders";

function initialStep(product: ProductView, latest: TableView | null): Step {
  if (!product.audienceProfile) return "audience";
  if (latest?.status === "approved") return "publish";
  return "prices";
}

export function Workspace({
  product,
  latest,
  live,
  pageUrl,
  orders,
}: {
  product: ProductView;
  latest: TableView | null;
  live: LiveView | null;
  pageUrl: string;
  orders: OrderView[];
}) {
  const [step, setStep] = useState<Step>(() => initialStep(product, latest));

  // When the server data changes (new version generated, version approved), move to the
  // matching step. Adjusting state during render is React's pattern for prop-driven resets.
  const tableKey = latest ? `${latest.id}:${latest.status}` : "none";
  const [seenKey, setSeenKey] = useState(tableKey);
  if (tableKey !== seenKey) {
    setSeenKey(tableKey);
    setStep(latest?.status === "approved" ? "publish" : "prices");
  }

  const steps: { id: Step; label: string; done: boolean; enabled: boolean }[] = [
    { id: "audience", label: "Audience", done: Boolean(product.audienceProfile), enabled: true },
    { id: "prices", label: "Prices", done: Boolean(live), enabled: Boolean(product.audienceProfile) },
    { id: "publish", label: "Publish", done: Boolean(live), enabled: Boolean(live) },
    { id: "orders", label: "Orders", done: false, enabled: true },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href="/seller" className="text-sm text-ink-2 hover:text-ink">
          ← Products
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{product.title}</h1>
            <p className="mt-1 text-sm text-ink-2">
              Base {formatUsd(product.baseCents)} · minimum {formatUsd(product.minCents)} · up to {product.maxDiscountPct}% off ·{" "}
              {product.goal === "reach" ? "maximize reach" : "maximize revenue"} ·{" "}
              {product.requirePaypal ? "fair prices need PayPal" : "fair prices for any payment"}
            </p>
          </div>
        </div>
      </div>

      <nav
        aria-label="Steps"
        className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 [scrollbar-width:none]"
      >
        <span className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-ink-3">
          <StepDot n={1} done />
          Setup
        </span>
        {steps.map((s, i) => (
          <button
            key={s.id}
            type="button"
            disabled={!s.enabled}
            aria-current={step === s.id ? "step" : undefined}
            onClick={() => setStep(s.id)}
            className={cx(
              "flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
              step === s.id ? "bg-accent-soft text-accent-strong" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            <StepDot n={i + 2} done={s.done} />
            {s.label}
          </button>
        ))}
      </nav>

      {step === "audience" && <AudiencePanel product={product} onContinue={() => setStep("prices")} />}
      {step === "prices" && (
        <PricesPanel key={tableKey} product={product} latest={latest} onNeedAnalysis={() => setStep("audience")} />
      )}
      {step === "publish" && (
        <PublishPanel product={product} live={live} latest={latest} pageUrl={pageUrl} onBackToPrices={() => setStep("prices")} />
      )}
      {step === "orders" && <OrdersPanel productId={product.id} initialOrders={orders} pageUrl={pageUrl} />}
    </div>
  );
}

function StepDot({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
        done ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
      )}
    >
      {done ? "✓" : n}
    </span>
  );
}
