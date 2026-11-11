"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Card, Chip, cx, ErrorNote, Segmented, WorkingLabel } from "../../../_components/ui";
import { biggestDifferences, countryName, formatUsd, shortHash } from "@/lib/seller/format";
import { callApi } from "./api";
import type { Mode, Relevance, RowState } from "../../../_components/price-grid";
import type { ProductView, RowView, TableView, WarningView } from "./types";

const PriceGrid = dynamic(() => import("../../../_components/price-grid").then((m) => m.PriceGrid), {
  ssr: false,
  loading: () => <div className="h-[620px] animate-pulse rounded-xl bg-surface-2" />,
});

const GENERATE_MESSAGES = [
  "Starting from World Bank price levels for 42 countries…",
  "Adjusting each country for who actually buys your product…",
  "Checking payment-fee floors and your limits…",
  "Picking natural price points and writing reasons…",
  "Checking every price against your limits…",
  "Still working: large tables can take up to a minute…",
];

export function PricesPanel({
  product,
  latest,
  onNeedAnalysis,
}: {
  product: ProductView;
  latest: TableView | null;
  onNeedAnalysis: () => void;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RowState[]>(latest?.rows ?? []);
  const [warnings, setWarnings] = useState<WarningView[]>(latest?.warnings ?? []);
  const [contentHash, setContentHash] = useState(latest?.contentHash ?? "");
  const [mode, setMode] = useState<Mode>("prices");
  const [filter, setFilter] = useState<Relevance>("all");
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approveReasons, setApproveReasons] = useState<{ country: string; message: string }[]>([]);

  const editable = latest?.status === "draft";
  const top = useMemo(
    () => (latest ? biggestDifferences(rows, latest.formulaRows, 5) : []),
    [rows, latest],
  );
  const fallbackCount = rows.filter((r) => r.flags.includes("formula_fallback")).length;
  const editedCount = rows.filter((r) => r.flags.includes("seller_edited")).length;
  const invalidCount = rows.filter((r) => r.error).length;

  async function generate() {
    if (!product.audienceProfile) {
      onNeedAnalysis();
      return;
    }
    setGenerating(true);
    setError(null);
    const res = await callApi(`/api/products/${product.id}/price-tables`, "POST");
    setGenerating(false);
    if (!res.ok) {
      setError(res.data.message ?? "Generating prices didn't finish. Please try again.");
      return;
    }
    router.refresh();
  }

  async function edit(country: string, priceCents: number) {
    if (!latest) return;
    setRows((rs) => rs.map((r) => (r.country === country ? { ...r, pending: true } : r)));
    const res = await callApi<{ row: RowView; warnings: WarningView[]; contentHash: string }>(
      `/api/price-tables/${latest.id}/rows/${country}`,
      "PATCH",
      { priceCents },
    );
    if (res.ok) {
      setRows((rs) => rs.map((r) => (r.country === country ? { ...res.data.row } : r)));
      setWarnings(res.data.warnings);
      setContentHash(res.data.contentHash);
      setApproveReasons((list) => list.filter((x) => x.country !== country));
    } else {
      // Validator messages start with the country code ("IN: …"); the row already says which country.
      const message = (
        res.data.message ?? (res.status === 422 ? "That price breaks one of your limits." : "The price wasn't saved. Please try again.")
      ).replace(/^[A-Z]{2}: /, "");
      setRows((rs) => rs.map((r) => (r.country === country ? { ...r, pending: false, error: `${formatUsd(priceCents)} not saved: ${message}` } : r)));
    }
  }

  async function approve() {
    if (!latest) return;
    setApproving(true);
    setError(null);
    setApproveReasons([]);
    const res = await callApi<{ reasons?: { country: string; message: string }[] }>(
      `/api/price-tables/${latest.id}/approve`,
      "POST",
    );
    setApproving(false);
    if (!res.ok) {
      setError(res.data.message ?? "Approval didn't go through. Please try again.");
      if (Array.isArray(res.data.reasons)) setApproveReasons(res.data.reasons as { country: string; message: string }[]);
      return;
    }
    router.refresh();
  }

  if (!latest) {
    return (
      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Fair prices per country</h2>
        <p className="max-w-2xl text-sm text-ink-2">
          The AI starts from each country&apos;s price level, adjusts for who buys your product, and explains every price in
          one line. Code then checks every number against your limits and payment fees. Takes 30–60 seconds.
        </p>
        {generating ? <WorkingLabel messages={GENERATE_MESSAGES} /> : <div><Button onClick={generate}>Generate fair prices</Button></div>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Version {latest.version}</h2>
              {latest.status === "approved" ? <Chip tone="ok">Approved · live</Chip> : <Chip tone="warn">Draft</Chip>}
            </div>
            <p className="text-sm text-ink-2">
              {rows.length} countries · {fallbackCount ? `${fallbackCount} used the formula · ` : ""}
              {editedCount ? `${editedCount} edited by you · ` : ""}
              {warnings.length ? `${warnings.length} to check · ` : ""}
              fingerprint <span className="font-mono">{shortHash(contentHash)}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={generate} loading={generating}>
              Generate new version
            </Button>
            {latest.status === "draft" && (
              <Button onClick={approve} loading={approving} disabled={invalidCount > 0 || generating}>
                Approve version {latest.version}
              </Button>
            )}
          </div>
        </div>

        {generating && <WorkingLabel messages={GENERATE_MESSAGES} />}
        {error && (
          <ErrorNote>
            {error}
            {approveReasons.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {approveReasons.map((r) => (
                  <li key={r.country}>{r.message}</li>
                ))}
              </ul>
            )}
          </ErrorNote>
        )}
        {latest.status === "approved" && (
          <p className="rounded-lg bg-ok-soft px-4 py-2 text-sm text-ok">
            This version is live and locked. To change prices, generate a new version and approve it.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<Mode>
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { value: "prices", label: "Prices" },
              { value: "compare", label: "Formula vs AI" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by relevance">
            <span className="mr-1 text-sm text-ink-3">Relevance</span>
            {(["all", "high", "medium", "low"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={filter === r}
                onClick={() => setFilter(r)}
                className={cx(
                  "h-7 rounded-full px-3 text-xs font-medium capitalize transition-colors",
                  filter === r ? "bg-ink text-bg" : "bg-surface-2 text-ink-2 hover:text-ink",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {mode === "compare" ? (
          <p className="text-sm text-ink-2">
            A formula discounts every product the same way. Highlighted: the 5 countries where the AI moved furthest from it,
            with its reason.
          </p>
        ) : editable ? (
          <p className="text-sm text-ink-2">Double-click a fair price to change it. Every edit is checked against your limits.</p>
        ) : null}

        <PriceGrid
          rows={rows}
          mode={mode}
          filter={filter}
          editable={editable}
          warnings={warnings}
          topDifferences={top}
          onEdit={edit}
        />
      </Card>

      {warnings.length > 0 && mode === "prices" && (
        <Card className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Worth a second look</h3>
          <p className="text-sm text-ink-2">These prices are allowed, but look out of line with similar countries.</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {warnings.map((w) => (
              <li key={w.country} className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
                <span className="font-medium">{countryName(w.country)}:</span> {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
