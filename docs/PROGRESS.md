# FairPrice — build progress

Claude Code updates this file at the end of every task. Keep it short and current.

## Phase status

| Phase | Owner | Status | Notes |
| --- | --- | --- | --- |
| 1 Scaffold | Demo/QA | Done (2026-11-11) | typecheck, lint, test, build pass; Render DB reachable |
| 2 Premise test (GO/NO-GO) | Backend | Done — **GO** (2026-11-11) | IN, BR, US runs: payer country correct in both paths (GET + authorize, with and without NO_SHIPPING); capture 35 of 99 COMPLETED; void VOIDED. See `docs/SPIKE_RESULTS.md` |
| 3 Data layer | Backend | Done (2026-11-11) | Migration `20261111054533_init` applied to Render; seed run; 9 hash unit tests + 11 DB integration tests (`npm run test:db`) |
| 4 Eligibility engine | Backend | Done (2026-11-11) | `lib/eligibility/decide.ts`, 33 tests (SPEC matrix + edge cases + invariants); purity enforced by ESLint |
| 5 PayPal client | Backend | Done (2026-11-11) | `lib/paypal/` (client, extract, money, errors, server instance); 64 tests on real sandbox fixtures in `tests/fixtures/paypal/`; verify gate met (extractPayerCountry → IN, BR, US). Live calls exercised in Phase 6 |
| 6 Checkout API + finalize | Backend | Built (2026-11-11); verify gate = human run of `npm run e2e:sandbox` | quote, create order, finalize, reoffer, webhook routes; `lib/checkout/*`, `lib/geo/country.ts`; 23 DB tests; live smoke vs sandbox OK (found + fixed 415 Content-Type bug) |
| 7 Buyer page | Frontend | Built (2026-11-11); verify gate = human purchase on a phone-size window | `/p/[productId]` (server-rendered quote, demo banner, PayPal SDK v6 button, result screens + re-offer), `/checkout/return` finishes redirected checkouts. Browser-checked at 375 px light/dark; clicking the button created a real sandbox order (popup blocked in the pane, as expected) |
| 8 Pricing data + formula | AI engine | Done (2026-11-11) | `data/price-levels.json` (199 countries, mostly 2025; IN 0.2305, US 1), 42 targets, `data/fees.json`; `lib/pricing/formula.ts` (23 tests, written first) + `data.ts` loader (11 sanity tests) |
| 9 AI engine + validator | AI engine | Done (2026-11-11) | Validator (22 tests, first), prompts, page fetcher, `ai.ts` pipeline (19 mocked-SDK tests), seller session, 5 SPEC routes + `/api/session`, `updateDraftRows`. Real-API route flow passed 19/19 checks; stability results in `data/ai-stability-results.json` |
| 10 Seller app | Frontend | Done (2026-11-11) | `/seller` (sign-in, product list, setup, workspace: audience → prices/compare → publish). AG Grid 36.3. Full flow checked in the browser (desktop + phone width, light + dark); verify gate (teammate test) still to do |
| 11 Orders dashboard | Frontend | Built (2026-11-11); verify gate needs Phase 6 | `GET /api/products/:id/orders`, `lib/db/orders.ts`, Orders tab (AG Grid, decision filter with counts, copy buttons, 5 s live refresh). Checked in the browser with temporary orders (deleted). Real sandbox orders come with Phase 6 |
| 12 Benchmark | AI engine | Done (2026-11-11) | `npm run benchmark` → `data/benchmark-results.json` (committed, real Sonnet 5.5 run, ~$0.40); `GET /api/benchmark`; `/benchmark` page. Verify gate met: US tax guide >20%-off in low-relevance countries formula 34 vs AI 0; avg low-relevance discount 41.8% → 8.5% |
| 13 Hardening | Backend | Done (2026-11-11) | Rules review: all 10 money-safety rules met (F1 fixed: accepted-offer capture moved into decide() as rule 7). Webhook logic testable + tested; SPEC §6 gaps covered; 21 Playwright tests (seller, buyer desktop+mobile, benchmark) pass. **Feature freeze** |
| 14 Deploy + README | Demo/QA | Built (2026-11-11); human deploy + webhook + verify gate pending | `render.yaml` (web service, free, Singapore; reuses the existing free Render Postgres), `GET /api/health`, seed adds 5 benchmark products with DRAFT v1, full README. Render start command run locally on the production build: health 200 `{ok:true,db:true}` |
| 15 Rehearse + submit | Everyone | Not started | |

