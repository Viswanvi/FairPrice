/**
 * Phase 6 guided end-to-end test against the REAL PayPal sandbox, through the app's own API.
 *
 *   1. Start the app:            npm run dev      (DEMO_GEO_OVERRIDE=true, SELLER_DEMO_PASSWORD set)
 *   2. Approve a price table for the product in the seller app (/seller).
 *   3. Run:                      npm run e2e:sandbox -- [--product demo-bootcamp] [--base http://localhost:3000]
 *
 * For each scenario the script creates a checkout order (with ?as=XX to simulate the visitor's IP
 * country for the SHOWN price), prints the PayPal approval link and which sandbox buyer to log in
 * as, waits for you, then calls finalize and compares the result with what should happen. It also
 * calls finalize a second time to show it's idempotent. You approve as the buyer; this script
 * never logs in to PayPal.
 */
import { createInterface } from "node:readline/promises";
import { z } from "zod";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = (arg("base") ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const productId = arg("product") ?? "demo-bootcamp";

const quoteSchema = z.object({
  title: z.string(),
  shownCountry: z.string().nullable(),
  priceCents: z.number(),
  standardCents: z.number(),
  overridden: z.boolean(),
  tableVersion: z.number(),
});
const resultSchema = z.object({
  result: z.string(),
  orderId: z.string(),
  decision: z.string().nullable(),
  chargedCents: z.number(),
  country: z.string().nullable(),
  offerCents: z.number().nullable(),
  canReoffer: z.boolean(),
  message: z.string(),
});
type Result = z.infer<typeof resultSchema>;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = z.object({ code: z.string(), message: z.string() }).safeParse(json);
    throw new Error(`${method} ${path} → HTTP ${res.status}${msg.success ? ` ${msg.data.code}: ${msg.data.message}` : ""}`);
  }
  return schema.parse(json);
}

const quote = (as: string) => call("GET", `/api/quote?productId=${encodeURIComponent(productId)}&as=${as}`, quoteSchema);
const createOrder = (as: string) =>
  call("POST", `/api/checkout/orders?as=${as}`, z.object({ paypalOrderId: z.string() }), { productId });
const finalize = (paypalOrderId: string) => call("POST", `/api/checkout/orders/${paypalOrderId}/finalize`, resultSchema);
const reoffer = (previousOrderId: string) => call("POST", "/api/checkout/reoffer", z.object({ paypalOrderId: z.string() }), { previousOrderId });

interface Scenario {
  name: string;
  as: string;
  buyer: string;
  expect: (q: { IN: number; US: number; standard: number }) => { result: string; chargedCents: number; note: string };
}

const scenarios: Scenario[] = [
  {
    name: "1. India buyer pays the fair price",
    as: "IN",
    buyer: "your INDIA sandbox personal account",
    expect: (q) => ({ result: "PAID", chargedCents: q.IN, note: `captured ${usd(q.IN)} (MATCH)` }),
  },
  {
    name: "2. VPN: US buyer on an Indian IP",
    as: "IN",
    buyer: "your US sandbox personal account",
    expect: (q) => ({ result: "MISMATCH", chargedCents: 0, note: `voided, not charged, offered ${usd(q.US)}` }),
  },
  {
    name: "3. Traveler: India buyer on a US IP",
    as: "US",
    buyer: "your INDIA sandbox personal account",
    expect: (q) => ({ result: "TRAVELER", chargedCents: q.IN, note: `shown ${usd(q.US)}, captured only ${usd(q.IN)}` }),
  },
  {
    name: "4. (Optional) Guest card, no PayPal account",
    as: "IN",
    buyer: "NO PayPal account: choose 'Pay with debit or credit card' and use a sandbox test card from developer.paypal.com → Testing Tools → Card Generator",
    expect: (q) => ({ result: "NOT_PAYPAL", chargedCents: 0, note: `voided, offered the standard price ${usd(q.standard)}` }),
  },
];

