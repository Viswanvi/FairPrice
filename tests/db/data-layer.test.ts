import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAuditLog } from "@/lib/db/audit-log";
import { prisma } from "@/lib/db/client";
import { contentHash } from "@/lib/db/hash";
import {
  approveTable,
  createDraftTable,
  getApprovedTable,
  getPriceTable,
  PriceTableError,
  updateDraftRows,
} from "@/lib/db/price-tables";
import { listProductOrders } from "@/lib/db/orders";
import { recordWebhookEvent } from "@/lib/db/webhook-events";

// Every row created here uses this prefix and is deleted in afterAll.
const RUN = `itest-${Date.now().toString(36)}`;
const sellerId = `${RUN}-seller`;
const productId = `${RUN}-product`;

const rowsV1 = [
  { country: "IN", priceCents: 3500, discountPct: 65, relevance: "high", reason: "Large developer audience.", flags: [] },
  { country: "US", priceCents: 9900, discountPct: 0, relevance: "high", reason: "Base market.", flags: [] },
];
const rowsV2 = rowsV1.map((r) => (r.country === "IN" ? { ...r, priceCents: 3000 } : r));
const formulaRows = [
  { country: "IN", priceCents: 2900, discountPct: 71 },
  { country: "US", priceCents: 9900, discountPct: 0 },
];

beforeAll(async () => {
  await prisma.seller.create({ data: { id: sellerId, name: "Integration test seller" } });
  await prisma.product.create({
    data: {
      id: productId,
      sellerId,
      title: "Integration test product",
      baseCents: 9900,
      minCents: 1500,
      maxDiscountPct: 70,
      goal: "reach",
    },
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { productId: { startsWith: RUN } } });
  await prisma.priceTable.deleteMany({ where: { productId: `${RUN}-other` } });
  await prisma.product.deleteMany({ where: { id: `${RUN}-other` } });
  await prisma.auditLog.deleteMany({ where: { orderId: { startsWith: RUN } } });
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
  await prisma.priceTable.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.seller.deleteMany({ where: { id: sellerId } });
  await prisma.$disconnect();
});

describe("price tables", () => {
  let v1Id = "";
  let v2Id = "";

  it("creates drafts with increasing version numbers and a content hash", async () => {
    const v1 = await createDraftTable({ productId, rows: rowsV1, formulaRows });
    const v2 = await createDraftTable({ productId, rows: rowsV2, formulaRows });
    v1Id = v1.id;
    v2Id = v2.id;
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.status).toBe("draft");
    expect(v1.contentHash).toBe(contentHash(rowsV1));
    expect(v2.contentHash).not.toBe(v1.contentHash);
    expect(await getApprovedTable(productId)).toBeNull();
  });

  it("approves a draft and returns it as the approved table", async () => {
    const approved = await approveTable(v1Id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeInstanceOf(Date);
    const current = await getApprovedTable(productId);
    expect(current?.version).toBe(1);
    expect(current?.rows.find((r) => r.country === "IN")?.priceCents).toBe(3500);
  });

  it("approving a new version supersedes the previously approved one", async () => {
    const approved = await approveTable(v2Id);
    expect(approved.version).toBe(2);
    expect(approved.contentHash).toBe(contentHash(rowsV2));
    expect((await getPriceTable(v1Id))?.status).toBe("superseded");
    expect((await getApprovedTable(productId))?.version).toBe(2);
    const approvedCount = await prisma.priceTable.count({ where: { productId, status: "approved" } });
    expect(approvedCount).toBe(1);
  });

  it("re-approving the approved version is a no-op", async () => {
    const before = await getPriceTable(v2Id);
    const again = await approveTable(v2Id);
    expect(again.approvedAt?.getTime()).toBe(before?.approvedAt?.getTime());
  });

  it("refuses to approve a superseded version", async () => {
    await expect(approveTable(v1Id)).rejects.toThrow(PriceTableError);
  });

  it("allocates distinct versions under concurrent draft creation", async () => {
    const created = await Promise.all(
      [1, 2, 3].map(() => createDraftTable({ productId, rows: rowsV1, formulaRows })),
    );
    expect(created.map((t) => t.version).sort()).toEqual([3, 4, 5]);
  });

  it("rejects rows with fractional cents or duplicate countries", async () => {
    await expect(
      createDraftTable({ productId, rows: [{ ...rowsV1[0], priceCents: 34.5 }], formulaRows }),
    ).rejects.toThrow();
    await expect(
      createDraftTable({ productId, rows: [rowsV1[0], rowsV1[0]], formulaRows }),
    ).rejects.toThrow();
  });

  it("edits a draft row and recomputes the hash", async () => {
    const draft = await createDraftTable({ productId, rows: rowsV1, formulaRows });
    const edited = await updateDraftRows(draft.id, (rows) =>
      rows.map((r) => (r.country === "IN" ? { ...r, priceCents: 3900, flags: ["seller_edited"] } : r)),
    );
    expect(edited.rows.find((r) => r.country === "IN")?.priceCents).toBe(3900);
    expect(edited.contentHash).toBe(contentHash(edited.rows));
    expect(edited.contentHash).not.toBe(draft.contentHash);
  });

  it("keeps both of two concurrent edits to different rows", async () => {
    const draft = await createDraftTable({ productId, rows: rowsV1, formulaRows });
    await Promise.all([
      updateDraftRows(draft.id, (rows) => rows.map((r) => (r.country === "IN" ? { ...r, priceCents: 4100 } : r))),
      updateDraftRows(draft.id, (rows) => rows.map((r) => (r.country === "US" ? { ...r, priceCents: 9500 } : r))),
    ]);
    const after = await getPriceTable(draft.id);
    expect(after?.rows.map((r) => [r.country, r.priceCents])).toEqual([
      ["IN", 4100],
      ["US", 9500],
    ]);
  });

  it("rolls back when the transform throws, and refuses non-drafts", async () => {
    const draft = await createDraftTable({ productId, rows: rowsV1, formulaRows });
    await expect(
      updateDraftRows(draft.id, () => {
        throw new Error("rejected by validator");
      }),
    ).rejects.toThrow("rejected by validator");
    expect((await getPriceTable(draft.id))?.contentHash).toBe(draft.contentHash);

    await expect(updateDraftRows(v2Id, (rows) => rows)).rejects.toMatchObject({ code: "not_draft" });
  });

  it("refuses a draft for a product that doesn't exist", async () => {
    await expect(
      createDraftTable({ productId: `${RUN}-missing`, rows: rowsV1, formulaRows }),
    ).rejects.toThrow(PriceTableError);
  });
});