## Decisions (newest first)

- Phase 14 (user choices: Render free plan; benchmark products seeded with draft tables; commit + push to the public repo `github.com/Viswanvi/FairPrice`; deploy from the user's existing Render account). `render.yaml`:
  - Web `fairprice` only, with `plan: free` and `region: singapore`. `plan` must be explicit: when omitted, Render uses a paid instance.
  - **Reuses the existing database.** The user's existing Render Postgres (free, Singapore, already migrated and seeded) is the hosted database, because a workspace gets only one free Postgres. The first plan, a new database from the Blueprint, was dropped for this reason. The `databases:` block stays in the file, commented out, for a fresh workspace.
  - `DATABASE_URL` is `sync: false` (the database's Internal URL).
  - `SESSION_SECRET` uses `generateValue` (44-char base64).
  - Secrets use `sync: false`.
  - Non-secret fixed values are literal: the sandbox `PAYPAL_API_BASE`, `NEXT_PUBLIC_PAYPAL_ENVIRONMENT=sandbox`, `AI_MODEL`, `DEMO_GEO_OVERRIDE=true` and `NODE_VERSION=24`.
- Phase 14 deviations from the phase prompt's build command:
  - **Migrations run at start** (`npx prisma migrate deploy && npm start`), not at build. Render's docs don't say whether the build step can reach the private network, but a running free service can. `migrate deploy` is a no-op when nothing is pending.
  - **`npm ci --include=dev`**, because the build needs the Prisma CLI, Tailwind and TypeScript even if `NODE_ENV=production` is ever set.
  - Free instances have no Shell or pre-deploy command, so the deployed database is seeded once from a local machine using its External URL (README, "Deploy to Render").
- Phase 14 health check: `GET /api/health` is `checkHealth()` in `lib/health.ts` with an injected ping (`SELECT 1`) and a 3 s timeout. It returns 200 `{ok:true,db:true}` or 503 `{ok:false,db:false}`, sets `Cache-Control: no-store`, is `force-dynamic` (never prerendered), and logs only the error name. It is also Render's `healthCheckPath`.
- Phase 14 seed (supersedes the Phase 3 "benchmark products stay in JSON" decision; SPEC §13 asks for them):
  - `prisma/seed.ts` also creates the 5 benchmark products for `demo-seller`. Each gets its committed AI table as an unapproved **DRAFT v1** via `createDraftTable`, built by `lib/pricing/benchmark-draft.ts`.
  - The draft is rebuilt to match what the AI route stores: validator rows plus `region`, `formulaPriceCents` and `netCents`.
  - The formula baseline is recomputed and must equal the committed formula prices, or the seed throws "out of date".
  - The validator runs on every AI price, and any error throws, so nothing is seeded.
  - An existing product is never updated, and a table is added only when the product has none, so re-runs are no-ops (checked twice on the dev DB).
  - Buyers see "not on sale yet" until a seller approves (rule 5).
- Phase 14 scripts: new `npm run db:setup` (`migrate deploy` + seed) keeps local setup in the README to 5 commands.

- Phase 13: `decide()` rule 7 (user-approved): a VOID whose offer equals the authorized amount returns CAPTURE with reason UNCLEAR/NOT_PAYPAL; Decision CAPTURE reasons widened accordingly; finalizeOrder now captures only on decide() CAPTURE (CLAUDE.md rule 3 holds literally). One own Phase-4 test changed with approval (guest card at standard → capture). Webhook logic moved to `handleWebhookRequest()` in `lib/checkout/webhook.ts` (route is a thin wrapper) and tested: invalid signature → 401 no side effects; duplicate → stored/acted once; no webhook ID → 503; failed handling forgets the event. Playwright: own port 3100 + build folder `.next-e2e` (`NEXT_DIST_DIR`), random per-run seller password in the test server's env only, data seeded/removed by global setup/teardown, no AI or PayPal logins. Not changed (noted): no rate limiting on sign-in or checkout creation; finalize holds a DB connection ≤ 60 s during PayPal calls.

- Phase 12: benchmark counts per SPEC (below fee floor; > 20% off in AI-low-relevance countries) + added "average discount by audience relevance" (formula vs AI). Fee-floor count is 0/0 for all five products (every seller minimum is above the $4.90 floor) and is labelled as such. Count 2 separates only the tax guide (34 vs 0); the relevance averages show the AI's shallower low-relevance discounts for all five. Shared grid moved to `app/_components/price-grid.tsx` (compare-mode ties: highlighted rows first). `cx` moved to `app/_components/cx.ts` (server components can't call functions from "use client" modules). Chart colours validated with the dataviz checker: `--series-formula` orange #eb6834/#d95926, `--series-ai` teal #0d9488/#1a9e8f.

- Phase 7: `@paypal/react-paypal-js` 10.6.1 (`/sdk-v6`): `PayPalProvider` (clientId, environment="sandbox", components ["paypal-payments"], pageType "checkout") + `PayPalOneTimePaymentButton` (type "pay", presentationMode "auto"). **v6 has no intent/currency in the browser** — CLAUDE.md's "intent=authorize, currency=USD" is v5 wording; AUTHORIZE comes from the server-created order. One client flow (`app/checkout/checkout-flow.tsx`) serves the product page and `/checkout/return` (PayPal's "auto" mode may redirect on phones; the return page finalizes `?token=`). Result titles in `app/checkout/result-card.tsx`; message text always from the server. Quote logic shared via `lib/checkout/quote.ts`; wording in `lib/checkout/display.ts` (untabled country = "Price for X", never "fair"). CheckoutResult now carries `productId`.