function printResult(r: Result) {
  console.log(`   result: ${r.result} · charged ${usd(r.chargedCents)} · payer country ${r.country ?? "none"}` + (r.offerCents ? ` · offered ${usd(r.offerCents)}` : ""));
  console.log(`   buyer sees: "${r.message}"`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(q)).trim().toLowerCase();

  console.log(`FairPrice sandbox end-to-end test · app ${base} · product ${productId}\n`);
  let qIN, qUS;
  try {
    [qIN, qUS] = await Promise.all([quote("IN"), quote("US")]);
  } catch (error) {
    console.error(`Couldn't get a quote: ${error instanceof Error ? error.message : error}`);
    console.error("Is the app running (npm run dev), with DEMO_GEO_OVERRIDE=true and an APPROVED price table for this product?");
    process.exit(1);
  }
  if (!qIN.overridden) {
    console.error("The ?as= override is off. Set DEMO_GEO_OVERRIDE=true in .env and restart the app.");
    process.exit(1);
  }
  const prices = { IN: qIN.priceCents, US: qUS.priceCents, standard: qIN.standardCents };
  console.log(`"${qIN.title}" · approved table v${qIN.tableVersion} · India ${usd(prices.IN)} · US ${usd(prices.US)} · standard ${usd(prices.standard)}\n`);
  if (prices.IN >= prices.US) console.warn("Note: India isn't cheaper than the US in this table, so the traveler case can't show a lower capture.\n");

  const summary: { name: string; pass: boolean | null; detail: string }[] = [];
  for (const s of scenarios) {
    const expected = s.expect(prices);
    console.log(`── ${s.name}`);
    console.log(`   expected: ${expected.result} — ${expected.note}`);
    const go = await ask("   Run it? [Enter = yes, s = skip, q = quit] ");
    if (go === "q") break;
    if (go === "s") {
      summary.push({ name: s.name, pass: null, detail: "skipped" });
      continue;
    }

    const { paypalOrderId } = await createOrder(s.as);
    console.log(`   Open: https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`);
    console.log(`   Log in as ${s.buyer}, approve, then come back.`);
    await ask("   Press Enter once approved… ");

    let result = await finalize(paypalOrderId);
    while (result.result === "PENDING") {
      console.log("   PayPal says it isn't approved yet.");
      if ((await ask("   Approve it, then press Enter (q to give up) ")) === "q") break;
      result = await finalize(paypalOrderId);
    }
    printResult(result);
    const pass = result.result === expected.result && result.chargedCents === expected.chargedCents;
    console.log(`   ${pass ? "PASS" : "FAIL"} (expected ${expected.result}, charged ${usd(expected.chargedCents)})`);

    const again = await finalize(paypalOrderId);
    const same = JSON.stringify(again) === JSON.stringify(result);
    console.log(`   finalize again → ${same ? "same result, no new PayPal calls (idempotent)" : "DIFFERENT result!"}`);
    summary.push({ name: s.name, pass: pass && same, detail: `${result.result}, charged ${usd(result.chargedCents)}` });

    if (result.canReoffer && result.result === "MISMATCH") {
      if ((await ask(`   Try the re-offer at ${usd(result.offerCents ?? 0)}? [y/N] `)) === "y") {
        const next = await reoffer(result.orderId);
        console.log(`   Open: https://www.sandbox.paypal.com/checkoutnow?token=${next.paypalOrderId}`);
        console.log(`   Log in as ${s.buyer} again and approve ${usd(result.offerCents ?? 0)}.`);
        await ask("   Press Enter once approved… ");
        const r2 = await finalize(next.paypalOrderId);
        printResult(r2);
        const ok = r2.result === "PAID" && r2.chargedCents === result.offerCents;
        console.log(`   ${ok ? "PASS" : "FAIL"} (expected PAID at ${usd(result.offerCents ?? 0)})`);
        summary.push({ name: `${s.name} → re-offer`, pass: ok, detail: `${r2.result}, charged ${usd(r2.chargedCents)}` });
      }
    }
    console.log("");
  }
  rl.close();

  console.log("Summary");
  for (const s of summary) console.log(`  ${s.pass === null ? "SKIP" : s.pass ? "PASS" : "FAIL"}  ${s.name} — ${s.detail}`);
  console.log("\nUnclear (no payer country) can't be produced with a normal sandbox account; it's covered by tests/db/checkout.test.ts.");
  console.log(`Check the Orders tab in the seller app: ${base}/seller/products/${productId}`);
  if (summary.some((s) => s.pass === false)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
