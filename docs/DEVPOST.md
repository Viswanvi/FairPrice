# Devpost submission — draft

Copy each section into the matching Devpost field. Items in `[brackets]` need filling in.
Every number below comes from the project's own tests, benchmark file or live sandbox runs.

---

## Project name

FairPrice

## Tagline

Fair prices for digital products in every country, set by AI, approved by the seller, and checked by PayPal before any money moves.

## Links ("Try it out")

- Live demo: https://fairprice-edof.onrender.com
- Code (MIT): https://github.com/Viswanvi/FairPrice
- Video: `[YouTube link]`

---

## Inspiration

Courses, ebooks, templates and software are priced for rich countries. At $99, a coding course
is out of reach for most learners in India or Brazil, so creators lose sales they could make at a
fair price.

Sellers who do offer regional discounts run into two problems:
- **They have to set the prices by hand.**
- **Buyers fake their location with a VPN.**

We wanted a fair price that a seller can trust and a buyer can't game.

## What it does

FairPrice gives each country its own fair price for a digital product, and lets PayPal confirm
where the buyer's account is registered before any money is captured.

1. **The seller sets limits.** They add a product (a link or a description), a base price, a
   minimum price and a maximum discount.
2. **AI proposes a price for each of 42 countries.** It first works out who actually buys this
   product, then prices each country with a one-line reason.
3. **Code checks every price.** It enforces the seller's minimum, the maximum discount and
   PayPal's fee floor.
4. **The seller approves.** They review and edit prices in a grid, compare them with a simple
   purchasing-power formula, and approve a versioned, fingerprinted price table.
5. **The buyer sees their country's price.** It is based on their IP, and the IP is used for
   display only. They pay with the PayPal button.
6. **PayPal decides what is charged.** The payment is only *authorized* at first. FairPrice reads
   the payer's account country from PayPal and compares it with the approved table:
   - **Match:** the shown price is captured.
   - **Traveler:** an Indian account browsing from the US is charged the lower Indian price.
     **Nobody is overcharged.**
   - **VPN / mismatch:** a US account pretending to be in India is **not charged at all**. The
     authorization is voided, and the buyer is offered the US price.
7. **Alex, an AI video guide, shows people around.** On any page, a visitor can take a 3-minute
   guided tour or just talk to Alex. Alex is a live, lip-synced video avatar that answers in the
   visitor's language. He finds products and says their price for the visitor's country, opens
   pages, fills in a seller's product form, and points to the PayPal or Approve button. He never
   pays, approves or changes a price himself.
8. **The buyer gets help in their own language.** A **Listen** button explains the price and the
   result in Hindi, Portuguese or Spanish, read aloud by the browser.
9. **The seller sees every decision.** A live orders dashboard shows each order with its PayPal
   order, authorization and capture IDs.

## How we use PayPal

- **Orders v2 with `intent: AUTHORIZE`**, created only by the server.
  - The browser never sends a price; the server takes it from the approved table.
  - The PayPal JavaScript SDK v6 button runs the checkout.
- **The payer's account country** (`payer.address.country_code`) is read from the authorization
  response. This is the core signal, and a Day-0 sandbox spike checked it for India, Brazil and
  the US before anything else was built.
- **Capture less than authorized** for travelers, and **void** for mismatches. The capture can
  never exceed the authorized amount.
- **Every authorize, capture and void sends a `PayPal-Request-Id`**, built from our order ID and
  the step, so retries are safe.
- **Webhooks are verified** with PayPal's verify-webhook-signature API, and each event is stored
  once. On the live site, real events (authorization created, capture completed, authorization
  voided, order approved) arrived verified and out of order. Each one safely re-checked the order
  with no double capture.
- **What we store:** only the payer's country and PayPal IDs. No names, emails or addresses.

## How we use AI

**In the product:** Claude Sonnet 5.5, through the Anthropic TypeScript SDK, makes two calls with
structured outputs checked by Zod.
1. **Audience analysis.** It reads the product, with any seller-provided text treated as data,
   and rates how relevant each world region is: category, language, buyer type and how easily
   the product is shared.
2. **Per-country pricing.** It gets each country's World Bank price level, the formula price and
   the fee floor, and returns a price and a one-sentence reason for each country.

