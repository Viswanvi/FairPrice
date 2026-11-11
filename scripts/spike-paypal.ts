/**
 * Phase 2: PayPal sandbox premise test (docs/SPEC.md sections 5 and 17).
 *
 *   npm run spike:paypal -- --label IN-buyer
 *
 * Order A: AUTHORIZE $99.00 with NO_SHIPPING -> approve -> GET -> authorize -> capture $35.00.
 * Order B: AUTHORIZE $99.00 with default shipping -> approve -> GET -> authorize -> void.
 * Prints where the payer country appears (MISSING if a path is absent) and saves every
 * response, sanitized, to scripts/spike-output/<timestamp>-<label>-<step>.json.
 *
 * Standalone: plain fetch, no app code, no database. Sandbox only (enforced by env schema).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { EnvError, parseEnv, paypalScriptEnvSchema } from "../lib/env-schema";
import { findCountryCodes, getAtPath, sanitize } from "../lib/sanitize";

type Scenario = "A" | "B";
type Json = Record<string, unknown>;

const RETURN_URL = "http://localhost:3000/spike-return";
const CANCEL_URL = "http://localhost:3000/spike-cancel";
const OUTPUT_DIR = path.join(process.cwd(), "scripts", "spike-output");

class PayPalHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const name = String(getAtPath(body, "name") ?? "HTTP_ERROR");
    const message = String(getAtPath(body, "message") ?? getAtPath(body, "error_description") ?? "");
    const debugId = String(getAtPath(body, "debug_id") ?? "none");
    super(`PayPal ${status} ${name}: ${message} (debug_id ${debugId})`);
    this.name = "PayPalHttpError";
  }
}

class AbortedByUser extends Error {}

interface ScenarioSummary {
  scenario: Scenario;
  shipping: string;
  orderId?: string;
  getPayerCountry?: unknown;
  getPaymentSourceCountry?: unknown;
  authPayerCountry?: unknown;
  authPaymentSourceCountry?: unknown;
  authorizationId?: unknown;
  authorizedAmount?: string;
  finalStep: "capture" | "void";
  finalStatus?: unknown;
  finalAmount?: string;
  /** Steps that returned a response, so the summary can tell MISSING from "not reached". */
  reached: Set<"get" | "authorize" | "final">;
  error?: string;
}

// ---------- setup ----------

function parseLabel(argv: string[]): string {
  const eq = argv.find((a) => a.startsWith("--label="));
  const idx = argv.indexOf("--label");
  const label = eq ? eq.slice("--label=".length) : idx >= 0 ? argv[idx + 1] : undefined;
  if (!label || !/^[A-Za-z0-9_-]{1,40}$/.test(label)) {
    console.error("Usage: npm run spike:paypal -- --label IN-buyer   (letters, digits, - and _)");
    process.exit(2);
  }
  return label;
}

const label = parseLabel(process.argv.slice(2));
const runId = Date.now().toString(36);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const savedFiles: string[] = [];