- Phase 6: finalizeOrder locks the order row (FOR UPDATE, 60 s tx) across PayPal calls; a VOID whose offer equals the authorized amount is captured (accepted offer; never after decide() throws). DECLINED only for real payment-refusal issues; other non-retryable PayPal errors → 502, order left open; 422 ORDER_NOT_APPROVED → PENDING (confirmed live). PayPal client now always sends Content-Type on POST (PayPal returned 415 without it). geoip-lite runs country-only via `.geoip/` (scripts/prepare-geoip.mjs; ~8 MB vs 111 MB RAM), `serverExternalPackages`. Webhook order-ID path (`supplementary_data.related_ids.order_id`) still unverified → confirm in Phase 14. Re-offer: one per voided order, price from the row.

- PayPal client = `createPayPalClient(config)` (injectable `fetch`, clock, `onCall`), sandbox-only guard; app instance `paypalClient(onCall?)` in `lib/paypal/server.ts` (server-only). Orders: `NO_SHIPPING`, `PAY_NOW`, return/cancel `APP_BASE_URL/checkout/{return,cancel}`, `custom_id` + `invoice_id` (≤127 chars). Capture sends `invoice_id` + `final_capture: true` and returns PayPal fee/net. Void accepts 200 body or 204. Token cached until 60 s before expiry; a 401 clears it and retries once with the same `PayPal-Request-Id`; nothing else is retried here — `PayPalError.retryable` (status 0 or ≥ 500) tells Phase 6's capture loop when to retry. Missing fields → `PayPalResponseError` (never guessed). Webhook verify: five `paypal-*` headers + parsed event; missing headers/invalid JSON → false without a call; no `PAYPAL_WEBHOOK_ID` → `WebhookConfigError` (route → 503). `onCall` failures are swallowed so audit never breaks a payment.

- Orders dashboard: an "Orders" tab in the product workspace (server passes the first page, the client polls `GET /api/products/:id/orders` every 5 s while the tab is visible; pause switch; new rows highlighted 4 s). Labels in `lib/seller/orders.ts` never accuse ("Country mismatch") and every not-charged decision says "Not charged". AG Grid modules needed beyond Phase 10: `RenderApiModule` (refreshCells), `RowApiModule` (redrawRows) — the dev ValidationModule caught both.

- Payer country: `payer.address.country_code`, fallback `payment_source.paypal.address.country_code`, read from the authorize response; never the shipping address. Real orders use `NO_SHIPPING`. Sandbox fees confirmed equal to `data/fees.json` (capture response `seller_receivable_breakdown`).

