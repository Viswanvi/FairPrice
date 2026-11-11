"use client";

import { AgGridReact } from "ag-grid-react";
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ExternalFilterModule,
  ModuleRegistry,
  NumberEditorModule,
  RowStyleModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
  type CellEditRequestEvent,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IRowNode,
  type RowClassRules,
} from "ag-grid-community";
import { useEffect, useMemo, useRef } from "react";
import { Chip, relevanceTone, Spinner } from "./ui";
import { countryName, formatUsd } from "@/lib/seller/format";

/**
 * Price grid shared by the seller workspace (editable prices, Formula vs AI) and the public
 * /benchmark page (read-only Formula vs AI).
 */
export interface GridRow {
  country: string;
  priceCents: number;
  discountPct: number;
  relevance: "high" | "medium" | "low";
  reason: string;
  flags: string[];
  region?: string;
  formulaPriceCents?: number;
  netCents?: number;
}

export interface GridWarning {
  country: string;
  message: string;
}

type RowView = GridRow;
type WarningView = GridWarning;

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  NumberEditorModule,
  TooltipModule,
  RowStyleModule,
  CellStyleModule,
  ExternalFilterModule,
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
]);

/** Grid theme built from the app's CSS variables, so light/dark mode follows the page. */
const gridTheme = themeQuartz.withParams({
  accentColor: "var(--accent)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  borderColor: "var(--line)",
  chromeBackgroundColor: "var(--surface-2)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--ink-2)",
  headerFontWeight: 600,
  rowHoverColor: "var(--surface-2)",
  invalidColor: "var(--danger)",
  fontSize: 13,
  spacing: 7,
  wrapperBorderRadius: 12,
});

export type RowState = RowView & { error?: string; pending?: boolean };
export type Relevance = "all" | "high" | "medium" | "low";
export type Mode = "prices" | "compare";

const RELEVANCE_RANK = { high: 3, medium: 2, low: 1 } as const;

const FLAG_LABELS: Record<string, { label: string; tone: "warn" | "accent" | "neutral" }> = {
  formula_fallback: { label: "Formula fallback", tone: "warn" },
  seller_edited: { label: "Edited", tone: "accent" },
  max_discount: { label: "Max discount", tone: "neutral" },
  min_price: { label: "Your minimum", tone: "neutral" },
  fee_floor: { label: "Fee floor", tone: "neutral" },
  base: { label: "Base price", tone: "neutral" },
  floor_above_base: { label: "Base price", tone: "neutral" },
};

function flagLabel(flag: string) {
  return FLAG_LABELS[flag] ?? { label: flag.replace(/[_-]+/g, " "), tone: "neutral" as const };
}

function CountryCell({ data }: ICellRendererParams<RowState>) {
  if (!data) return null;
  return (
    <span className="flex items-baseline gap-2 truncate">
      <span className="truncate font-medium text-ink">{countryName(data.country)}</span>
      <span className="font-mono text-xs text-ink-3">{data.country}</span>
    </span>
  );
}

function RelevanceCell({ data }: ICellRendererParams<RowState>) {
  return data ? <Chip tone={relevanceTone(data.relevance)}>{data.relevance}</Chip> : null;
}

function PriceCell({ data }: ICellRendererParams<RowState>) {
  if (!data) return null;
  return (
    <span className="flex items-center justify-end gap-2 font-semibold tabular-nums">
      {data.pending && <Spinner className="size-3 text-ink-3" />}
      {formatUsd(data.priceCents)}
    </span>
  );
}

function makeFlagsCell(warnings: Map<string, string>) {
  return function FlagsCell({ data }: ICellRendererParams<RowState>) {
    if (!data) return null;
    const warning = warnings.get(data.country);
    return (
      <span className="flex items-center gap-1 overflow-hidden">
        {warning && (
          <Chip tone="warn" title={warning}>
            Check price
          </Chip>
        )}
        {data.flags.map((f) => {
          const { label, tone } = flagLabel(f);
          return (
            <Chip key={f} tone={tone}>
              {label}
            </Chip>
          );
        })}
      </span>
    );
  };
}

function DiffCell({ data }: ICellRendererParams<RowState>) {
  if (!data || data.formulaPriceCents === undefined) return null;
  const diff = data.priceCents - data.formulaPriceCents;
  const pct = data.formulaPriceCents ? Math.round((diff / data.formulaPriceCents) * 100) : 0;
  if (diff === 0) return <span className="text-ink-3">Same</span>;
  return (
    <span className={diff > 0 ? "font-medium text-warn" : "font-medium text-accent-strong"}>
      {diff > 0 ? "+" : "−"}
      {formatUsd(Math.abs(diff))} ({diff > 0 ? "+" : "−"}
      {Math.abs(pct)}%)
    </span>
  );
}

