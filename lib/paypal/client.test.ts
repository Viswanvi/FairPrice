import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPayPalClient, SANDBOX_API_BASE, type PayPalCallEvent, type PayPalConfig } from "./client";
import { PayPalError, PayPalResponseError, WebhookConfigError } from "./errors";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "paypal", `${name}.json`), "utf8"));

// ---------- fake fetch (test-only; production uses the global fetch) ----------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown } | "network-error";

function fakeFetch(replies: Reply[], tokenTtlSeconds = 32400) {
  const requests: Recorded[] = [];
  let tokenCalls = 0;
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (u.endsWith("/v1/oauth2/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: tokenTtlSeconds }), { status: 200 });
    }
    const raw = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url: u, method: init?.method ?? "GET", headers, body: raw ? JSON.parse(raw) : undefined });
    const reply = replies.shift();
    if (!reply) throw new Error(`fake fetch: no reply queued for ${u}`);
    if (reply === "network-error") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "paypal-debug-id": "dbg-test-1" },
    });
  };
  return { fetch: fn as typeof fetch, requests, tokenCalls: () => tokenCalls };
}

function client(fake: ReturnType<typeof fakeFetch>, extra: Partial<PayPalConfig> = {}) {
  return createPayPalClient({
    apiBase: SANDBOX_API_BASE,
    clientId: "client-id",
    clientSecret: "super-secret-value",
    webhookId: "WH-TEST",
    appBaseUrl: "http://localhost:3000/",
    fetch: fake.fetch,
    ...extra,
  });
}

// ---------- configuration ----------

describe("createPayPalClient", () => {
  it("refuses any API base that isn't the sandbox", () => {
    expect(() => createPayPalClient({ apiBase: "https://api-m.paypal.com", clientId: "a", clientSecret: "b", appBaseUrl: "x" })).toThrow(
      /sandbox-only/,
    );
  });
});

// ---------- orders ----------

