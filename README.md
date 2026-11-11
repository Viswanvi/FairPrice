# FairPrice

FairPrice lets sellers of digital products charge a fair price in every country, recommended
by AI and approved by the seller. At checkout, PayPal confirms the buyer's account country
before any money is captured, so a VPN can't unlock another country's price and nobody is
charged more than the price for their own country. Sellers reach the buyers who could never
pay a single US price, and every pricing decision is recorded against its PayPal ID.

**Live demo:** `https://<your-service>.onrender.com` _(placeholder: replaced with the Render URL after deploy)_
· Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/) · PayPal **sandbox only**

> The hosted demo runs on Render's free plan: if nobody has visited for 15 minutes, the first
> page can take about a minute to wake up.

## How it works

1. **Seller sets up a product.** The seller enters a base price, a minimum price and a
   maximum discount, then pastes a link or a description.
2. **AI prices it per country.** The AI reads the product and works out who actually buys it.
   It then proposes a price for each of 42 countries, with a one-sentence reason for each.
   A validator in code enforces the seller's floor and cap and PayPal's fee floor. The seller
   edits prices in an AG Grid table, compares them with a plain purchasing-power formula, and
   approves a versioned, hashed table.
3. **Buyer sees their country's price.** The price shown comes from the visitor's IP country,
   and is for display only.
4. **PayPal decides what is charged.** The order is only *authorized* at first. FairPrice then
   reads the payer's account country from PayPal and compares it with the approved table:
   - if they match, the order is captured;
   - if the price for the account's country is lower (a traveler), the lower price is captured;
   - if the price for the account's country is higher (VPN or mismatch), the order is voided
     and the buyer is offered the right price. **Nobody is charged a wrong amount.**

## Try it with sandbox buyers

**Seller sign-in:** go to `/seller`. On the hosted demo, the password is in the Devpost
submission. Locally, it's your `SELLER_DEMO_PASSWORD`.

1. Open **Full-Stack TypeScript: Build and Ship Five Real Apps**, one of the five benchmark
   products. Its AI price table is already there as an unapproved draft, so no AI call is
   needed. Toggle **Formula vs AI**, edit a price if you like, then click **Approve version 1**.
   The page shows the buyer link.
2. Open the buyer link in a **private window**. Adding `?as=IN` simulates a visitor from India.
   A banner shows when this demo override is on, and it changes only the *displayed* price.
3. Pay with the PayPal sandbox button, logging in as one of the buyers below.

| Scenario | Open | Log in to PayPal as | Expected result |
| --- | --- | --- | --- |
| Fair price | `/p/bench-coding-course?as=IN` | India buyer | "You paid $27, the fair price for India." |
| VPN / mismatch | `/p/bench-coding-course?as=IN` | US buyer | "Your PayPal account is registered in the United States. The price there is $89. You have not been charged." Below it, "Pay $89 with PayPal" offers the right price. |
| Traveler | `/p/bench-coding-course?as=US` | India buyer | "You were charged $27, the fair price for your country, not $89." |

These prices come from the seeded draft. If the seller edits the draft before approving,
the numbers change to match.

**Sandbox buyer logins** (sandbox accounts hold test money only):

| Buyer | Email | Password |
| --- | --- | --- |
| India | `<added for judging>` | `<added for judging>` |
| United States | `<added for judging>` | `<added for judging>` |
| Brazil | `<added for judging>` | `<added for judging>` |