function save(step: string, data: unknown): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${timestamp}-${label}-${step}.json`);
  writeFileSync(file, JSON.stringify(sanitize(data), null, 2) + "\n", "utf8");
  if (!savedFiles.includes(file)) savedFiles.push(file);
}

// ---------- PayPal HTTP ----------

let apiBase = "";
let accessToken = "";

async function getAccessToken(clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new PayPalHttpError(res.status, body);
  const token = getAtPath(body, "access_token");
  if (typeof token !== "string") throw new Error("OAuth response had no access_token");
  return token; // never printed or saved
}

async function paypal(
  method: "GET" | "POST",
  pathname: string,
  options: { body?: unknown; requestId?: string } = {},
): Promise<{ status: number; data: Json | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;
  const res = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data: Json | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as Json;
    } catch {
      data = { unparsed_body: text.slice(0, 500) };
    }
  }
  if (!res.ok) throw new PayPalHttpError(res.status, data);
  return { status: res.status, data };
}

// ---------- printing ----------

const show = (v: unknown): string => (v === undefined || v === null || v === "" ? "MISSING" : String(v));

function money(amount: unknown): string {
  const value = getAtPath(amount, "value");
  const currency = getAtPath(amount, "currency_code");
  return value === undefined ? "MISSING" : `${show(value)} ${show(currency)}`;
}

function printCountryReport(title: string, data: Json | null): void {
  console.log(`\n  ── ${title} ──`);
  console.log(`  payer.address.country_code                 : ${show(getAtPath(data, "payer.address.country_code"))}`);
  console.log(`  payment_source.paypal.address.country_code : ${show(getAtPath(data, "payment_source.paypal.address.country_code"))}`);
  const all = findCountryCodes(data);
  console.log(`  every country_code field (${all.length}):`);
  if (all.length === 0) console.log("    (none)");
  for (const f of all) console.log(`    ${f.path} = ${show(f.value)}`);
  const auth = getAtPath(data, "purchase_units[0].payments.authorizations[0]");
  console.log(`  order status                               : ${show(getAtPath(data, "status"))}`);
  console.log(`  payment_source type                        : ${data?.payment_source ? Object.keys(data.payment_source as Json).join(", ") : "MISSING"}`);
  console.log(`  authorization id                           : ${show(getAtPath(auth, "id"))}`);
  console.log(`  authorization status                       : ${show(getAtPath(auth, "status"))}`);
  console.log(`  authorization amount                       : ${money(getAtPath(auth, "amount"))}`);
}

// ---------- flow ----------

async function ask(rl: Interface, closed: Promise<void>, prompt: string): Promise<string> {
  // Input closed (Ctrl+C / Ctrl+D / no terminal) or "q" -> stop the whole run cleanly.
  const answer = await Promise.race([
    rl.question(prompt).catch(() => null),
    closed.then(() => null),
  ]);
  if (answer === null || answer.trim().toLowerCase() === "q") throw new AbortedByUser();
  return answer;
}

async function runScenario(s: Scenario, rl: Interface, closed: Promise<void>): Promise<ScenarioSummary> {
  const noShipping = s === "A";
  const summary: ScenarioSummary = {
    scenario: s,
    shipping: noShipping ? "NO_SHIPPING" : "default (no override)",
    finalStep: s === "A" ? "capture" : "void",
    reached: new Set(),
  };
  const rid = (step: string) => `spike-${s}-${label}-${runId}-${step}`;
  let step = `${s}-create`;

  console.log(`\n════ Order ${s}: AUTHORIZE 99.00 USD, shipping ${summary.shipping} ════`);
  try {
    // 1. Create
    const experience: Json = {
      user_action: "PAY_NOW",
      return_url: RETURN_URL,
      cancel_url: CANCEL_URL,
    };
    if (noShipping) experience.shipping_preference = "NO_SHIPPING";
    const created = await paypal("POST", "/v2/checkout/orders", {
      requestId: rid("create"),
      body: {
        intent: "AUTHORIZE",
        purchase_units: [
          { custom_id: `spike-${s}-${label}`, amount: { currency_code: "USD", value: "99.00" } },
        ],
        payment_source: { paypal: { experience_context: experience } },
      },
    });
    save(step, created.data);
    const orderId = String(getAtPath(created.data, "id"));
    summary.orderId = orderId;
    const links = (getAtPath(created.data, "links") as { rel?: string; href?: string }[] | undefined) ?? [];
    const approve = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
    console.log(`  order id     : ${orderId}`);
    console.log(`  order status : ${show(getAtPath(created.data, "status"))}`);
    console.log(`\n  Open this link and approve as the sandbox buyer:\n  ${show(approve?.href)}`);
    console.log(`  (After approval PayPal redirects to ${RETURN_URL}; it's fine if that page doesn't load.)`);

    // 2. Wait for approval, then GET until APPROVED
    step = `${s}-get`;
    let order: Json | null = null;
    for (;;) {
      await ask(rl, closed, "\n  Press Enter once approved (q to quit): ");
      order = (await paypal("GET", `/v2/checkout/orders/${orderId}`)).data;
      save(step, order);
      const status = getAtPath(order, "status");
      if (status === "APPROVED") break;
      console.log(`  Order status is ${show(status)}, not APPROVED yet. Approve it in the browser, then press Enter.`);
    }
    printCountryReport(`GET /v2/checkout/orders/${orderId}`, order);
    summary.reached.add("get");
    summary.getPayerCountry = getAtPath(order, "payer.address.country_code");
    summary.getPaymentSourceCountry = getAtPath(order, "payment_source.paypal.address.country_code");

    // 3. Authorize
    step = `${s}-authorize`;
    const authorized = (
      await paypal("POST", `/v2/checkout/orders/${orderId}/authorize`, { requestId: rid("auth") })
    ).data;
    save(step, authorized);
    printCountryReport(`POST /v2/checkout/orders/${orderId}/authorize`, authorized);
    summary.reached.add("authorize");
    summary.authPayerCountry = getAtPath(authorized, "payer.address.country_code");
    summary.authPaymentSourceCountry = getAtPath(authorized, "payment_source.paypal.address.country_code");
    const authorizationId = getAtPath(authorized, "purchase_units[0].payments.authorizations[0].id");
    summary.authorizationId = authorizationId;
    summary.authorizedAmount = money(getAtPath(authorized, "purchase_units[0].payments.authorizations[0].amount"));
    if (typeof authorizationId !== "string") {
      throw new Error("Authorize response had no purchase_units[0].payments.authorizations[0].id");
    }

    // 4. Capture lower (A) or void (B)
    if (s === "A") {
      step = "A-capture";
      const captured = await paypal("POST", `/v2/payments/authorizations/${authorizationId}/capture`, {
        requestId: rid("cap"),
        body: { amount: { currency_code: "USD", value: "35.00" }, final_capture: true },
      });
      save(step, captured.data);
      summary.reached.add("final");
      summary.finalStatus = getAtPath(captured.data, "status");
      summary.finalAmount = money(getAtPath(captured.data, "amount"));
      console.log(`\n  ── POST /v2/payments/authorizations/${authorizationId}/capture (35.00 of 99.00) ──`);
      console.log(`  HTTP ${captured.status}`);
      console.log(`  capture id     : ${show(getAtPath(captured.data, "id"))}`);
      console.log(`  capture status : ${show(summary.finalStatus)}`);
      console.log(`  captured amount: ${summary.finalAmount}`);
    } else {
      step = "B-void";
      const voided = await paypal("POST", `/v2/payments/authorizations/${authorizationId}/void`, {
        requestId: rid("void"),
      });
      save(step, voided.data ?? { http_status: voided.status, body: null });
      summary.reached.add("final");
      summary.finalStatus = getAtPath(voided.data, "status") ?? `HTTP ${voided.status}`;
      console.log(`\n  ── POST /v2/payments/authorizations/${authorizationId}/void ──`);
      console.log(`  HTTP ${voided.status}`);
      console.log(`  authorization status: ${show(summary.finalStatus)}`);
    }
  } catch (error) {
    if (error instanceof AbortedByUser) throw error;
    if (error instanceof PayPalHttpError) save(`${step}-error`, { http_status: error.status, body: error.body });
    summary.error = `${step}: ${error instanceof Error ? error.message : String(error)}`;
    console.log(`\n  ✗ ${summary.error}`);
  }
  return summary;
}

function printSummary(results: ScenarioSummary[]): void {
  console.log(`\n════ Summary for ${label} (run ${runId}) ════`);
  if (results.length === 0) console.log("\n  No order completed a step.");
  for (const r of results) {
    const notReached = "(not reached)";
    console.log(`\n  Order ${r.scenario} (shipping ${r.shipping}) ${r.orderId ? `id ${r.orderId}` : ""}`);
    console.log(
      r.reached.has("get")
        ? `    GET       payer.address.country_code = ${show(r.getPayerCountry)}, payment_source.paypal.address.country_code = ${show(r.getPaymentSourceCountry)}`
        : `    GET       ${notReached}`,
    );
    if (r.reached.has("authorize")) {
      console.log(`    authorize payer.address.country_code = ${show(r.authPayerCountry)}, payment_source.paypal.address.country_code = ${show(r.authPaymentSourceCountry)}`);
      console.log(`    authorization ${show(r.authorizationId)} for ${show(r.authorizedAmount)}`);
    } else {
      console.log(`    authorize ${notReached}`);
    }
    const final = r.finalStep === "capture"
      ? `capture 35.00 -> status ${show(r.finalStatus)}, amount ${show(r.finalAmount)}`
      : `void -> ${show(r.finalStatus)}`;
    console.log(`    ${r.reached.has("final") ? final : `${r.finalStep} ${notReached}`}`);
    if (r.error) console.log(`    ERROR ${r.error}`);
  }
  console.log(`\n  Saved ${savedFiles.length} sanitized file(s) to scripts/spike-output/`);
}

async function main(): Promise<void> {
  const env = parseEnv(paypalScriptEnvSchema, process.env);
  apiBase = env.PAYPAL_API_BASE;
  console.log(`FairPrice PayPal spike · label ${label} · run ${runId} · ${apiBase}`);

  accessToken = await getAccessToken(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
  console.log("OAuth token: OK");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<void>((resolve) => rl.once("close", () => resolve()));
  const results: ScenarioSummary[] = [];
  try {
    results.push(await runScenario("A", rl, closed));
    results.push(await runScenario("B", rl, closed));
  } catch (error) {
    if (!(error instanceof AbortedByUser)) throw error;
    console.log("\n  Stopped before finishing. Unapproved orders simply expire; nothing was charged.");
  } finally {
    rl.close();
  }
  printSummary(results);
  if (results.length < 2 || results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof EnvError || error instanceof PayPalHttpError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : error);
  printSummary([]);
  process.exit(1);
});