describe("createOrder", () => {
  it("sends an AUTHORIZE order with the server's amount, NO_SHIPPING, and the request ID", async () => {
    const fake = fakeFetch([{ status: 201, body: fixture("in-create") }]);
    const created = await client(fake).createOrder({
      amountCents: 3500,
      customId: "demo-bootcamp:3:IN",
      invoiceId: "fp-order-1",
      requestId: "order-1:create",
    });
    expect(created.status).toBe("PAYER_ACTION_REQUIRED");
    expect(created.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);

    const req = fake.requests[0];
    expect(req.url).toBe(`${SANDBOX_API_BASE}/v2/checkout/orders`);
    expect(req.method).toBe("POST");
    expect(req.headers["paypal-request-id"]).toBe("order-1:create");
    expect(req.headers["prefer"]).toBe("return=representation");
    expect(req.headers["authorization"]).toBe("Bearer token-1");
    expect(req.body).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [{ custom_id: "demo-bootcamp:3:IN", invoice_id: "fp-order-1", amount: { currency_code: "USD", value: "35.00" } }],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: "http://localhost:3000/checkout/return",
            cancel_url: "http://localhost:3000/checkout/cancel",
          },
        },
      },
    });
  });

  it("rejects fractional cents and missing request IDs before calling PayPal", async () => {
    const fake = fakeFetch([]);
    const c = client(fake);
    await expect(c.createOrder({ amountCents: 34.5, customId: "c", invoiceId: "i", requestId: "r" })).rejects.toThrow(RangeError);
    await expect(c.createOrder({ amountCents: 3500, customId: "c", invoiceId: "i", requestId: "" })).rejects.toThrow(RangeError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("getOrder / authorizeOrder", () => {
  it("reads an approved order: status and payer country, no authorization yet", async () => {
    const fake = fakeFetch([{ status: 200, body: fixture("in-get-approved") }]);
    const order = await client(fake).getOrder("ORDER-1");
    expect(order).toMatchObject({ status: "APPROVED", customId: "spike-A-IN-buyer", authorization: null });
    expect(fake.requests[0].headers["content-type"]).toBeUndefined();
    expect(order.payer).toMatchObject({ country: "IN", paidWithPayPalAccount: true });
    expect(fake.requests[0]).toMatchObject({ method: "GET", url: `${SANDBOX_API_BASE}/v2/checkout/orders/ORDER-1` });
  });

  it.each([
    ["in-authorize", "IN"],
    ["br-authorize", "BR"],
    ["us-authorize", "US"],
  ])("authorizes (%s): authorization ID, 99.00 → 9900 cents, payer %s", async (name, country) => {
    const fake = fakeFetch([{ status: 201, body: fixture(name) }]);
    const result = await client(fake).authorizeOrder("ORDER-1", "order-1:authorize");
    expect(result.authorization).toMatchObject({ status: "CREATED", amountCents: 9900 });
    expect(result.authorization.id).toMatch(/^[A-Z0-9]+$/);
    expect(result.authorization.expirationTime).toBeTruthy();
    expect(result.payer.country).toBe(country);
    expect(fake.requests[0].headers["paypal-request-id"]).toBe("order-1:authorize");
    // Found by the live smoke test: PayPal answers 415 to a body-less POST without this header.
    expect(fake.requests[0].headers["content-type"]).toBe("application/json");
    expect(fake.requests[0].body).toBeUndefined();
    expect(fake.requests[0].url).toBe(`${SANDBOX_API_BASE}/v2/checkout/orders/ORDER-1/authorize`);
  });

  it("stops with PayPalResponseError when the authorization is missing (never guesses)", async () => {
    const fake = fakeFetch([{ status: 201, body: fixture("in-get-approved") }]);
    await expect(client(fake).authorizeOrder("ORDER-1", "r")).rejects.toBeInstanceOf(PayPalResponseError);
  });
});

// ---------- payments ----------

describe("captureAuthorization", () => {
  it("captures a lower amount with final_capture and returns PayPal's fee and net", async () => {
    const fake = fakeFetch([{ status: 201, body: fixture("in-capture") }]);
    const capture = await client(fake).captureAuthorization("AUTH-1", { amountCents: 3500, invoiceId: "fp-order-1", requestId: "order-1:capture" });
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 3500, finalCapture: true, feeCents: 224, netCents: 3276 });
    expect(fake.requests[0].url).toBe(`${SANDBOX_API_BASE}/v2/payments/authorizations/AUTH-1/capture`);
    expect(fake.requests[0].body).toEqual({ amount: { currency_code: "USD", value: "35.00" }, invoice_id: "fp-order-1", final_capture: true });
    expect(fake.requests[0].headers["paypal-request-id"]).toBe("order-1:capture");
  });

  it("reads the domestic fee for a US buyer", async () => {
    const fake = fakeFetch([{ status: 201, body: fixture("us-capture") }]);
    const capture = await client(fake).captureAuthorization("AUTH-1", { amountCents: 3500, invoiceId: "i", requestId: "r" });
    expect(capture).toMatchObject({ feeCents: 171, netCents: 3329 });
  });
});

describe("voidAuthorization", () => {
  it("returns VOIDED from a 200 body", async () => {
    const fake = fakeFetch([{ status: 200, body: fixture("us-void") }]);
    await expect(client(fake).voidAuthorization("AUTH-1", "order-1:void")).resolves.toEqual({ status: "VOIDED" });
    expect(fake.requests[0].headers["paypal-request-id"]).toBe("order-1:void");
    expect(fake.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("treats 204 No Content as VOIDED", async () => {
    const fake = fakeFetch([{ status: 204 }]);
    await expect(client(fake).voidAuthorization("AUTH-1", "r")).resolves.toEqual({ status: "VOIDED" });
  });
});

// ---------- tokens ----------

describe("access token", () => {
  it("is cached across calls", async () => {
    const fake = fakeFetch([{ status: 204 }, { status: 204 }]);
    const c = client(fake);
    await c.voidAuthorization("A", "r1");
    await c.voidAuthorization("B", "r2");
    expect(fake.tokenCalls()).toBe(1);
  });

  it("is refreshed 60 seconds before it expires", async () => {
    let clock = 1_000_000;
    const fake = fakeFetch([{ status: 204 }, { status: 204 }, { status: 204 }], 3600);
    const c = client(fake, { now: () => clock });
    await c.voidAuthorization("A", "r1");
    clock += (3600 - 61) * 1000;
    await c.voidAuthorization("B", "r2");
    expect(fake.tokenCalls()).toBe(1);
    clock += 2000; // now inside the last 60 s
    await c.voidAuthorization("C", "r3");
    expect(fake.tokenCalls()).toBe(2);
  });

  it("on a 401, refreshes once and retries with the same request ID", async () => {
    const fake = fakeFetch([{ status: 401, body: { name: "AUTHENTICATION_FAILURE" } }, { status: 200, body: fixture("us-void") }]);
    await expect(client(fake).voidAuthorization("AUTH-1", "order-1:void")).resolves.toEqual({ status: "VOIDED" });
    expect(fake.tokenCalls()).toBe(2);
    expect(fake.requests.map((r) => r.headers["paypal-request-id"])).toEqual(["order-1:void", "order-1:void"]);
    expect(fake.requests[1].headers["authorization"]).toBe("Bearer token-2");
  });

  it("gives up after a second 401", async () => {
    const fake = fakeFetch([{ status: 401, body: {} }, { status: 401, body: { name: "AUTHENTICATION_FAILURE" } }]);
    await expect(client(fake).voidAuthorization("A", "r")).rejects.toMatchObject({ status: 401, paypalName: "AUTHENTICATION_FAILURE" });
  });
});

// ---------- errors and audit hook ----------

describe("errors", () => {
  it("maps PayPal error bodies to PayPalError with name, issue and debug_id", async () => {
    const fake = fakeFetch([
      {
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "abc123", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] },
      },
    ]);
    const error = await client(fake)
      .captureAuthorization("A", { amountCents: 3500, invoiceId: "i", requestId: "r" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 422, paypalName: "UNPROCESSABLE_ENTITY", issue: "AUTHORIZATION_ALREADY_CAPTURED", debugId: "abc123", retryable: false });
    expect((error as Error).message).not.toContain("super-secret-value");
  });

  it("marks 5xx and network errors as retryable (for the caller to decide)", async () => {
    const fake = fakeFetch([{ status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, "network-error"]);
    const c = client(fake);
    await expect(c.voidAuthorization("A", "r")).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(c.voidAuthorization("A", "r")).rejects.toMatchObject({ status: 0, paypalName: "NETWORK_ERROR", retryable: true });
  });

  it("does not retry anything except a 401", async () => {
    const fake = fakeFetch([{ status: 500, body: {} }]);
    await expect(client(fake).voidAuthorization("A", "r")).rejects.toBeInstanceOf(PayPalError);
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects a non-USD amount in a response", async () => {
    const body = { ...(fixture("in-capture") as object), amount: { currency_code: "EUR", value: "35.00" } };
    const fake = fakeFetch([{ status: 201, body }]);
    await expect(client(fake).captureAuthorization("A", { amountCents: 3500, invoiceId: "i", requestId: "r" })).rejects.toBeInstanceOf(
      PayPalResponseError,
    );
  });
});

describe("onCall audit hook", () => {
  it("reports each call with step, request ID, status and outcome", async () => {
    const events: PayPalCallEvent[] = [];
    const fake = fakeFetch([{ status: 201, body: fixture("in-authorize") }, { status: 201, body: fixture("in-capture") }, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] } }]);
    const c = client(fake, { onCall: (e) => void events.push(e) });
    await c.authorizeOrder("O", "o:authorize");
    await c.captureAuthorization("A", { amountCents: 3500, invoiceId: "i", requestId: "o:capture" });
    await c.voidAuthorization("A", "o:void").catch(() => undefined);
    expect(events.map((e) => [e.step, e.requestId, e.status, e.ok, e.outcome])).toEqual([
      ["authorize", "o:authorize", 201, true, "CREATED"],
      ["capture", "o:capture", 201, true, "COMPLETED"],
      ["void", "o:void", 422, false, "AUTHORIZATION_VOIDED"],
    ]);
    expect(events[0].debugId).toBe("dbg-test-1");
  });

  it("never lets a failing hook break a payment call", async () => {
    const fake = fakeFetch([{ status: 204 }]);
    const c = client(fake, {
      onCall: () => {
        throw new Error("audit write failed");
      },
    });
    await expect(c.voidAuthorization("A", "r")).resolves.toEqual({ status: "VOIDED" });
  });
});