You can also make your own buyers: [developer.paypal.com](https://developer.paypal.com) → Testing Tools →
Sandbox Accounts → Create account (Personal, choose the country).

The **Orders** tab in the seller workspace shows each decision live, with its PayPal order,
authorization and capture IDs. `/benchmark` compares the formula and the AI across all five products.

## AI tools used and how

**In the product: Anthropic Claude (`claude-sonnet-5-5`, set by `AI_MODEL`)**, called from the
server with the Anthropic TypeScript SDK. It makes two calls, both using structured outputs
checked by Zod schemas:

1. **Audience analysis.** It reads the product's title, description and (optionally) page
   text, which is wrapped in `<product_page>` tags and treated as data. It returns who buys the
   product: category, language, buyer type, how easily it is shared, and how relevant each
   world region is.
2. **Per-country pricing.** It gets the audience profile, each country's World Bank price
   level, the formula price and the fee floor. It returns a price and a one-sentence reason
   for each country.

**Guardrails around the AI:**
- **No tools.** The AI's output is data only.
- **Validator in code.** Every AI price is checked against the minimum price, maximum
  discount, base price and PayPal fee floor (`lib/pricing/validator.ts`). Rule breaks get one
  re-ask; rows that still fail fall back to the formula.
- **Draft only.** The result is a DRAFT. **AI output never reaches checkout:** only a table
  the seller has approved does, and approval runs the validator again.
- **Benchmark.** The formula-versus-AI benchmark on five invented products is precomputed and
  committed (`data/benchmark-results.json`, `npm run benchmark`).

**To build it: Claude Code.** Claude Code wrote the code phase by phase. It worked from the
development spec (`docs/SPEC.md`) and the phase prompts (`docs/BUILD_PROMPTS.md`), following
the rules in [`CLAUDE.md`](CLAUDE.md): money-safety rules, tests first for the eligibility
engine, formula and validator, and no guessed PayPal field paths. The team made the product
decisions, reviewed each phase, and ran the PayPal sandbox spike (`docs/SPIKE_RESULTS.md`)
that confirmed the idea works.

## Architecture

```
Browser ── seller app (/seller), buyer page (/p/[productId]), /benchmark
   │        PayPal JavaScript SDK button (sandbox)
   ▼
Next.js on Render (App Router + API routes, TypeScript strict)
   ├─ lib/pricing      World Bank formula · Anthropic calls · validator → DRAFT tables
   ├─ lib/checkout     create order (AUTHORIZE) → finalize → capture or void · webhooks
   ├─ lib/eligibility  decide(): pure function, no I/O, the only place a charge is decided
   ├─ lib/paypal       REST over fetch: orders, authorize, capture, void, verify webhook
   ├─ lib/geo          geoip-lite IP country: display only, never eligibility
   └─ lib/db           Prisma → Render Postgres (sellers, products, versioned price tables,
                       orders, webhook events, audit log)
```

**Money-safety rules** (enforced in code and tests; full list in [`CLAUDE.md`](CLAUDE.md)):
- **Server-set amounts.** The server sets every amount from the approved table. No buyer-facing
  endpoint accepts a price.
- **Integer cents.** All amounts are integer cents, converted to PayPal strings only at the
  PayPal boundary.
- **Authorize, then decide.** Orders use `intent: AUTHORIZE`. Capture happens only when
  `decide()` says so, and never more than the authorized amount; otherwise the authorization
  is voided.
- **Idempotent calls.** Every authorize, capture and void sends a `PayPal-Request-Id` built
  from the order ID and the step.
- **Verified webhooks.** Webhooks are checked with PayPal's verify-webhook-signature API
  before any action, and each event is stored once.
- **Minimal data.** FairPrice stores only the payer's country code and PayPal IDs: no names,
  emails or addresses.

The PayPal account country is strong evidence of where a buyer lives, not proof. FairPrice
uses it because it is the strongest signal available at checkout.

**Sponsor tools**
- **AG Grid Community** (`ag-grid-react`): the editable price table with Formula vs AI
  comparison, the orders dashboard, and the benchmark tables.
- **Render**: hosts the web service and Postgres, defined in [`render.yaml`](render.yaml).

## Run it locally

Needs Node 22+ and Docker (or any Postgres 16+). In a clone of this repository:

```bash
npm install
cp .env.example .env          # fill in the values (see below)
docker compose up -d db       # or point DATABASE_URL at any Postgres
npm run db:setup              # migrations + demo seller, demo product, 5 benchmark products
npm run dev                   # http://localhost:3000
```

**Values for `.env`:**
- **`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`:** from a PayPal **sandbox** REST app.
  `NEXT_PUBLIC_PAYPAL_CLIENT_ID` takes the same client ID.
- **`ANTHROPIC_API_KEY`.**
- **`SESSION_SECRET`:** 32+ random characters, for example from
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- **`SELLER_DEMO_PASSWORD`:** 8+ characters.
- **`PAYPAL_WEBHOOK_ID`:** optional locally, because webhooks need a public URL.

The app refuses to start without the required values, and refuses any PayPal API base other
than the sandbox.

**Tests**
- `npm test`: unit tests.
- `npm run test:db`: database integration tests.
- `npm run test:e2e`: Playwright tests on desktop and phone viewports.
- `npm run e2e:sandbox`: a guided run against the real PayPal sandbox.
- Also: `npm run typecheck` and `npm run lint`.

## Deploy to Render

1. **Create the Blueprint.** Push this repository to GitHub. In the Render dashboard, choose
   **New → Blueprint** and pick the repository. Render reads `render.yaml`: a web service
   `fairprice` and a Postgres database `fairprice-db`, both on the free plan in Singapore.
2. **Fill in the values Render asks for:**
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (the same client ID);
   - `ANTHROPIC_API_KEY`;
   - `SELLER_DEMO_PASSWORD`;
   - `APP_BASE_URL`, your service URL, for example `https://fairprice.onrender.com`.
     Render shows the real URL after creation; if it differs, update this value.
   - Leave `PAYPAL_WEBHOOK_ID` empty for now.
   - `SESSION_SECRET` is generated for you, and `DATABASE_URL` is wired to the database.
     Migrations run when the service starts.
3. **Check the deploy.** `https://<your-service>.onrender.com/api/health` should return
   `{"ok":true,"db":true}`.
4. **Seed once, from your machine.** In Render, open `fairprice-db` → **Connect** → copy the
   **External** URL. Then run:
   - PowerShell: `$env:DATABASE_URL="<external URL>"; npm run db:seed; Remove-Item Env:DATABASE_URL`
   - macOS / Linux: `DATABASE_URL="<external URL>" npm run db:seed`

   It is safe to run again: it never overwrites a product or table that already exists.
5. **Register the PayPal webhook.** At [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials
   (Sandbox) → your app → **Add Webhook**:
   - URL: `https://<your-service>.onrender.com/api/webhooks/paypal`
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`,
     `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`.

   Copy the webhook's ID into `PAYPAL_WEBHOOK_ID` in Render (service → Environment), then save
   and redeploy.
6. **Test it end to end.** Open the live URL in a private window and complete one purchase.

Render's free Postgres expires 30 days after it is created. Upgrade it, or recreate it and
seed again, if the demo needs to live longer.

## Project docs

- [`docs/SPEC.md`](docs/SPEC.md): the full development document.
- [`docs/SPIKE_RESULTS.md`](docs/SPIKE_RESULTS.md): what the PayPal sandbox actually returned.
- [`docs/PROGRESS.md`](docs/PROGRESS.md): build log and decisions.
- [`data/README.md`](data/README.md): where the price-level, fee and benchmark data come from.

The five benchmark products are invented for the demo. Prices are demo values, and FairPrice
makes no claims about conversion or revenue.

## License

[MIT](LICENSE)
