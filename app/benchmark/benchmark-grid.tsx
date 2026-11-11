"use client";

import dynamic from "next/dynamic";
import type { GridRow } from "../_components/price-grid";

const PriceGrid = dynamic(() => import("../_components/price-grid").then((m) => m.PriceGrid), {
  ssr: false,
  loading: () => <div className="h-[620px] animate-pulse rounded-xl bg-surface-2" />,
});

/** Read-only Formula vs AI grid (the same component the seller uses), top 5 differences highlighted. */
export function BenchmarkGrid({ rows, top }: { rows: GridRow[]; top: string[] }) {
  return (
    <PriceGrid
      rows={rows}
      mode="compare"
      filter="all"
      editable={false}
      warnings={[]}
      topDifferences={top}
      onEdit={() => undefined}
    />
  );
}