- Seller app: server pages (`requireSellerPage()` redirects to `/seller/sign-in`) load data via `lib/db`; client components call the Phase 9 routes then `router.refresh()`. One workspace page with steps (Audience → Prices → Publish) so the demo video needs no page loads; it jumps to Publish when a version becomes approved. Shared UI primitives in `app/_components/ui.tsx`; tokens in `app/globals.css` (teal accent, not PayPal blue; light/dark via `prefers-color-scheme`).
- AG Grid 36.3 Community, modules registered individually (ClientSideRowModel, NumberEditor, Tooltip, RowStyle, CellStyle, ExternalFilter; Validation in dev only). Theme = `themeQuartz.withParams` fed with our CSS variables, so dark mode follows the page. Edits use `readOnlyEdit` + `onCellEditRequest`: the grid only changes after the server accepts; rejected cells turn red with the server's reason as tooltip. AG Grid ≥ 36.2 uses `tooltip` callbacks (`tooltipValueGetter`/`tooltipField` are deprecated). Grid loaded with `next/dynamic` (`ssr: false`).
- Dates on seller pages use `formatDateTimeUtc` (fixed en-GB + UTC) — locale formatting caused a hydration mismatch. Country names via `Intl.DisplayNames`.

- AI calls use `client.beta.messages.parse` + `betaZodOutputFormat` (structured outputs), `output_config.effort: "low"`, `max_tokens` 16000, and server-side refusal fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). **No `temperature`**: Sonnet 5.5 and API version 2026-10-21 reject sampling params (SPEC said "low temperature"). SDK `@anthropic-ai/sdk` 1.8.0, `maxRetries` 2, timeout 120 s. Client is injected (`AiDeps`) so tests use a fake — no production switch.
- Pipeline: JSON/Zod/shape failure (incl. missing regions, `max_tokens`) → retry once with the error. Validator errors → re-ask once listing them (second answer kept only if it has ≤ errors). Remaining bad/missing rows → formula price, flag `formula_fallback`, relevance from the region profile. Refusal or unusable output → whole table formula (`meta.aiFailure`); API errors (`ai_unavailable`) propagate as 503 — never a silent formula table. Stored rows carry extras `region`, `formulaPriceCents`, `netCents`.
- Seller session: `fp_session` httpOnly cookie, HMAC-SHA256 with `SESSION_SECRET`, 12 h, sameSite lax, secure in production; password compared in constant time. One demo seller (`lib/db/demo.ts`); products are checked for ownership (404 otherwise). Routes return `{code, message}` via `lib/http.ts` `route()`, logging only error name + message.
- Seller edits (`PATCH …/rows/:country`) run inside `updateDraftRows` (product row lock) so concurrent edits never overwrite each other; the validator runs on the fresh rows inside the transaction; edit adds `seller_edited`, drops `formula_fallback`. Approve re-validates the stored draft and refuses with 422 + reasons. Analyze requires nothing else; price tables require a stored audience profile (409 `analyze_first`).
- Product link fetching (`lib/pricing/page-text.ts`): http(s), default ports, no credentials, every hop's DNS must be public (blocks loopback/private/link-local/metadata/IPv6 ULA etc.), 3 redirects, 5 s, 1 MB, HTML → text. If the link fails but a description exists, the description is used with a note.

- Validator (`lib/pricing/validator.ts`): one error per row (invalid_price → not_whole_cents → above_base → below_floor → discount_exceeds_max) plus missing/duplicate/unknown country; `discountPct` always recomputed from price. When max(min, fee floor) > base, only base is allowed. Inversion warning only if price levels differ by > 0.05, prices by > $1, and the pricier country's relevance isn't lower; at most one warning per country.

