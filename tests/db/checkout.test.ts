import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeOrder, RETRY_DELAYS_MS, type FinalizePayPal } from "@/lib/checkout/finalizeOrder";
import { reserveReoffer } from "@/lib/checkout/reoffer";
import { handleWebhookEvent, handleWebhookRequest } from "@/lib/checkout/webhook";
import { prisma } from "@/lib/db/client";
import { approveTable, createDraftTable } from "@/lib/db/price-tables";
import { HttpError } from "@/lib/http";
import { PayPalError, WebhookConfigError } from "@/lib/paypal/errors";

// Real database, fake PayPal (injected; production passes the real client).
const RUN = `ctest-${Date.now().toString(36)}`;
const sellerId = `${RUN}-seller`;
const productId = `${RUN}-product`;
let tableV1 = "";
let n = 0;

const rows = (inCents: number) => [
  { country: "US", priceCents: 9900, discountPct: 0, relevance: "high", reason: "t", flags: [] },
  { country: "IN", priceCents: inCents, discountPct: 65, relevance: "high", reason: "t", flags: [] },
  { country: "BR", priceCents: 4500, discountPct: 55, relevance: "high", reason: "t", flags: [] },
];

beforeAll(async () => {
  await prisma.seller.create({ data: { id: sellerId, name: "checkout test" } });
  await prisma.product.create({
    data: { id: productId, sellerId, title: "Checkout test", baseCents: 9900, minCents: 1500, maxDiscountPct: 70, goal: "reach", requirePaypal: true },
  });
  const draft = await createDraftTable({ productId, rows: rows(3500), formulaRows: [] });
  tableV1 = (await approveTable(draft.id)).id;
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { productId }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
  await prisma.order.updateMany({ where: { productId }, data: { previousOrderId: null } });
  await prisma.order.deleteMany({ where: { productId } });
  await prisma.priceTable.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.seller.deleteMany({ where: { id: sellerId } });
  await prisma.$disconnect();
});

async function newOrder(shownCountry: string | null, shownCents: number, priceTableId = tableV1) {
  n++;
  return prisma.order.create({
    data: { id: `${RUN}-o${n}`, productId, priceTableId, shownCountry, shownCents, paypalOrderId: `T${RUN.replace(/\W/g, "").toUpperCase()}${n}`, status: "CREATED" },
  });
}

interface FakeOptions {
  payerCountry?: string | null;
  paymentType?: "paypal" | "card";
  authorizedCents: number;
  authorizeErrors?: Error[];
  authStatus?: string;
  captureErrors?: Error[];
  voidErrors?: Error[];
  /** Slow the authorize call, to make concurrent finalize calls overlap. */
  authorizeDelayMs?: number;
}