// ---------- webhooks ----------

describe("verifyWebhookSignature", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "sig-1",
    "paypal-transmission-time": "2026-11-11T07:00:00Z",
  };
  const raw = JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } });

  it("sends the headers, webhook ID and parsed event; SUCCESS → true", async () => {
    const fake = fakeFetch([{ status: 200, body: { verification_status: "SUCCESS" } }]);
    await expect(client(fake).verifyWebhookSignature(new Headers(headers), raw)).resolves.toBe(true);
    expect(fake.requests[0].url).toBe(`${SANDBOX_API_BASE}/v1/notifications/verify-webhook-signature`);
    expect(fake.requests[0].body).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: headers["paypal-cert-url"],
      transmission_id: "tx-1",
      transmission_sig: "sig-1",
      transmission_time: "2026-11-11T07:00:00Z",
      webhook_id: "WH-TEST",
      webhook_event: JSON.parse(raw),
    });
  });

  it("FAILURE → false", async () => {
    const fake = fakeFetch([{ status: 200, body: { verification_status: "FAILURE" } }]);
    await expect(client(fake).verifyWebhookSignature(headers, raw)).resolves.toBe(false);
  });

  it("missing signature headers or a non-JSON body → false without calling PayPal", async () => {
    const fake = fakeFetch([]);
    const c = client(fake);
    const { ["paypal-transmission-sig"]: _omit, ...partial } = headers;
    await expect(c.verifyWebhookSignature(partial, raw)).resolves.toBe(false);
    await expect(c.verifyWebhookSignature(headers, "not json")).resolves.toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws WebhookConfigError when PAYPAL_WEBHOOK_ID isn't set", async () => {
    const fake = fakeFetch([]);
    await expect(client(fake, { webhookId: undefined }).verifyWebhookSignature(headers, raw)).rejects.toBeInstanceOf(WebhookConfigError);
  });
});
