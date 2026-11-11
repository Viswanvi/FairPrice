import { z } from "zod";
import { PayPalError, PayPalResponseError, WebhookConfigError } from "./errors";
import { extractPayerCountry, type PayerInfo } from "./extract";
import { centsToValue, valueToCents } from "./money";

/**
 * Typed PayPal REST client (Orders v2, Payments v2, webhook verification) using fetch.
 * Field paths and behaviour follow docs/SPIKE_RESULTS.md.
 *
 * - Sandbox only (CLAUDE.md rule 8). Amount strings exist only inside this library (rule 2).
 * - Every state-changing call takes a caller-supplied PayPal-Request-Id (rule 6).
 * - No retries, except refreshing an expired token once on a 401.
 * - Responses are Zod-checked for the fields we use; anything missing → PayPalResponseError.
 * - `fetch` and the clock are injectable, so tests use fakes without a production switch.
 */

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export type PayPalStep = "token" | "create" | "get" | "authorize" | "capture" | "void" | "verify-webhook";

export interface PayPalCallEvent {
  step: PayPalStep;
  requestId: string | null;
  /** HTTP status; 0 for network errors. */
  status: number;
  ok: boolean;
  /** e.g. the order/authorization/capture status, or PayPal's error name. */
  outcome: string;
  durationMs: number;
  debugId: string | null;
}

export interface PayPalConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  /** Used for the return/cancel URLs PayPal needs on the order. */
  appBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called after every PayPal call (e.g. to write audit_log). Errors in it are swallowed. */
  onCall?: (event: PayPalCallEvent) => void | Promise<void>;
  timeoutMs?: number;
}

export interface CreatedOrder {
  id: string;
  status: string;
  /** The buyer approval link (rel "payer-action"). */
  approveUrl: string | null;
}

export interface AuthorizationInfo {
  id: string;
  status: string;
  amountCents: number;
  expirationTime: string | null;
}

export interface OrderSnapshot {
  id: string;
  status: string;
  customId: string | null;
  invoiceId: string | null;
  payer: PayerInfo;
  authorization: AuthorizationInfo | null;
}

export interface CaptureResult {
  id: string;
  status: string;
  amountCents: number;
  finalCapture: boolean | null;
  feeCents: number | null;
  netCents: number | null;
}

export interface VoidResult {
  status: string;
}

// ---------- response schemas (only fields we use) ----------

const usd = z.looseObject({ currency_code: z.literal("USD"), value: z.string() });

const tokenSchema = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().positive() });

const createdSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(z.looseObject({ href: z.string(), rel: z.string() })).optional(),
});

const orderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  purchase_units: z
    .array(
      z.looseObject({
        custom_id: z.string().optional(),
        invoice_id: z.string().optional(),
        payments: z
          .looseObject({
            authorizations: z
              .array(z.looseObject({ id: z.string().min(1), status: z.string(), amount: usd, expiration_time: z.string().optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});

const captureSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  amount: usd,
  final_capture: z.boolean().optional(),
  seller_receivable_breakdown: z
    .looseObject({ paypal_fee: usd.optional(), net_amount: usd.optional() })
    .optional(),
});

const voidSchema = z.looseObject({ status: z.string() });

const verifySchema = z.looseObject({ verification_status: z.string() });

const errorSchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.looseObject({ issue: z.string().optional() })).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

function toPayPalError(status: number, body: unknown): PayPalError {
  const e = errorSchema.safeParse(body);
  const data = e.success ? e.data : {};
  const name = data.name ?? data.error ?? `HTTP_${status}`;
  const issue = data.details?.[0]?.issue ?? null;
  const message = data.message ?? data.error_description ?? "PayPal returned an error";
  return new PayPalError(
    status,
    name,
    `PayPal ${status} ${name}${issue ? ` (${issue})` : ""}: ${message}`,
    data.debug_id ?? null,
    issue,
  );
}

function parseOrThrow<S extends z.ZodType>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PayPalResponseError(
      `Unexpected PayPal ${what} response: ${issue?.path.join(".") || "(root)"} — ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

export function createPayPalClient(config: PayPalConfig) {
  const apiBase = config.apiBase.replace(/\/+$/, "");
  if (apiBase !== SANDBOX_API_BASE) {
    throw new Error(`PayPal client is sandbox-only; refusing API base ${apiBase}`);
  }
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const appBaseUrl = config.appBaseUrl.replace(/\/+$/, "");
  let token: { value: string; expiresAt: number } | null = null;

  async function report(event: PayPalCallEvent): Promise<void> {
    if (!config.onCall) return;
    try {
      await config.onCall(event);
    } catch (error) {
      console.error("[paypal] onCall failed:", error instanceof Error ? error.name : "unknown");
    }
  }

  async function send(url: string, init: RequestInit): Promise<{ status: number; body: unknown; debugId: string | null }> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new PayPalError(0, "NETWORK_ERROR", "Couldn't reach PayPal (network error or timeout).");
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  }

  async function getAccessToken(): Promise<string> {
    if (token && now() < token.expiresAt) return token.value;
    const started = now();
    const { status, body, debugId } = await send(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (status < 200 || status >= 300) {
      const error = toPayPalError(status, body);
      await report({ step: "token", requestId: null, status, ok: false, outcome: error.paypalName, durationMs: now() - started, debugId });
      throw error;
    }
    const data = parseOrThrow(tokenSchema, body, "token");
    // Refresh 60 seconds before PayPal's expiry.
    token = { value: data.access_token, expiresAt: now() + data.expires_in * 1000 - 60_000 };
    return token.value;
  }

  /** One API call with bearer auth; a 401 refreshes the token and retries once (same request ID). */
  async function api(
    step: Exclude<PayPalStep, "token">,
    method: "GET" | "POST",
    pathname: string,
    options: { body?: unknown; requestId?: string; outcome: (body: unknown, status: number) => string },
  ): Promise<{ status: number; body: unknown }> {
    const started = now();
    let attempt = 0;
    for (;;) {
      attempt++;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await getAccessToken()}`,
        Accept: "application/json",
        Prefer: "return=representation",
      };
      // PayPal rejects POSTs without this header (HTTP 415), even when there is no body (authorize, void).
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;

      let result;
      try {
        result = await send(`${apiBase}${pathname}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        const e = error as PayPalError;
        await report({ step, requestId: options.requestId ?? null, status: 0, ok: false, outcome: e.paypalName, durationMs: now() - started, debugId: null });
        throw error;
      }

      if (result.status === 401 && attempt === 1) {
        token = null; // expired or revoked: refresh once
        continue;
      }
      const ok = result.status >= 200 && result.status < 300;
      if (!ok) {
        const error = toPayPalError(result.status, result.body);
        await report({
          step,
          requestId: options.requestId ?? null,
          status: result.status,
          ok: false,
          outcome: error.issue ?? error.paypalName,
          durationMs: now() - started,
          debugId: error.debugId ?? result.debugId,
        });
        throw error;
      }
      await report({
        step,
        requestId: options.requestId ?? null,
        status: result.status,
        ok: true,
        outcome: options.outcome(result.body, result.status),
        durationMs: now() - started,
        debugId: result.debugId,
      });
      return result;
    }
  }

  const statusOf = (body: unknown) => {
    const parsed = z.looseObject({ status: z.string() }).safeParse(body);
    return parsed.success ? parsed.data.status : "UNKNOWN";
  };

  function toSnapshot(body: unknown, what: string): OrderSnapshot {
    const order = parseOrThrow(orderSchema, body, what);
    const unit = order.purchase_units[0];
    const auth = unit.payments?.authorizations?.[0];
    return {
      id: order.id,
      status: order.status,
      customId: unit.custom_id ?? null,
      invoiceId: unit.invoice_id ?? null,
      payer: extractPayerCountry(body),
      authorization: auth
        ? { id: auth.id, status: auth.status, amountCents: valueToCents(auth.amount.value), expirationTime: auth.expiration_time ?? null }
        : null,
    };
  }

  function requireRequestId(requestId: string): void {
    if (!requestId || requestId.length > 108) throw new RangeError("PayPal-Request-Id must be 1–108 characters");
  }

  return {
    getAccessToken,

    /** Create an AUTHORIZE order for the server-chosen amount. The buyer approves it in PayPal. */
    async createOrder(input: { amountCents: number; customId: string; invoiceId: string; requestId: string }): Promise<CreatedOrder> {
      requireRequestId(input.requestId);
      if (input.amountCents <= 0) throw new RangeError("amount must be positive");
      if (input.customId.length > 127 || input.invoiceId.length > 127) throw new RangeError("custom_id and invoice_id max 127 chars");
      const { body } = await api("create", "POST", "/v2/checkout/orders", {
        requestId: input.requestId,
        outcome: statusOf,
        body: {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              custom_id: input.customId,
              invoice_id: input.invoiceId,
              amount: { currency_code: "USD", value: centsToValue(input.amountCents) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW",
                return_url: `${appBaseUrl}/checkout/return`,
                cancel_url: `${appBaseUrl}/checkout/cancel`,
              },
            },
          },
        },
      });
      const created = parseOrThrow(createdSchema, body, "create order");
      const link = created.links?.find((l) => l.rel === "payer-action") ?? created.links?.find((l) => l.rel === "approve");
      return { id: created.id, status: created.status, approveUrl: link?.href ?? null };
    },

    async getOrder(orderId: string): Promise<OrderSnapshot> {
      const { body } = await api("get", "GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { outcome: statusOf });
      return toSnapshot(body, "get order");
    },

    /** Authorize an approved order. Returns the authorization and the payer's account country. */
    async authorizeOrder(orderId: string, requestId: string): Promise<OrderSnapshot & { authorization: AuthorizationInfo }> {
      requireRequestId(requestId);
      const { body } = await api("authorize", "POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
        requestId,
        outcome: (b) => {
          const auth = z
            .looseObject({ purchase_units: z.array(z.looseObject({ payments: z.looseObject({ authorizations: z.array(z.looseObject({ status: z.string() })) }) })) })
            .safeParse(b);
          return auth.success ? (auth.data.purchase_units[0]?.payments.authorizations[0]?.status ?? "UNKNOWN") : "UNKNOWN";
        },
      });
      const snapshot = toSnapshot(body, "authorize");
      if (!snapshot.authorization) {
        throw new PayPalResponseError("Unexpected PayPal authorize response: purchase_units[0].payments.authorizations[0] is missing");
      }
      return { ...snapshot, authorization: snapshot.authorization };
    },

    /** Capture the eligible amount (≤ authorized) and close the authorization. */
    async captureAuthorization(
      authorizationId: string,
      input: { amountCents: number; invoiceId: string; requestId: string },
    ): Promise<CaptureResult> {
      requireRequestId(input.requestId);
      if (input.amountCents <= 0) throw new RangeError("capture amount must be positive");
      const { body } = await api("capture", "POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
        requestId: input.requestId,
        outcome: statusOf,
        body: {
          amount: { currency_code: "USD", value: centsToValue(input.amountCents) },
          invoice_id: input.invoiceId,
          final_capture: true,
        },
      });
      const capture = parseOrThrow(captureSchema, body, "capture");
      const breakdown = capture.seller_receivable_breakdown;
      return {
        id: capture.id,
        status: capture.status,
        amountCents: valueToCents(capture.amount.value),
        finalCapture: capture.final_capture ?? null,
        feeCents: breakdown?.paypal_fee ? valueToCents(breakdown.paypal_fee.value) : null,
        netCents: breakdown?.net_amount ? valueToCents(breakdown.net_amount.value) : null,
      };
    },

    /** Void an authorization: the buyer is never charged. */
    async voidAuthorization(authorizationId: string, requestId: string): Promise<VoidResult> {
      requireRequestId(requestId);
      const { status, body } = await api("void", "POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
        requestId,
        outcome: (b, s) => (s === 204 ? "VOIDED" : statusOf(b)),
      });
      // 204 No Content means success without a body.
      if (status === 204 || body === null) return { status: "VOIDED" };
      return { status: parseOrThrow(voidSchema, body, "void").status };
    },

    /**
     * Verify a webhook with PayPal's verify-webhook-signature API. Returns true only on SUCCESS.
     * Missing signature headers or a non-JSON body → false without calling PayPal.
     */
    async verifyWebhookSignature(headers: Headers | Record<string, string | undefined>, rawBody: string): Promise<boolean> {
      if (!config.webhookId) throw new WebhookConfigError();
      const get = (name: string) =>
        headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()] ?? null);
      const values = Object.fromEntries(Object.entries(WEBHOOK_HEADERS).map(([key, header]) => [key, get(header)]));
      if (Object.values(values).some((v) => !v)) return false;
      let event: unknown;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return false;
      }
      const { body } = await api("verify-webhook", "POST", "/v1/notifications/verify-webhook-signature", {
        outcome: (b) => {
          const parsed = verifySchema.safeParse(b);
          return parsed.success ? parsed.data.verification_status : "UNKNOWN";
        },
        body: { ...values, webhook_id: config.webhookId, webhook_event: event },
      });
      return parseOrThrow(verifySchema, body, "verify webhook").verification_status === "SUCCESS";
    },
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