function fakePayPal(o: FakeOptions) {
  const calls = { authorize: [] as string[], capture: [] as { amountCents: number; requestId: string }[], void: [] as string[] };
  const authorizeErrors = [...(o.authorizeErrors ?? [])];
  const captureErrors = [...(o.captureErrors ?? [])];
  const voidErrors = [...(o.voidErrors ?? [])];
  const paypal: FinalizePayPal = {
    authorizeOrder: async (orderId, requestId) => {
      calls.authorize.push(requestId);
      if (o.authorizeDelayMs) await new Promise((r) => setTimeout(r, o.authorizeDelayMs));
      const err = authorizeErrors.shift();
      if (err) throw err;
      const type = o.paymentType ?? "paypal";
      return {
        id: orderId,
        status: "COMPLETED",
        customId: null,
        invoiceId: null,
        payer: {
          country: o.payerCountry ?? null,
          countrySource: o.payerCountry ? "payer" : null,
          paymentType: type,
          paidWithPayPalAccount: type === "paypal",
          accountStatus: type === "paypal" ? "VERIFIED" : null,
        },
        authorization: { id: `AUTH-${orderId}`, status: o.authStatus ?? "CREATED", amountCents: o.authorizedCents, expirationTime: null },
      };
    },
    captureAuthorization: async (_authId, input) => {
      calls.capture.push({ amountCents: input.amountCents, requestId: input.requestId });
      const err = captureErrors.shift();
      if (err) throw err;
      return { id: `CAP-${calls.capture.length}`, status: "COMPLETED", amountCents: input.amountCents, finalCapture: true, feeCents: null, netCents: null };
    },
    voidAuthorization: async (_authId, requestId) => {
      calls.void.push(requestId);
      const err = voidErrors.shift();
      if (err) throw err;
      return { status: "VOIDED" };
    },
  };
  return { paypal, calls };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const unavailable = () => new PayPalError(503, "SERVICE_UNAVAILABLE", "PayPal 503");
const declined = (issue: string) => new PayPalError(422, "UNPROCESSABLE_ENTITY", `PayPal 422 (${issue})`, "dbg", issue);

describe("finalizeOrder — decisions", () => {
  it("MATCH: India buyer shown $35, payer IN → capture $35", async () => {
    const order = await newOrder("IN", 3500);
    const { paypal, calls } = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    const result = await finalizeOrder(order.paypalOrderId!, { paypal, sleep });
    expect(result).toMatchObject({ result: "PAID", chargedCents: 3500, country: "IN", message: "You paid $35, the fair price for India." });
    expect(calls.capture).toEqual([{ amountCents: 3500, requestId: `${order.id}:capture` }]);
    expect(calls.authorize).toEqual([`${order.id}:authorize`]);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({ status: "CAPTURED", decision: "MATCH", payerCountry: "IN", chargedCents: 3500, eligibleCents: 3500, paymentType: "paypal" });
    expect(row.captureId).toBe("CAP-1");
    const audit = await prisma.auditLog.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    expect(audit.map((a) => [a.step, a.requestId, a.outcome])).toEqual([
      ["authorize", `${order.id}:authorize`, "CREATED"],
      ["decide", null, "CAPTURE MATCH"],
      ["capture", `${order.id}:capture`, "COMPLETED"],
    ]);
  });

  it("TRAVELER: shown $99 (US IP), payer IN → capture only $35", async () => {
    const order = await newOrder("US", 9900);
    const { paypal, calls } = fakePayPal({ payerCountry: "IN", authorizedCents: 9900 });
    const result = await finalizeOrder(order.paypalOrderId!, { paypal, sleep });
    expect(result).toMatchObject({ result: "TRAVELER", chargedCents: 3500, message: "You were charged $35, the fair price for your country, not $99." });
    expect(calls.capture.map((c) => c.amountCents)).toEqual([3500]);
  });

  it("MISMATCH: shown $35 (IN IP), payer US → void, offer $99, never capture", async () => {
    const order = await newOrder("IN", 3500);
    const { paypal, calls } = fakePayPal({ payerCountry: "US", authorizedCents: 3500 });
    const result = await finalizeOrder(order.paypalOrderId!, { paypal, sleep });
    expect(result).toMatchObject({ result: "MISMATCH", chargedCents: 0, offerCents: 9900, canReoffer: true });
    expect(result.message).toBe("Your PayPal account is registered in the United States. The price there is $99. You have not been charged.");
    expect(calls.capture).toEqual([]);
    expect(calls.void).toEqual([`${order.id}:void`]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "VOIDED", decision: "MISMATCH", offerCents: 9900, chargedCents: 0 });
  });

  it("UNCLEAR at a discounted price → void, offer the standard price", async () => {
    const order = await newOrder("IN", 3500);
    const { paypal, calls } = fakePayPal({ payerCountry: null, authorizedCents: 3500 });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal, sleep })).toMatchObject({ result: "UNCLEAR", offerCents: 9900, chargedCents: 0 });
    expect(calls.capture).toEqual([]);
  });

  it("UNCLEAR when the buyer already approved the standard price → capture it (accepted offer)", async () => {
    const order = await newOrder(null, 9900);
    const { paypal, calls } = fakePayPal({ payerCountry: null, authorizedCents: 9900 });
    const result = await finalizeOrder(order.paypalOrderId!, { paypal, sleep });
    expect(result).toMatchObject({ result: "PAID", decision: "UNCLEAR", chargedCents: 9900 });
    expect(calls.capture.map((c) => c.amountCents)).toEqual([9900]);
  });

  it("NOT_PAYPAL: guest card at a fair price → void, offer the standard price", async () => {
    const order = await newOrder("IN", 3500);
    const { paypal, calls } = fakePayPal({ payerCountry: "IN", paymentType: "card", authorizedCents: 3500 });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal, sleep })).toMatchObject({ result: "NOT_PAYPAL", offerCents: 9900 });
    expect(calls.capture).toEqual([]);
  });

  it("uses the table version stored on the order, even after a newer version is approved", async () => {
    const order = await newOrder("IN", 3500, tableV1);
    const v2 = await createDraftTable({ productId, rows: rows(3000), formulaRows: [] });
    await approveTable(v2.id);
    const { paypal, calls } = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal, sleep })).toMatchObject({ result: "PAID", chargedCents: 3500 });
    expect(calls.capture.map((c) => c.amountCents)).toEqual([3500]);
  });
});