describe("orders dashboard query", () => {
  it("lists a product's orders newest first, with the table version and hash that priced them", async () => {
    const table = await getApprovedTable(productId);
    expect(table).not.toBeNull();
    const base = { productId, priceTableId: table!.id, shownCents: 3500 };
    await prisma.order.create({
      data: { ...base, id: `${RUN}-o1`, status: "CAPTURED", decision: "MATCH", shownCountry: "IN", payerCountry: "IN", chargedCents: 3500, createdAt: new Date(Date.now() - 60_000) },
    });
    await prisma.order.create({
      data: { ...base, id: `${RUN}-o2`, status: "VOIDED", decision: "MISMATCH", shownCountry: "IN", payerCountry: "US", offerCents: 9900 },
    });

    // An order on another product must not appear.
    await prisma.product.create({
      data: { id: `${RUN}-other`, sellerId, title: "Other", baseCents: 9900, minCents: 1500, maxDiscountPct: 70, goal: "reach" },
    });
    const other = await createDraftTable({ productId: `${RUN}-other`, rows: rowsV1, formulaRows });
    await prisma.order.create({ data: { id: `${RUN}-o3`, productId: `${RUN}-other`, priceTableId: other.id, shownCents: 9900 } });

    const orders = await listProductOrders(productId);
    expect(orders.map((o) => o.id)).toEqual([`${RUN}-o2`, `${RUN}-o1`]);
    expect(orders[0]).toMatchObject({
      decision: "MISMATCH",
      payerCountry: "US",
      offerCents: 9900,
      tableVersion: table!.version,
      tableHash: table!.contentHash,
    });
    expect(typeof orders[0].createdAt).toBe("string");
  });
});

describe("webhook events", () => {
  const payload = {
    id: `${RUN}-evt-1`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAPTURE123", payer: { email_address: "buyer@example.com", name: { given_name: "Asha" } } },
  };

  it("stores an event once and reports duplicates", async () => {
    const event = {
      eventId: `${RUN}-evt-1`,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: "CAPTURE123",
      verified: true,
      payload,
    };
    expect(await recordWebhookEvent(event)).toBe(true);
    expect(await recordWebhookEvent(event)).toBe(false);
    expect(await prisma.webhookEvent.count({ where: { eventId: event.eventId } })).toBe(1);
  });

  it("stores the payload without names or emails", async () => {
    const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: `${RUN}-evt-1` } });
    const text = JSON.stringify(stored.payload);
    expect(text).not.toContain("buyer@example.com");
    expect(text).not.toContain("Asha");
    expect(text).toContain("CAPTURE123");
  });
});

describe("audit log", () => {
  it("writes an entry with sanitized detail", async () => {
    await insertAuditLog({
      orderId: `${RUN}-order`,
      step: "capture",
      requestId: `${RUN}-order:capture`,
      outcome: "COMPLETED",
      detail: { captureId: "CAP1", payer: { email_address: "buyer@example.com" } },
    });
    const rows = await prisma.auditLog.findMany({ where: { orderId: `${RUN}-order` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(`${RUN}-order:capture`);
    expect(JSON.stringify(rows[0].detail)).not.toContain("buyer@example.com");
  });
});