**The AI never reaches checkout:**
- **No tools:** the pricing AI produces data only.
- **A validator in code** checks every price; rule breaks get one re-ask, and anything still
  failing falls back to the formula.
- **The result is a draft** until the seller approves it, and approval re-checks it.

**Alex, the guide:** Gemini Live on Vertex AI, through Google's Gen AI SDK, gives Alex his video
avatar, voice and ears. A small WebSocket bridge on our server keeps the Google key off the
browser.
- **Same safe tools as the rest of FairPrice:** search, open a page, fill a form, press a setup
  button, point at something. None of them can pay, approve or edit a price.
- **Prices only from the server:** every price Alex says comes from a tool that reads the
  approved table for the visitor's country. A check flags any number he says that no tool gave
  him.
- **The tour is fixed, reviewed text:** Alex reads each tour line word for word.
- **Fallbacks:** video only on a fast connection, otherwise voice, then text. If Gemini is
  unreachable, a Claude-based guide with the browser's voice takes over. Checkout never depends
  on any of it.

**Benchmark: formula vs AI.** We compared the two on five invented products (the `/benchmark`
page):
- **US tax-preparation guide.**
  - The formula gives more than 20% off in **34** countries where the AI rated buyers unlikely;
    the AI does so in **0**.
  - The average discount in those 40 countries drops from **41.8% to 8.5%**.
  - In India, the formula would charge **$24.50**; the AI keeps it at **$44**, because a guide
    to US tax law has few buyers there.
- **All five products:** the AI discounts less where real buyers are unlikely, and about the same
  where they are. In short, it discounts where the buyers are, not everywhere.

**To build it: Claude Code.** We wrote a development spec and phase-by-phase build prompts, plus a
`CLAUDE.md` of money-safety rules (for example: the server owns every amount, authorize before
capture, the AI never touches checkout). Claude Code built each phase, tests first for the
eligibility engine, formula and validator. We reviewed every phase and ran the PayPal sandbox
tests ourselves.

## What's new compared with Gumroad, Paddle and ParityDeals

| | Country pricing | Who sets prices | Country check at payment |
| --- | --- | --- | --- |
| Gumroad | Automatic 20–60% discounts from World Bank data | Gumroad (seller sets a maximum) | Card country and IP |
| Paddle | Country-specific prices | Seller, by hand | Geolocation; buyer can change country |
| ParityDeals | Discounts by country group | Seller, per group | IP and VPN blocking |
| **FairPrice** | **Per country, per product** | **AI proposes from the real audience; seller approves** | **PayPal account country, before capture** |

FairPrice differs in two ways:
- **AI prices each product by who actually buys it,** not by income alone.
- **A fair price is unlocked by paying with a PayPal account.** The check is fair both ways: VPN
  users aren't charged, and travelers aren't overcharged. It also gives priced-out buyers a
  reason to join PayPal.

## How we built it

**Stack:**
- **App:** Next.js (App Router) with TypeScript in strict mode, and Tailwind.
- **Data:** PostgreSQL through Prisma; Zod for every external input and every AI output.
- **Grids:** AG Grid Community.
- **PayPal:** the REST API, called from the server only.
- **AI:** the Anthropic SDK for pricing; Google's Gen AI SDK (Gemini Live on Vertex AI) for Alex.
- **Hosting:** Render, with a small custom Node server so Alex's WebSocket and Next.js share one
  port.

**Eligibility rules:** `decide()` is a pure function with no database, network or clock access.
A lint rule enforces that.