describe("finalizeOrder — idempotency and concurrency", () => {
  it("a second call returns the stored result with no PayPal calls", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    const first = await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep });
    const again = fakePayPal({ payerCountry: "US", authorizedCents: 3500 });
    const second = await finalizeOrder(order.paypalOrderId!, { paypal: again.paypal, sleep });
    expect(second).toEqual(first);
    expect(again.calls).toEqual({ authorize: [], capture: [], void: [] });
  });

  it("two concurrent calls make exactly one set of PayPal calls", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, authorizeDelayMs: 400 });
    const [a, b] = await Promise.all([
      finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep }),
      finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep }),
    ]);
    expect(a).toEqual(b);
    expect(fake.calls.authorize).toHaveLength(1);
    expect(fake.calls.capture).toHaveLength(1);
  });

  it("unknown PayPal order → 404", async () => {
    const { paypal } = fakePayPal({ authorizedCents: 1 });
    await expect(finalizeOrder("NOPE123456", { paypal, sleep })).rejects.toMatchObject({ status: 404 });
  });
});

describe("finalizeOrder — PayPal failures", () => {
  it("not yet approved → PENDING, order unchanged, can finish later", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, authorizeErrors: [declined("ORDER_NOT_APPROVED")] });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({ result: "PENDING", chargedCents: 0 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CREATED");
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({ result: "PAID" });
  });

  it("declined authorization → DECLINED, no decision, nothing captured", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ authorizedCents: 3500, authorizeErrors: [declined("INSTRUMENT_DECLINED")] });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({
      result: "DECLINED",
      message: "Your payment wasn't approved. You have not been charged.",
    });
    expect(fake.calls.capture).toEqual([]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "DECLINED", decision: null });
  });

  it("an unexpected non-retryable error (e.g. HTTP 415) is NOT a declined payment: 502, order left open", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({
      payerCountry: "IN",
      authorizedCents: 3500,
      authorizeErrors: [new PayPalError(415, "UNSUPPORTED_MEDIA_TYPE", "PayPal 415")],
    });
    await expect(finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).rejects.toMatchObject({ status: 502, code: "paypal_rejected" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CREATED");
    // Once the problem is gone, the same order finishes normally.
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({ result: "PAID" });
  });

  it("PayPal down during authorize → 503 to the caller, order left as it was (safe to retry)", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ authorizedCents: 3500, authorizeErrors: [unavailable()] });
    const error = await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CREATED");
  });

  it("capture 5xx twice, then success → CAPTURED, same request ID every time", async () => {
    sleeps.length = 0;
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, captureErrors: [unavailable(), unavailable()] });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({ result: "PAID" });
    expect(fake.calls.capture.map((c) => c.requestId)).toEqual(Array(3).fill(`${order.id}:capture`));
    expect(sleeps).toEqual([500, 1000]);
  });

  it("capture fails 4 times (1 + 3 retries) → NEEDS_REVIEW, buyer told no more than the shown price", async () => {
    sleeps.length = 0;
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, captureErrors: Array.from({ length: 4 }, unavailable) });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({
      result: "REVIEW",
      chargedCents: 0,
      message: "We're confirming your payment with PayPal. You won't be charged more than $35.",
    });
    expect(fake.calls.capture).toHaveLength(1 + RETRY_DELAYS_MS.length);
    expect(sleeps).toEqual(RETRY_DELAYS_MS);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("NEEDS_REVIEW");
  });

  it("a non-retryable capture error goes straight to NEEDS_REVIEW", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, captureErrors: [declined("AUTHORIZATION_EXPIRED")] });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({ result: "REVIEW" });
    expect(fake.calls.capture).toHaveLength(1);
  });
});

