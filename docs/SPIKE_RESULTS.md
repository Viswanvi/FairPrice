# PayPal sandbox spike results (Phase 2)

What the PayPal **sandbox** actually returned on 11 Nov 2026, from `scripts/spike-paypal.ts`
(Orders v2 + Payments v2, `https://api-m.sandbox.paypal.com`). Source data: 24 sanitized
responses in `scripts/spike-output/` (not committed; names, emails, phones, street addresses
and tokens removed — checked). Where this file disagrees with `docs/SPEC.md` about PayPal
field paths or behaviour, **this file wins** (CLAUDE.md).

Each run used one sandbox **personal** buyer and two orders, both `intent: AUTHORIZE`, USD 99.00:

- **Order A** — `payment_source.paypal.experience_context.shipping_preference: NO_SHIPPING`;
  approved → GET → authorize → **capture 35.00** (`final_capture: true`).
- **Order B** — no shipping override (PayPal default) → approved → GET → authorize → **void**.

## Where the payer country appeared

| Run | Order (shipping) | Response | `payer.address.country_code` | `payment_source.paypal.address.country_code` | Other `country_code` fields |
| --- | --- | --- | --- | --- | --- |
| IN-buyer | A (NO_SHIPPING) | GET after approval | IN | IN | none |
| IN-buyer | A (NO_SHIPPING) | authorize | IN | IN | none |
| IN-buyer | B (default) | GET after approval | IN | IN | `purchase_units[0].shipping.address.country_code` = IN |
| IN-buyer | B (default) | authorize | IN | IN | `purchase_units[0].shipping.address.country_code` = IN |
| BR-buyer | A (NO_SHIPPING) | GET after approval | BR | BR | none |
| BR-buyer | A (NO_SHIPPING) | authorize | BR | BR | none |
| BR-buyer | B (default) | GET after approval | BR | BR | `purchase_units[0].shipping.address.country_code` = BR |
| BR-buyer | B (default) | authorize | BR | BR | `purchase_units[0].shipping.address.country_code` = BR |
| US-buyer | A (NO_SHIPPING) | GET after approval | US | US | none |
| US-buyer | A (NO_SHIPPING) | authorize | US | US | none |
| US-buyer | B (default) | GET after approval | US | US | `purchase_units[0].shipping.address.country_code` = US |
| US-buyer | B (default) | authorize | US | US | `purchase_units[0].shipping.address.country_code` = US |

All 12 readings returned the buyer's correct country in both payer fields. `NO_SHIPPING`
removes only the shipping address (which we neither need nor store); the payer country survives it.

## Capture lower and void

| Run | Authorized | Capture request | Capture result | PayPal fee / net (from response) | Void result (order B) |
| --- | --- | --- | --- | --- | --- |
| IN-buyer | 99.00 USD | 35.00, `final_capture: true` | HTTP 201, `status: COMPLETED`, `amount.value: "35.00"` | 2.24 / 32.76 | HTTP 200, `status: VOIDED` |
| BR-buyer | 99.00 USD | 35.00, `final_capture: true` | HTTP 201, `status: COMPLETED`, `amount.value: "35.00"` | 2.24 / 32.76 | HTTP 200, `status: VOIDED` |
| US-buyer | 99.00 USD | 35.00, `final_capture: true` | HTTP 201, `status: COMPLETED`, `amount.value: "35.00"` | 1.71 / 33.29 | HTTP 200, `status: VOIDED` |

- **Capturing 35.00 on a 99.00 authorization succeeded** in all three runs.
- **Void succeeded** in all three runs.
- The fees match `data/fees.json` exactly: 3.49% + $0.49 domestic (US buyer), plus 1.5% international (IN, BR buyers).

## Paths and behaviour to use in `lib/paypal` (Phase 5)

**Payer country** — use, in this order, the first non-empty value:

1. `payer.address.country_code`
2. `payment_source.paypal.address.country_code`

Read it from the **authorize** response (`Prefer: return=representation`); the GET-after-approval
response carries the same values. Never use `purchase_units[0].shipping.address.country_code`
(shipping, not account; absent with `NO_SHIPPING`). If both are missing → `null` → decision UNCLEAR.

**Payment type** — the key of `payment_source` (`"paypal"` in every run). Every buyer had
`payment_source.paypal.account_status: "VERIFIED"`.

**Other fields observed**

| Step | Call | Observed |
| --- | --- | --- |
| Create | `POST /v2/checkout/orders` with `payment_source.paypal.experience_context` | `status: PAYER_ACTION_REQUIRED`; approval link has `rel: "payer-action"` (no `"approve"` link) |
| Approved | `GET /v2/checkout/orders/{id}` | `status: APPROVED`; no `payments` yet |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | order `status: COMPLETED`; authorization at `purchase_units[0].payments.authorizations[0]` with `id`, `status: CREATED`, `amount`, `custom_id`, `expiration_time` ≈ 29 days later |
| Capture | `POST /v2/payments/authorizations/{id}/capture` | HTTP 201; `id` = capture ID, `status: COMPLETED`, `amount`, `final_capture: true`, `custom_id`, `seller_receivable_breakdown.paypal_fee` / `.net_amount` |
| Void | `POST /v2/payments/authorizations/{id}/void` with `Prefer: return=representation` | HTTP 200 with the authorization body, `status: VOIDED` (expect 204 with no body if `Prefer` is omitted) |

`NO_SHIPPING` is safe to use for every real order (digital goods).

## Not tested in this spike

- Guest card checkout (no PayPal account): what `payment_source` and payer fields look like.
  `decide()` already treats a missing country as UNCLEAR and a non-PayPal source as NOT_PAYPAL.
- A declined authorization, capture errors, and idempotent replays with a reused `PayPal-Request-Id`.
- Webhooks (needs the deployed URL — Phase 14) and Log in with PayPal (Should; skipped).

## Decision

**GO** — the payer's PayPal account country is returned reliably (IN, BR, US), capturing less than
the authorized amount works, and void works.
