# FairPrice — instructions for Claude Code

FairPrice lets sellers of digital products charge an AI-recommended fair price in every
country. PayPal confirms the buyer's account country before any money is captured.
Built for the PayPal AI Hackathon. Deadline: Thursday 12 Nov 2026, 12:00 PM Pacific.

## Sources of truth (read before every task)

1. `docs/SPEC.md` — the full development document. Section numbers below refer to it.
2. `docs/SPIKE_RESULTS.md` — what the PayPal sandbox ACTUALLY returned. If it disagrees
   with SPEC.md about PayPal field paths or behaviour, SPIKE_RESULTS.md wins.
3. `docs/PROGRESS.md` — what is done, decisions made, open issues. Read it at the start
   of every session. Update it at the end of every task.

## Stack (do not substitute without asking)

- Next.js (App Router) + TypeScript in strict mode + Tailwind CSS. Node 20+.
- PostgreSQL via Prisma. Local DB: `docker compose up -d db`.
- Zod for every external input and every AI output.
- Vitest for unit tests, Playwright for browser tests.
- AG Grid Community (`ag-grid-react`) for the price table and orders dashboard.
- PayPal: REST API called with `fetch` from the server only. Browser uses the PayPal
  JavaScript SDK button only (`intent=authorize`, `currency=USD`).
- AI: Anthropic TypeScript SDK (`@anthropic-ai/sdk`), model from `AI_MODEL` env var.
- IP country for DISPLAY only: `geoip-lite` on the client IP. Never used for eligibility.

## Layout

```
app/                 pages: seller app, /p/[productId] buyer page, /benchmark
app/api/             API routes (SPEC section 9)
lib/paypal/          token, orders, authorize, capture, void, webhook verify
lib/eligibility/     decide() — pure function + tests (SPEC section 6)
lib/pricing/         world bank data, formula, AI calls, prompts, validator + tests
lib/geo/             display-country lookup
lib/db/              Prisma client + small repository helpers
data/                price-levels.json, target-countries.json, fees.json, benchmark files
scripts/             spike-paypal.ts, fetch-worldbank.ts, ai-stability.ts, run-benchmark.ts
tests/               integration + Playwright tests
docs/                SPEC.md, SPIKE_RESULTS.md, PROGRESS.md, BUILD_PROMPTS.md
```

## Commands

- `npm run dev` · `npm run build` · `npm run typecheck` · `npm run lint`
- `npm test` (Vitest) · `npm run test:e2e` (Playwright)
- `npm run db:migrate` · `npm run db:seed`
- `npm run spike:paypal -- --label IN-buyer`

## Money-safety rules (never break these)

1. The server owns every amount. No buyer-facing endpoint accepts a price or amount.
   Prices come only from the APPROVED price table version stored with the order.
2. All amounts are integer cents in code and the database. Convert to "35.00" strings
   only at the PayPal boundary.
3. Orders use `intent: AUTHORIZE`. Capture happens only after `decide()` returns CAPTURE.
   Capture amount is always ≤ the authorized amount. Otherwise void.
4. `lib/eligibility/decide.ts` is pure: no database, network, AI, or Date.now() calls.
5. AI output never reaches checkout. It becomes a DRAFT table; a seller must approve it;
   the validator enforces floors and caps in code.
6. Every authorize, capture and void sends a `PayPal-Request-Id` derived from our order
   ID and the step (for example `${orderId}:capture`), so retries are safe.
7. Webhooks are verified with PayPal's verify-webhook-signature call before any action.
   Event IDs are stored once; duplicates are ignored.
8. Sandbox only: `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. Never live URLs.
9. Never log or store secrets, tokens, buyer names, full emails or street addresses.
   Store only payer country code and PayPal IDs.
10. Product page text sent to the AI is wrapped in `<product_page>` tags and treated as
    data. The AI has no tools.

## How to work

- For any task touching more than one file: propose a plan first and wait for approval.
- Tests first for `lib/eligibility`, `lib/pricing/formula.ts` and `lib/pricing/validator.ts`.
  Never weaken or delete a test to make it pass; explain the failure and ask.
- Do not guess PayPal field paths. If a response doesn't match SPEC or SPIKE_RESULTS,
  stop, print the sanitized response, and ask.
- No mock data or fake success states in the demo path. Test-only mocks must be
  impossible to enable in production.
- Keep dependencies minimal; say why before adding one.
- A task is done only when: `typecheck`, `lint` and `test` pass; you've described how
  to check it manually; and `docs/PROGRESS.md` is updated.
- Small commits with clear messages (for example `feat(eligibility): add decide()`).

## Buyer-facing copy rules (SPEC section 10)

- Always say whether money moved: "You have not been charged." / "You paid $35."
- Never accuse: "Your PayPal account is registered in the United States," not "VPN detected."
- Call the account country "strong evidence", never "proof of residence".
- Explain prices in one sentence, never with formulas.

## Demo-only behaviour

- `DEMO_GEO_OVERRIDE=true` allows `?as=IN` on the buyer page to simulate the visitor's
  IP country for the DISPLAYED price only. Show a visible banner when it is active.
  Eligibility always uses the PayPal payer country.
