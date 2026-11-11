"use client";

import { AgGridReact } from "ag-grid-react";
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ExternalFilterModule,
  ModuleRegistry,
  RenderApiModule,
  RowApiModule,
  RowStyleModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IRowNode,
  type RowClassRules,
} from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "../../../_components/ui";
import type { OrderView } from "@/lib/db/orders";
import { DECISION_INFO, relativeTime, STATUS_INFO, type Decision } from "@/lib/seller/orders";
import { countryName, formatDateTimeUtc, formatUsd, shortHash } from "@/lib/seller/format";

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  RenderApiModule, // refreshCells (relative times)
  RowApiModule, // redrawRows (new-order highlight)
  TooltipModule,
  RowStyleModule,
  CellStyleModule,
  ExternalFilterModule,
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
]);

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
  fontSize: 13,
  spacing: 7,
  wrapperBorderRadius: 12,
});

export type DecisionFilter = "all" | Decision;
interface Ctx {
  now: number;
}

function TimeCell({ data, context }: ICellRendererParams<OrderView, unknown, Ctx>) {
  if (!data) return null;
  return <span title={formatDateTimeUtc(data.createdAt)}>{relativeTime(data.createdAt, context.now)}</span>;
}

function CountryCell({ value }: ICellRendererParams<OrderView, string | null>) {
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <span className="flex items-baseline gap-1.5 truncate">
      <span className="truncate">{countryName(value)}</span>
      <span className="font-mono text-xs text-ink-3">{value}</span>
    </span>
  );
}

function PayerCell(params: ICellRendererParams<OrderView, string | null>) {
  const { data, value } = params;
  if (!data || !value) return <span className="text-ink-3">Not confirmed</span>;
  const differs = data.shownCountry && data.shownCountry !== value;
  return (
    <span className="flex items-center gap-2 truncate">
      <CountryCell {...params} />
      {differs && <Chip tone="warn">differs</Chip>}
    </span>
  );
}

function ChargedCell({ data }: ICellRendererParams<OrderView>) {
  if (!data) return null;
  if (data.status === "CAPTURED" && data.chargedCents) {
    return <span className="font-semibold tabular-nums">{formatUsd(data.chargedCents)}</span>;
  }
  if (data.status === "VOIDED" || data.status === "DECLINED") {
    return (
      <span className="text-ink-2">
        Not charged
        {data.offerCents ? <span className="text-ink-3"> · offered {formatUsd(data.offerCents)}</span> : null}
      </span>
    );
  }
  return <span className="text-ink-3">—</span>;
}

function DecisionCell({ data }: ICellRendererParams<OrderView>) {
  if (!data) return null;
  if (!data.decision) {
    const s = STATUS_INFO[data.status];
    return <Chip tone={s.tone}>{s.label}</Chip>;
  }
  const d = DECISION_INFO[data.decision];
  return (
    <Chip tone={d.tone} title={d.help}>
      {d.label}
    </Chip>
  );
}

function StatusCell({ data }: ICellRendererParams<OrderView>) {
  if (!data) return null;
  const s = STATUS_INFO[data.status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

function IdCell({ value }: ICellRendererParams<OrderView, string | null>) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="truncate font-mono text-xs">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${value}`}
        title={copied ? "Copied" : "Copy"}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            setCopied(false);
          }
        }}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
      >
        {copied ? (
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 3.5v-.5A1.5 1.5 0 009 1.5H3A1.5 1.5 0 001.5 3v6A1.5 1.5 0 003 10.5h.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
      </button>
    </span>
  );
}

function TableCell({ data }: ICellRendererParams<OrderView>) {
  if (!data) return null;
  return (
    <span className="flex items-baseline gap-1.5" title={data.tableHash}>
      <span className="font-medium">v{data.tableVersion}</span>
      <span className="font-mono text-xs text-ink-3">{shortHash(data.tableHash)}</span>
    </span>
  );
}

export function OrdersGrid({
  orders,
  filter,
  now,
  newIds,
}: {
  orders: OrderView[];
  filter: DecisionFilter;
  now: number;
  newIds: ReadonlySet<string>;
}) {
  const apiRef = useRef<GridApi<OrderView> | null>(null);
  const filterRef = useRef(filter);
  const newIdsRef = useRef(newIds);

  useEffect(() => {
    filterRef.current = filter;
    apiRef.current?.onFilterChanged();
  }, [filter]);

  useEffect(() => {
    apiRef.current?.refreshCells({ columns: ["time"], force: true });
  }, [now]);

  useEffect(() => {
    newIdsRef.current = newIds;
    apiRef.current?.redrawRows();
  }, [newIds]);

  const context = useMemo<Ctx>(() => ({ now }), [now]);

  const columnDefs = useMemo<ColDef<OrderView>[]>(
    () => [
      { headerName: "Time", colId: "time", field: "createdAt", width: 110, sort: "desc", cellRenderer: TimeCell, pinned: "left" },
      { headerName: "Shown country", field: "shownCountry", width: 160, cellRenderer: CountryCell, headerTooltip: "From the visitor's IP address (display only)" },
      { headerName: "Payer country", field: "payerCountry", width: 190, cellRenderer: PayerCell, headerTooltip: "From the buyer's PayPal account" },
      {
        headerName: "Shown price",
        field: "shownCents",
        width: 110,
        type: "rightAligned",
        valueFormatter: (p) => formatUsd(p.value as number),
        cellClass: "tabular-nums",
      },
      { headerName: "Charged", colId: "charged", field: "chargedCents", width: 190, cellRenderer: ChargedCell },
      {
        headerName: "Decision",
        field: "decision",
        width: 160,
        cellRenderer: DecisionCell,
        tooltip: (p) => (p.data?.decision ? DECISION_INFO[p.data.decision].help : undefined),
      },
      { headerName: "Status", field: "status", width: 130, cellRenderer: StatusCell },
      { headerName: "PayPal order", field: "paypalOrderId", width: 205, cellRenderer: IdCell, sortable: false },
      { headerName: "Authorization", field: "authorizationId", width: 205, cellRenderer: IdCell, sortable: false },
      { headerName: "Capture", field: "captureId", width: 205, cellRenderer: IdCell, sortable: false },
      { headerName: "Price table", colId: "table", field: "tableVersion", width: 150, cellRenderer: TableCell },
    ],
    [],
  );

  const rowClassRules = useMemo<RowClassRules<OrderView>>(
    () => ({ "row-new": (p) => Boolean(p.data && newIdsRef.current.has(p.data.id)) }),
    [],
  );

  return (
    <div className="fp-grid h-[560px] w-full">
      <AgGridReact<OrderView>
        theme={gridTheme}
        rowData={orders}
        columnDefs={columnDefs}
        context={context}
        defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
        getRowId={(p) => p.data.id}
        rowHeight={44}
        headerHeight={40}
        tooltipShowDelay={250}
        rowClassRules={rowClassRules}
        isExternalFilterPresent={() => filterRef.current !== "all"}
        doesExternalFilterPass={(node: IRowNode<OrderView>) => node.data?.decision === filterRef.current}
        onGridReady={(e) => {
          apiRef.current = e.api;
        }}
        overlayNoRowsTemplate="No orders with this decision yet."
      />
    </div>
  );
}