describe("re-offer", () => {
  it("creates one new order at the stored offer, then the buyer pays it", async () => {
    const original = await newOrder("IN", 3500);
    await finalizeOrder(original.paypalOrderId!, { paypal: fakePayPal({ payerCountry: "US", authorizedCents: 3500 }).paypal, sleep });

    const reserved = await reserveReoffer(original.id);
    expect("order" in reserved).toBe(true);
    if (!("order" in reserved)) return;
    expect(reserved.order).toMatchObject({ shownCents: 9900, shownCountry: "US", previousOrderId: original.id, status: "CREATED" });

    // A second click while the PayPal order is being created → in progress; afterwards → same order.
    await expect(reserveReoffer(original.id)).rejects.toMatchObject({ status: 409, code: "in_progress" });
    const paypalOrderId = `R${RUN.replace(/\W/g, "").toUpperCase()}`;
    await prisma.order.update({ where: { id: reserved.order.id }, data: { paypalOrderId } });
    expect(await reserveReoffer(original.id)).toEqual({ existingPaypalOrderId: paypalOrderId });

    const fake = fakePayPal({ payerCountry: "US", authorizedCents: 9900 });
    expect(await finalizeOrder(paypalOrderId, { paypal: fake.paypal, sleep })).toMatchObject({
      result: "PAID",
      chargedCents: 9900,
      message: "You paid $99, the fair price for the United States.",
    });
  });

  it("refuses orders that have nothing to offer", async () => {
    const paid = await newOrder("IN", 3500);
    await finalizeOrder(paid.paypalOrderId!, { paypal: fakePayPal({ payerCountry: "IN", authorizedCents: 3500 }).paypal, sleep });
    await expect(reserveReoffer(paid.id)).rejects.toMatchObject({ status: 409, code: "no_offer" });
    await expect(reserveReoffer(`${RUN}-missing`)).rejects.toMatchObject({ status: 404 });
  });
});

describe("webhook request — verify first, store once (CLAUDE.md rule 7)", () => {
  const approvedEvent = (id: string, paypalOrderId: string) =>
    JSON.stringify({ id, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: paypalOrderId } });
  const withVerify = (fake: ReturnType<typeof fakePayPal>, verify: () => Promise<boolean>) => ({
    paypal: { ...fake.paypal, verifyWebhookSignature: verify },
    sleep,
  });

  it("invalid signature → 401 with no side effects", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    const eventId = `${RUN}-bad-sig`;
    const res = await handleWebhookRequest(approvedEvent(eventId, order.paypalOrderId!), new Headers(), withVerify(fake, async () => false));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "invalid_signature" });
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
    expect(fake.calls).toEqual({ authorize: [], capture: [], void: [] });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CREATED");
  });

  it("a duplicate delivery is stored once and acted on once", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    const body = approvedEvent(`${RUN}-dup`, order.paypalOrderId!);
    const first = await handleWebhookRequest(body, new Headers(), withVerify(fake, async () => true));
    const second = await handleWebhookRequest(body, new Headers(), withVerify(fake, async () => true));
    expect(await first.json()).toEqual({ received: true, outcome: "finalize → PAID" });
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(fake.calls.authorize).toHaveLength(1);
    expect(fake.calls.capture).toHaveLength(1);
    expect(await prisma.webhookEvent.count({ where: { eventId: `${RUN}-dup` } })).toBe(1);
  });

  it("no PAYPAL_WEBHOOK_ID → 503, nothing stored", async () => {
    const fake = fakePayPal({ authorizedCents: 1 });
    const res = await handleWebhookRequest(
      approvedEvent(`${RUN}-nocfg`, "X"),
      new Headers(),
      withVerify(fake, async () => {
        throw new WebhookConfigError();
      }),
    );
    expect(res.status).toBe(503);
    expect(await prisma.webhookEvent.count({ where: { eventId: `${RUN}-nocfg` } })).toBe(0);
  });

  it("if handling fails, the event is forgotten so PayPal's retry is processed", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, authorizeErrors: [unavailable()] });
    const body = approvedEvent(`${RUN}-retry`, order.paypalOrderId!);
    const failed = await handleWebhookRequest(body, new Headers(), withVerify(fake, async () => true));
    expect(failed.status).toBe(500);
    expect(await prisma.webhookEvent.count({ where: { eventId: `${RUN}-retry` } })).toBe(0);
    const retried = await handleWebhookRequest(body, new Headers(), withVerify(fake, async () => true));
    expect(await retried.json()).toEqual({ received: true, outcome: "finalize → PAID" });
  });
});