- Formula: `DEFAULT_STRENGTH` s = 1 (full PPP — the plain baseline the AI must beat). Floors: seller min, fee floor, and max-discount floor (rounded UP so discount ≤ max); highest wins; price never above base; if every floor is above base, price = base (`floor_above_base`). Result reports `boundBy` (min_price / fee_floor / max_discount / base / floor_above_base); `formulaTable` turns it into a flag and gives `no_data` countries the base price. Fee floor uses one conservative value (includes the international fee) for every country.
- `data/fees.json`: 3.49% + $0.49, +1.5% international, maxFeeShare 15% → fee floor 490 cents. Illustrative US PayPal Checkout rates; confirm on PayPal's fees page.
- `data/target-countries.json`: 42 countries across the 10 audience regions (same list as the AI prompt). TR counted as Eastern Europe. RU excluded (PayPal suspended), TW excluded (no World Bank data).
- `scripts/fetch-worldbank.ts` (`npm run data:worldbank`): Zod-checked World Bank v2 responses, paginated; iso3 → iso2 via the country list; aggregates dropped; latest year with both indicators; ratios outside 0.05–3 excluded with a reason (Liberia, Venezuela). `price-levels.json` keeps the World Bank region; FairPrice regions live only in target-countries.json. BR and AR both show 0.4572 for 2025 — checked: distinct raw inputs, genuine coincidence in the source data.

- DB tables/columns are snake_case via `@@map`/`@map` to match SPEC SQL (raw `FOR UPDATE` reads `orders`, `products`). Enums: Goal, PriceTableStatus, OrderDecision, OrderStatus (CREATED, AUTHORIZED, CAPTURED, VOIDED, DECLINED, NEEDS_REVIEW).
- Order has extra columns beyond SPEC: `offer_cents` (re-offer reads it from the voided row), `charged_cents` (what PayPal confirmed), `payment_type`, `previous_order_id` (re-offer chain). `paypal_order_id` is nullable: our row is created before the PayPal call.
- `createDraftTable` / `approveTable` lock the product row (`SELECT … FOR UPDATE`) so versions and approvals serialize; at most one approved version per product. Re-approving the approved version is a no-op; a superseded version can't be re-approved. Hash = sha256 of rows sorted by country with sorted keys (`lib/db/hash.ts`), recomputed on approval.
- Stored rows are Zod-checked (`lib/db/types.ts`): upper-case ISO code, whole positive cents, unique countries; extra keys allowed. Pricing rules (floors/caps) stay in the Phase 9 validator.
- `recordWebhookEvent` uses `createMany({ skipDuplicates })` (ON CONFLICT DO NOTHING) so a duplicate never aborts a transaction. Webhook payloads and audit detail are stored through `lib/sanitize.ts` (rule 9). Sanitizer moved there from `scripts/spike/`.
- Seed uses fixed IDs `demo-seller` / `demo-bootcamp` (buyer page `/p/demo-bootcamp`). The demo product gets no price table (the AI generates one, the seller approves it). Benchmark products: see Phase 14.
- DB integration tests live in `tests/db/` and run only via `npm run test:db` (separate config loads `.env`); every row uses an `itest-<run>` prefix and is deleted afterwards.
- `decide()` takes `table: { version, rows: { country, priceCents }[] }`. Payer country trimmed + upper-cased; blank or not two letters → UNCLEAR. Invalid cents, a bad table price or a duplicated payer row throw `EligibilityInputError` — finalize must void, never capture, on a throw. ESLint keeps `lib/eligibility/` free of db/paypal/pricing/env/node imports, `fetch`, `process`, `Date`, `Math.random`.
- Spike request IDs include a per-run ID (PayPal replays the first response for a reused `PayPal-Request-Id`). Spike reads only the PayPal env subset. Approval link rel is `payer-action`; created status `PAYER_ACTION_REQUIRED`.
- Env in `.env` (Prisma CLI reads only `.env`). `lib/env.ts` (server, `server-only`), `lib/env.script.ts` (tsx), `lib/env.public.ts` (browser). Schema enforces sandbox API base; `SESSION_SECRET` ≥ 32, `SELLER_DEMO_PASSWORD` ≥ 8; `PAYPAL_WEBHOOK_ID` optional.
- Next.js 16.4 with `cacheComponents`/`partialPrefetching` OFF. Prisma 6.x. Node ≥ 22. npm `allowScripts` approves prisma + esbuild install scripts only.

## Open issues (newest first)