**Tests:** 456 unit tests, 44 database integration tests and 56 Playwright browser tests (desktop
and phone, with Alex's connection mocked), plus a scripted end-to-end run against the real PayPal
sandbox.

## Sponsor tools

- **AG Grid Community** powers three screens:
  - the seller's editable price table, with Formula vs AI comparison and inline validation;
  - the live orders dashboard;
  - the benchmark tables.
- **Render** hosts the web service and PostgreSQL. The setup is in `render.yaml`, with a health
  check at `/api/health`.

## Challenges we ran into

- **Proving the idea first.** We had to confirm that the sandbox returns the payer's country,
  before writing any product code.
- **PayPal returned 415** on body-less POSTs (authorize, capture, void) until we always sent
  `Content-Type: application/json`.
- **Webhooks arrived out of order** (order-approved last). Every handler re-checks the stored
  order, so duplicates and late events are harmless.
- **The AI's first price table often broke a rule** (7 of 15 stability runs). A single re-ask
  listing the broken rules fixed every one; any row that still fails falls back to the formula.
- **Keeping a live avatar on script.** Alex reads tour lines word for word, gets prices only from
  server tools, and his spoken numbers are checked. Pausing to save cost after 20 seconds of
  silence also needed care: an early version could freeze while reconnecting.

## Accomplishments that we're proud of

- **Real sandbox purchases work end to end on the live site:**
  - an India buyer paid the fair price ($16 instead of $39);
  - a US account on a simulated Indian connection was charged **$0** and offered $39;
  - all of it was recorded with verified webhooks.
- **Money safety is enforced in code,** not just promised: the server owns every amount,
  authorization comes before capture, captures never exceed the authorized amount, retries are
  safe, and webhooks are verified.

## What we learned

- **A PayPal account's country is strong evidence of where a buyer lives,** though not proof, and
  checking it before capture removes the need for VPN detection.
- **AI is good at the judgment part (who buys this?).** Simple code is better at the guarantees
  (never below the minimum, never above the base price).

## Honest limits

- **Sandbox only;** prices are in US dollars.
- **The account country is evidence, not proof of residence.**
- **The IP country is for display only.** The demo uses a visible `?as=` override to simulate
  other countries.
- **No sales data yet:** the five benchmark products are invented, so we make no claims about
  conversion or revenue.
- **Card payments pay the standard price,** because fair prices need a PayPal account.
- **The free Render plan sleeps when idle,** so the first visit can take about a minute.
- **It's a demo:** one seller account, and no rate limiting on sign-in.
- **Alex's video needs a fast connection** (Chrome reporting 4G and at least 5 Mbps); otherwise he
  speaks without video. Talking to him needs a microphone; typing always works. Video is limited
  to 5 minutes per browser tab to keep costs down.
- **The tour lines are written in English and Hindi.** In other languages Alex translates them
  live.

## What's next

- **More languages,** such as Tamil, Bengali and Indonesian, reviewed by native speakers, and
  local-currency display.
- **Production PayPal,** seller accounts, and real sales data to measure how fair prices change
  conversion.

## Built with

`paypal` · `paypal-orders-api` · `paypal-js-sdk` · `anthropic` · `claude` · `claude-code` ·
`gemini-live` · `vertex-ai` · `websockets` · `nextjs` · `react` · `typescript` · `tailwindcss` ·
`postgresql` · `prisma` · `zod` · `ag-grid` · `render` · `vitest` · `playwright` ·
`world-bank-data`

---

## Testing instructions for judges

The live demo is https://fairprice-edof.onrender.com. It's PayPal **sandbox**, so no real money
is involved. The first visit can take about a minute to wake up.

**Sandbox buyer logins** (log in to PayPal with these when you pay):

| Buyer | Email | Password |
| --- | --- | --- |
| India | `[email]` | `[password]` |
| United States | `[email]` | `[password]` |

**Seller sign-in:** go to https://fairprice-edof.onrender.com/seller and use the password
`[seller password]`.

**Try these:**
0. **Meet Alex.** Open the home page in Chrome and tap **Take the 3-minute tour**. Alex walks you
   through the whole app on video. Say or type "skip" to move on, or "stop" to end. To talk to
   him instead, tap **Talk to Alex** and allow the microphone; any language works. On a slow
   connection he speaks without video.
1. **Fair price.** Open https://fairprice-edof.onrender.com/p/bench-design-templates?as=IN, which
   simulates a visitor from India (a banner says so). It shows **$16** instead of $39. Pay as the
   **India** buyer. Expected: "You paid $16, the fair price for India."
2. **VPN caught.** Open the same link in a new private window and pay as the **US** buyer.
   Expected: "Your PayPal account is registered in the United States. The price there is $39.
   You have not been charged."
3. **Traveler.** Open the link with `?as=US` (it shows $39) and pay as the **India** buyer.
   Expected: "You were charged $16, the fair price for your country, not $39."
4. **Seller side.** Sign in as the seller and open any product. Look at the AI price table, the
   **Formula vs AI** view, and the **Orders** tab with each decision and its PayPal IDs.
5. **Benchmark.** Open https://fairprice-edof.onrender.com/benchmark and switch between products.
