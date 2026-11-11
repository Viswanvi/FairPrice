import { Prisma, type PriceTable, type PriceTableStatus } from "@prisma/client";
import { prisma, type Db } from "./client";
import { contentHash } from "./hash";
import { formulaRowsSchema, priceRowsSchema, type FormulaRow, type PriceRow } from "./types";

/**
 * Price-table versions (docs/SPEC.md section 8). A product has many versions; at most one is
 * approved. Version allocation and approval lock the product row, so concurrent calls for
 * the same product run one at a time.
 */

export interface StoredPriceTable {
  id: string;
  productId: string;
  version: number;
  status: PriceTableStatus;
  rows: PriceRow[];
  formulaRows: FormulaRow[];
  contentHash: string;
  createdAt: Date;
  approvedAt: Date | null;
}

export type PriceTableErrorCode = "not_found" | "not_draft" | "superseded";

export class PriceTableError extends Error {
  constructor(
    public readonly code: PriceTableErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PriceTableError";
  }
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

function toStored(table: PriceTable): StoredPriceTable {
  return {
    id: table.id,
    productId: table.productId,
    version: table.version,
    status: table.status,
    rows: priceRowsSchema.parse(table.rows),
    formulaRows: formulaRowsSchema.parse(table.formulaRows),
    contentHash: table.contentHash,
    createdAt: table.createdAt,
    approvedAt: table.approvedAt,
  };
}

async function lockProduct(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
  if (locked.length === 0) throw new PriceTableError("not_found", `product ${productId} not found`);
}

/** The single approved version for a product, or null if none has been approved yet. */
export async function getApprovedTable(
  productId: string,
  db: Db = prisma,
): Promise<StoredPriceTable | null> {
  const table = await db.priceTable.findFirst({
    where: { productId, status: "approved" },
    orderBy: { version: "desc" },
  });
  return table ? toStored(table) : null;
}

/** The newest version of any status (draft, approved or superseded), or null. */
export async function getLatestTable(productId: string, db: Db = prisma): Promise<StoredPriceTable | null> {
  const table = await db.priceTable.findFirst({ where: { productId }, orderBy: { version: "desc" } });
  return table ? toStored(table) : null;
}

/** A specific version by ID — e.g. the version stored on an order. */
export async function getPriceTable(id: string, db: Db = prisma): Promise<StoredPriceTable | null> {
  const table = await db.priceTable.findUnique({ where: { id } });
  return table ? toStored(table) : null;
}

/**
 * Store a new DRAFT version (next version number). Rows are shape-checked here; pricing
 * rules (floors, caps) are the validator's job before this is called.
 */
export async function createDraftTable(input: {
  productId: string;
  rows: unknown;
  formulaRows: unknown;
}): Promise<StoredPriceTable> {
  const rows = priceRowsSchema.parse(input.rows);
  const formulaRows = formulaRowsSchema.parse(input.formulaRows);
  return prisma.$transaction(async (tx) => {
    await lockProduct(tx, input.productId);
    const latest = await tx.priceTable.aggregate({
      where: { productId: input.productId },
      _max: { version: true },
    });
    const created = await tx.priceTable.create({
      data: {
        productId: input.productId,
        version: (latest._max.version ?? 0) + 1,
        status: "draft",
        rows: rows as Prisma.InputJsonValue,
        formulaRows: formulaRows as Prisma.InputJsonValue,
        contentHash: contentHash(rows),
      },
    });
    return toStored(created);
  }, TX_OPTIONS);
}

/**
 * Change a DRAFT's rows (e.g. a seller edits one price). The transform runs on the freshly
 * locked rows, so concurrent edits never overwrite each other; throwing from it rolls back.
 * The result is shape-checked and the content hash recomputed.
 */
export async function updateDraftRows(
  id: string,
  transform: (rows: PriceRow[]) => PriceRow[],
): Promise<StoredPriceTable> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.priceTable.findUnique({ where: { id }, select: { productId: true } });
    if (!found) throw new PriceTableError("not_found", `price table ${id} not found`);
    await lockProduct(tx, found.productId);

    const table = await tx.priceTable.findUniqueOrThrow({ where: { id } }); // re-read under lock
    if (table.status !== "draft") {
      throw new PriceTableError("not_draft", `price table v${table.version} is ${table.status}; only drafts can be edited`);
    }
    const rows = priceRowsSchema.parse(transform(priceRowsSchema.parse(table.rows)));
    const updated = await tx.priceTable.update({
      where: { id },
      data: { rows: rows as Prisma.InputJsonValue, contentHash: contentHash(rows) },
    });
    return toStored(updated);
  }, TX_OPTIONS);
}

/**
 * Approve a draft: recompute its hash from the stored rows, mark the currently approved
 * version superseded, and lock this one. Approving an already-approved version returns it
 * unchanged; a superseded version can't be approved again.
 */
export async function approveTable(id: string): Promise<StoredPriceTable> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.priceTable.findUnique({ where: { id }, select: { productId: true } });
    if (!found) throw new PriceTableError("not_found", `price table ${id} not found`);
    await lockProduct(tx, found.productId);

    const table = await tx.priceTable.findUniqueOrThrow({ where: { id } }); // re-read under lock
    if (table.status === "approved") return toStored(table);
    if (table.status === "superseded") {
      throw new PriceTableError("superseded", `price table v${table.version} was superseded and can't be approved again`);
    }

    const rows = priceRowsSchema.parse(table.rows);
    await tx.priceTable.updateMany({
      where: { productId: table.productId, status: "approved" },
      data: { status: "superseded" },
    });
    const approved = await tx.priceTable.update({
      where: { id },
      data: { status: "approved", contentHash: contentHash(rows), approvedAt: new Date() },
    });
    return toStored(approved);
  }, TX_OPTIONS);
}