- Phase 14, still to do by a human:
  1. ~~Create the GitHub repo and push~~ (done: `origin` is `https://Viswanvi@github.com/Viswanvi/FairPrice.git`, and pushing uses the Viswanvi GitHub login).
  2. ~~Render Blueprint~~ (done 2026-11-11: live at **https://fairprice-edof.onrender.com**. Checked: `/api/health` 200 `{ok:true,db:true}` after a 46 s free-plan cold start; `/`, `/benchmark` and the draft buyer page load; `/seller` → sign-in). Pending: change `APP_BASE_URL` in Render to `https://fairprice-edof.onrender.com` (it was entered as `https://fairprice.onrender.com`).
  3. Seed: already done, because the hosted database is the one in `.env`. Re-run `npm run db:seed` only if data is missing.
  4. Register the PayPal webhook at `https://fairprice-edof.onrender.com/api/webhooks/paypal` (5 events, README "Deploy to Render" step 6), set `PAYPAL_WEBHOOK_ID`, redeploy.
  5. Verify gate: in a private window on the live URL, complete an India purchase and a VPN mismatch; the webhook events then appear in `webhook_events`.
- Phase 14 verify gate, part 1 passed (2026-11-11). India buyer on the hosted app, `bench-design-templates` v1:
  - **Charge:** shown IN $16, payer IN, MATCH, CAPTURED $16.
  - **Audit trail:** create → authorize → decide → capture, each with a `${orderId}:step` request ID.
  - **Webhooks:** 3 events, all verified. The webhook order-ID path `resource.supplementary_data.related_ids.order_id` is **confirmed** (recorded in `docs/SPIKE_RESULTS.md`).
  - Also done: `PAYPAL_WEBHOOK_ID` set in Render (an unsigned POST gets 401) and `APP_BASE_URL` fixed.
- Phase 14 verify gate, part 2 passed (2026-11-11). VPN mismatch: US buyer on `?as=IN`, PayPal order `91D623706U4570026`.
  - **Result:** shown IN $16, payer US, eligible $39, MISMATCH, VOIDED, charged $0, offer $39.
  - **Audit trail:** create → authorize → decide VOID → void (`:void` request ID).
  - **Webhooks:** 3 verified events, including `PAYMENT.AUTHORIZATION.VOIDED`; each one re-ran finalize, which returned `MISMATCH`.
  - **Leftover order:** one abandoned checkout (`7VC610678X489814E`, status CREATED, never approved, no money) from opening the PayPal window twice. Harmless.
  - **Optional, still to run:** paying the $39 re-offer, and the traveler case.
- Phase 14 risks:
  - **Free web service sleeps** after 15 minutes idle (the first request takes about a minute; the README says so).
  - **Free Postgres expires** 30 days after creation. The existing database was created around 2026-11-10, so check its expiry date in Render against the judging period.
  - **Shared seller password and AI cost.** Judges need the seller password and there is no rate limiting, so anyone with it can run AI analyses. Set a spend limit on the Anthropic key, and share the password in the Devpost submission, not the README.
- Local `.env` and the hosted site share one database. Local test runs (`test:db`, `test:e2e`) briefly add `itest-`/`e2e-` rows and remove them when they finish, so the live seller list can show test products while tests run. Avoid running tests while recording the demo. Since Phase 14 the database also holds the 5 benchmark DRAFT tables.
- `npm run build` loads `lib/env`, so it needs every env var. On Render they are set when the Blueprint is created.
- Seller password: the user chose one (2026-11-11) and typed it into Render themselves. It is also in local `.env`, written as `\$` because Next.js expands `$NAME` in `.env` files. Checked: Next.js and Node's `--env-file` both read the exact value, and `parseServerEnv` passes. Render's dashboard values are not expanded, so they are entered as-is.
- Seller UI polish: in Formula vs AI, the "high" relevance chip is low-contrast on highlighted rows.

- Product-link fetch: DNS could re-resolve between the check and the fetch (rebinding) — acceptable for the sandbox demo. Sign-in has no rate limit.
- 3-run stability check (2026-11-11, Sonnet 5.5, prompts 2026-11-11.1): 15/15 pipelines ok, schema pass 100%, 0 formula-fallback rows, $1.13. But the AI's FIRST table broke validator rules in 7/15 runs (design templates up to 17 rows, ebook up to 7) — all fixed by the re-ask, at ~+25 s. Error codes aren't recorded yet. Likely improvement: send each country's lowest allowed price (max of min, fee floor, max-discount floor) instead of only minPriceUsd/feeFloorUsd. Latency 22–61 s per pipeline → seller UI needs clear loading states. Tax-guide discounts vary run to run (IN 10–29%).
- Verify gate met: tax guide avg IN −22% / BR −13% (formula would give −50%, the max); coding course IN −70% / BR −57%.
- Full 20-run stability check not run yet (≈ $7–8 at the measured ~$0.075/pipeline). Run `npm run ai:stability -- --runs 20` when approved.


## Last session summary

- 2026-11-11: Phase 14 built.
  - Checks: 301 unit + 44 DB + 22 Playwright tests pass; typecheck, lint and build pass (`/api/health` is dynamic).
  - Render's start command was run locally on the production build: health 200, `/benchmark` 200, draft product "not on sale yet", `/seller` → sign-in.
  - Git: commit `bd81db5` holds Phases 1–13; Phase 14 is committed separately; no remote yet.
  - Next: the human steps under Open issues, then Phase 15.
- 2026-11-11: Phase 13 done. 287 unit + 44 DB + 21 Playwright tests pass; typecheck, lint, build pass. Feature freeze: bug fixes only from here. Next: Phase 14 (render.yaml, /api/health, README, first commit + GitHub remote, Render deploy, webhook). Human: sandbox purchases (Phases 6/7 verify).
- 2026-11-11: Phase 12 done (283 unit tests, typecheck, lint, build pass; /benchmark browser-checked desktop + phone/dark). Remaining: human sandbox purchases (Phases 6/7 verify), Phase 13 (hardening), 14 (deploy + README), 15 (rehearse + submit). Nothing committed yet.
- 2026-11-11: Phase 7 built. 278 unit tests, typecheck, lint, build pass. Human verify (with Phase 6's): set SELLER_DEMO_PASSWORD → `npm run dev` → approve a table for demo-bootcamp in /seller → open `/p/demo-bootcamp?as=IN` on a phone-size window → buy as the India sandbox buyer (expect PAID) and as the US buyer (expect MISMATCH + "Pay $99"); `npm run e2e:sandbox` covers the traveler. Next: Phase 12 (benchmark), 13 (hardening), 14 (deploy).
- 2026-11-11: Phase 6 built. 271 unit + 38 DB tests, typecheck, lint, build pass. NEXT: set SELLER_DEMO_PASSWORD, approve a table for demo-bootcamp in /seller, run `npm run dev` then `npm run e2e:sandbox` (IN / VPN / traveler with sandbox buyers). Then Phase 7 (buyer page).
- 2026-11-11: Phase 5 done. `lib/paypal/` built and tested against 9 sanitized sandbox fixtures (IN/BR/US authorize, captures with real fees, void, create, get). 252 unit tests, typecheck, lint pass. Next: Phase 6 (geo, quote, checkout orders, finalizeOrder, reoffer, webhook, e2e-sandbox script).
- 2026-11-11: Phase 2 closed (BR/US runs found; SPIKE_RESULTS.md = GO). Phase 11 built: orders query + endpoint + dashboard; 207 unit tests, 15 DB tests, typecheck, lint, build pass. Browser check with a temporary product and 6 TEST- orders (all deleted): summary, filters, relative times, live refresh, copy button. Next: Phase 5 (PayPal client) → 6 (checkout + finalize) → 7 (buyer page).
- 2026-11-11: Phase 10 done. Browser run with a throwaway password (process env only): sign-in redirect, create product, analysis, generate (42 rows), $1 edit rejected (red + reason), $39 accepted (discount/net/fingerprint update, inversion warning), Formula vs AI top-5, approve → Publish (link, embed, v1 + hash). Fixed during the run: AG Grid tooltip deprecations, hydration mismatch (dates), stale fingerprint after edits, misleading late loading message. Test product deleted. 197 unit tests, typecheck, lint, build pass.
- 2026-11-11: Phases 1, 3, 4, 8 done; Phase 2 script done and IN run passed (BR/US pending). 94 unit tests + 11 DB tests pass; typecheck and lint clean. Render DB holds only the seeded demo seller and product. Next: Phase 9 (AI engine + validator), or Phase 5 once SPIKE_RESULTS.md exists.
