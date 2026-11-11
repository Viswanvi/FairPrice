import type { AudienceProfile } from "@/lib/pricing/ai";
import type { GridRow, GridWarning } from "../../../_components/price-grid";

/** Serializable data passed from the workspace server page to its client components. */

export type RowView = GridRow;
export type WarningView = GridWarning;

export interface TableView {
  id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  rows: RowView[];
  formulaRows: { country: string; priceCents: number; discountPct: number }[];
  contentHash: string;
  approvedAt: string | null;
  warnings: WarningView[];
}

export interface ProductView {
  id: string;
  title: string;
  sourceUrl: string | null;
  description: string | null;
  baseCents: number;
  minCents: number;
  maxDiscountPct: number;
  goal: "revenue" | "reach";
  requirePaypal: boolean;
  audienceProfile: AudienceProfile | null;
}

export interface LiveView {
  id: string;
  version: number;
  contentHash: string;
  approvedAt: string | null;
}