export function PriceGrid({
  rows,
  mode,
  filter,
  editable,
  warnings,
  topDifferences,
  onEdit,
}: {
  rows: RowState[];
  mode: Mode;
  filter: Relevance;
  editable: boolean;
  warnings: WarningView[];
  topDifferences: string[];
  onEdit: (country: string, priceCents: number) => void;
}) {
  const apiRef = useRef<GridApi<RowState> | null>(null);
  const filterRef = useRef(filter);

  useEffect(() => {
    filterRef.current = filter;
    apiRef.current?.onFilterChanged();
  }, [filter]);

  const warningMap = useMemo(() => new Map(warnings.map((w) => [w.country, w.message])), [warnings]);
  const top = useMemo(() => new Set(topDifferences), [topDifferences]);

  const columnDefs = useMemo<ColDef<RowState>[]>(() => {
    const country: ColDef<RowState> = {
      headerName: "Country",
      field: "country",
      pinned: "left",
      width: 190,
      cellRenderer: CountryCell,
      tooltip: (p) => (p.data ? `${countryName(p.data.country)} · ${p.data.region ?? ""}` : undefined),
      comparator: (a: string, b: string) => countryName(a).localeCompare(countryName(b)),
    };
    const relevance: ColDef<RowState> = {
      headerName: "Relevance",
      field: "relevance",
      width: 120,
      cellRenderer: RelevanceCell,
      comparator: (a: RowState["relevance"], b: RowState["relevance"]) => RELEVANCE_RANK[a] - RELEVANCE_RANK[b],
    };
    const formula: ColDef<RowState> = {
      headerName: "Formula",
      field: "formulaPriceCents",
      width: 110,
      type: "rightAligned",
      valueFormatter: (p) => (p.value == null ? "—" : formatUsd(p.value as number)),
      cellClass: "text-ink-2 tabular-nums",
    };
    const ai: ColDef<RowState> = {
      headerName: mode === "compare" ? "AI price" : "Fair price",
      colId: "price",
      width: 130,
      type: "rightAligned",
      valueGetter: (p) => (p.data ? p.data.priceCents / 100 : null),
      editable: (p) => editable && mode === "prices" && !p.data?.pending,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0, precision: 2, showStepperButtons: false },
      cellRenderer: PriceCell,
      cellClassRules: {
        "cell-invalid": (p) => Boolean(p.data?.error),
        "cell-editable": (p) => editable && mode === "prices" && !p.data?.error,
      },
      tooltip: (p) => p.data?.error ?? (editable && mode === "prices" ? "Double-click to edit this price" : undefined),
    };
    const reason: ColDef<RowState> = {
      headerName: mode === "compare" ? "Why the AI chose this" : "Reason",
      field: "reason",
      flex: 1,
      minWidth: 280,
      tooltip: (p) => p.data?.reason,
      cellClass: "text-ink-2",
    };

    if (mode === "compare") {
      return [
        country,
        relevance,
        formula,
        { ...ai, cellClassRules: undefined, tooltip: undefined },
        {
          headerName: "Difference",
          colId: "diff",
          width: 160,
          valueGetter: (p) => (p.data && p.data.formulaPriceCents !== undefined ? p.data.priceCents - p.data.formulaPriceCents : 0),
          // Ties (common: many countries move by the same amount) are broken the same way as the
          // highlighted top 5: highlighted rows first, then by country code, so they always lead.
          comparator: (a: number, b: number, nodeA: IRowNode<RowState>, nodeB: IRowNode<RowState>) => {
            const bySize = Math.abs(a) - Math.abs(b);
            if (bySize !== 0) return bySize;
            const ca = nodeA.data?.country ?? "";
            const cb = nodeB.data?.country ?? "";
            const byTop = Number(top.has(ca)) - Number(top.has(cb));
            return byTop !== 0 ? byTop : cb.localeCompare(ca);
          },
          sort: "desc",
          cellRenderer: DiffCell,
        },
        reason,
      ];
    }
    return [
      country,
      relevance,
      formula,
      ai,
      {
        headerName: "Discount",
        field: "discountPct",
        width: 105,
        type: "rightAligned",
        valueFormatter: (p) => (p.value ? `−${p.value}%` : "—"),
        cellClass: "tabular-nums",
      },
      {
        headerName: "Net after fees",
        field: "netCents",
        width: 130,
        type: "rightAligned",
        valueFormatter: (p) => (p.value == null ? "—" : formatUsd(p.value as number)),
        cellClass: "text-ink-2 tabular-nums",
        headerTooltip: "Estimated: price minus PayPal's percentage and fixed fees",
      },
      reason,
      { headerName: "Flags", colId: "flags", width: 230, cellRenderer: makeFlagsCell(warningMap), sortable: false },
    ];
  }, [mode, editable, warningMap, top]);

  const rowClassRules = useMemo<RowClassRules<RowState>>(() => {
    const compare: RowClassRules<RowState> = {
      "row-top-diff": (p) => Boolean(p.data && top.has(p.data.country)),
    };
    const prices: RowClassRules<RowState> = {
      "row-fallback": (p) => Boolean(p.data?.flags.includes("formula_fallback")),
      "row-warning": (p) => Boolean(p.data && warningMap.has(p.data.country)),
    };
    return mode === "compare" ? compare : prices;
  }, [mode, top, warningMap]);

  return (
    <div className="fp-grid h-[620px] w-full">
      <AgGridReact<RowState>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
        getRowId={(p) => p.data.country}
        rowHeight={44}
        headerHeight={40}
        readOnlyEdit
        singleClickEdit={false}
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={250}
        rowClassRules={rowClassRules}
        isExternalFilterPresent={() => filterRef.current !== "all"}
        doesExternalFilterPass={(node: IRowNode<RowState>) => node.data?.relevance === filterRef.current}
        onGridReady={(e) => {
          apiRef.current = e.api;
        }}
        onCellEditRequest={(e: CellEditRequestEvent<RowState>) => {
          const value = Number(e.newValue);
          if (!e.data || !Number.isFinite(value)) return;
          onEdit(e.data.country, Math.round(value * 100));
        }}
        overlayNoRowsTemplate="No countries match this filter."
      />
    </div>
  );
}