describe("SPEC section 6 edge cases (Phase 13 additions)", () => {
  it("webhook arrives while the browser's finalize is running → one set of PayPal calls", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500, authorizeDelayMs: 400 });
    const [browser, webhook] = await Promise.all([
      finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep }),
      handleWebhookEvent({ id: `${RUN}-race`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: order.paypalOrderId } }, { paypal: fake.paypal, sleep }),
    ]);
    expect(browser).toMatchObject({ result: "PAID", chargedCents: 3500 });
    expect(webhook).toBe("finalize → PAID");
    expect(fake.calls.authorize).toHaveLength(1);
    expect(fake.calls.capture).toHaveLength(1);
  });

  it("payer country not in the table → standard price applies (void, offer $99)", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "FR", authorizedCents: 3500 });
    expect(await finalizeOrder(order.paypalOrderId!, { paypal: fake.paypal, sleep })).toMatchObject({
      result: "MISMATCH",
      country: "FR",
      offerCents: 9900,
      chargedCents: 0,
      message: "Your PayPal account is registered in France. The price there is $99. You have not been charged.",
    });
    expect(fake.calls.capture).toEqual([]);
  });
});

describe("webhook handling", () => {
  it("CHECKOUT.ORDER.APPROVED finalizes the order through the same path", async () => {
    const order = await newOrder("IN", 3500);
    const fake = fakePayPal({ payerCountry: "IN", authorizedCents: 3500 });
    const outcome = await handleWebhookEvent(
      { id: `${RUN}-e1`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: order.paypalOrderId } },
      { paypal: fake.paypal, sleep },
    );
    expect(outcome).toBe("finalize → PAID");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CAPTURED");
  });

  it("payment events find the order via supplementary_data and are no-ops once final", async () => {
    const order = await newOrder("IN", 3500);
    await finalizeOrder(order.paypalOrderId!, { paypal: fakePayPal({ payerCountry: "IN", authorizedCents: 3500 }).paypal, sleep });
    const fake = fakePayPal({ authorizedCents: 1 });
    const outcome = await handleWebhookEvent(
      {
        id: `${RUN}-e2`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: "CAP-1", supplementary_data: { related_ids: { order_id: order.paypalOrderId } } },
      },
      { paypal: fake.paypal, sleep },
    );
    expect(outcome).toBe("finalize → PAID");
    expect(fake.calls).toEqual({ authorize: [], capture: [], void: [] });
  });

  it("PAYMENT.CAPTURE.DENIED on a captured order marks it for review", async () => {
    const order = await newOrder("IN", 3500);
    await finalizeOrder(order.paypalOrderId!, { paypal: fakePayPal({ payerCountry: "IN", authorizedCents: 3500 }).paypal, sleep });
    const outcome = await handleWebhookEvent(
      { id: `${RUN}-e3`, event_type: "PAYMENT.CAPTURE.DENIED", resource: { supplementary_data: { related_ids: { order_id: order.paypalOrderId } } } },
      { paypal: fakePayPal({ authorizedCents: 1 }).paypal, sleep },
    );
    expect(outcome).toBe("capture denied: marked for review");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("NEEDS_REVIEW");
  });

  it("unknown orders, missing IDs and other event types are left alone", async () => {
    const { paypal } = fakePayPal({ authorizedCents: 1 });
    expect(await handleWebhookEvent({ id: "x1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "NOPE123456" } }, { paypal, sleep })).toBe(
      "unmatched: unknown order",
    );
    expect(await handleWebhookEvent({ id: "x2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP" } }, { paypal, sleep })).toBe(
      "unmatched: no order ID in the event",
    );
    expect(await handleWebhookEvent({ id: "x3", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} }, { paypal, sleep })).toBe(
      "ignored BILLING.SUBSCRIPTION.CREATED",
    );
  });
});
