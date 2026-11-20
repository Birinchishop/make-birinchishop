# Birinchishop for Make

A [Make](https://www.make.com) (formerly Integromat) **custom app** for the
**[Birinchi Shop](https://birinchishop.uz) Partner API v1** — a COD (cash on delivery) CPA affiliate network in
Uzbekistan. Partners promote ready products; the network runs the call center, warehouse and nationwide delivery and
pays a fixed amount for every **delivered** order.

Same capabilities as the [n8n node](https://github.com/Birinchishop/n8n-nodes-birinchishop) and the Zapier integration:
instant order triggers that register their own webhook, orders with idempotency, tracking links, offers and reports.

API docs: https://birinchishop.uz/api/v1/docs · OpenAPI: https://birinchishop.uz/api/v1/openapi.json ·
Guide: https://birinchishop.uz/api/v1/guide.md

This folder holds the app **sections as JSON files** (`app/`), ready to paste into Make's web app editor, plus an
offline validator. Nothing has been uploaded to Make.

- [What's inside](#whats-inside)
- [Create an order — read this first](#create-an-order--read-this-first)
- [Errors](#errors)
- [Webhooks and authenticity](#webhooks-and-authenticity)
- [Validate locally](#validate-locally)
- [Install in Make (step by step, for the owner)](#install-in-make-step-by-step-for-the-owner)
- [Test plan](#test-plan)
- [Review and publishing](#review-and-publishing)

## What's inside

| Component | Name | Kind | API |
|---|---|---|---|
| Connection | `birinchishop` | Basic (API key) | `GET /me` validates the key; label "Name (live key)" / "(test key)" |
| Webhook | `orderCreated` | Dedicated, attached | attach `POST /webhooks` (`order.created`), detach `DELETE /webhooks/{id}` |
| Webhook | `orderStatusChanged` | Dedicated, attached | same, `order.status_changed` |
| RPC | `listOffers`, `listLinks` | Dropdown options | `GET /offers` (in stock), `GET /links`, 100 per page, limit 300 |
| Custom IML function | `parseDateFields` | Date parsing | parses nested `*_at` / `at` timestamps (`order.*`, `api_key.expires_at`, `paths[]`) |
| Instant trigger | `watchNewOrders` | Watch new orders | webhook `orderCreated` + `GET /orders/{id}` |
| Instant trigger | `watchOrderStatusChanges` | Watch order status changes | webhook `orderStatusChanged` + `GET /orders/{id}` |
| Polling trigger | `watchOrderEvents` | Watch order events | `GET /events?after={last id}&include_order=true` (no webhook needed) |
| Search | `searchOrders` | Search orders | `GET /orders` (status, conversion status, dates, updated since, offer, link, external ID, click ID) |
| Action | `getOrder` | Get an order | `GET /orders/{id}` |
| Action | `createOrder` | Create an order | `POST /orders` + `Idempotency-Key` (sent only when filled) |
| Action | `setTestOrderStatus` | Set a test order status | `POST /sandbox/orders/{id}/status` (test keys only) |
| Search | `searchLinks` | Search links | `GET /links` |
| Action | `createLink` | Create a link | `POST /links` |
| Search | `searchOffers` | Search offers | `GET /offers` (search, payout, sale rate, stock, sort, language) |
| Action | `getOffer` | Get an offer | `GET /offers/{id}` (description, images, variants) |
| Action | `getStatistics` | Get statistics | `GET /stats` (totals + rows per day / offer / link) |
| Action | `getCohortReport` | Get a cohort report | `GET /stats/cohorts` |
| Action | `getAttributionReport` | Get an attribution report | `GET /stats/attribution` (report only) |
| Action | `getAccount` | Get my account | `GET /me` |
| Universal | `makeApiCall` | Make an API call | `https://birinchishop.uz/api/` + a path that starts with the version, e.g. `/v1/offers` |

Outputs return the API response as it is (`{{...}}` spread), so fields the API adds later are mappable without an
app update. Timestamps (ISO 8601 UTC) are parsed into dates: top-level ones with `parseDate`, nested ones with the
custom function `parseDateFields`; date-only values (`delivery_date`, `clicks_since`, `tracking_since`, cohort weeks)
stay text. Date filters (*Created from/to*, *Date from/to*) are date fields sent as `YYYY-MM-DD`; *Updated since* is
sent as ISO 8601. Search modules have an optional Limit (default 10, empty = all results); *Watch order events* has a
required Limit (default 2).

Orders carry offer, link, variant, customer, payout, payout status, delivery date, notes and tracking (click ID,
sub1–sub5, external ID). **The customer phone is always masked by the API** (`+998 ** *** 45 67`); a full number is
never available. Money is whole UZS; date filters are Asia/Tashkent days (`YYYY-MM-DD`); timestamps are ISO 8601 UTC.

API key scopes: `account:read` (connection), `webhooks:manage` (instant triggers), `orders:read` (orders, instant
triggers), `orders:write` (Create an order, Set a test order status), `events:read` (Watch order events),
`links:read`/`links:write`, `offers:read`, `stats:read`. Do not put an IP allowlist on a key used by Make.

Layout:

```
app/
  metadata.json                 app name, label, description, theme, language (entered in the "Create app" form)
  base.imljson                  Base: base URL, Bearer header, error mapping, log sanitization
  groups.json                   module groups
  connections/birinchishop/     parameters.imljson, api.imljson (Communication), metadata.json
  webhooks/<name>/              parameters, attach, detach, api (receiver), metadata.json
  rpcs/<name>/                  api (Communication), parameters, metadata.json
  functions/<name>/             code.js (Code), test.js (Test) — custom IML functions
  modules/<name>/               api (Communication), parameters (Static), expect (Mappable),
                                interface, samples, metadata.json (type, label, description, connection, webhook)
assets/icon-512.png             app icon (512×512)
tools/generate.mjs              SOURCE OF TRUTH: writes app/ (edit here, then `npm run check`)
tools/validate.mjs              offline validator
tools/editor-schemas/           Make's editor JSON schemas (MIT, from integromat/vscode-apps-sdk)
```

## Create an order — read this first

> **With a live key (`bsk_live_...`), Create an order submits a REAL order.** A call center phones the customer and a
> courier delivers the product; the customer pays on delivery. Send only real customers who asked to order, with their
> correct phone number. **Never send test, sample or fake orders — the account gets blocked.** Build and test scenarios
> with a test key (`bsk_test_...`): it runs every check but creates nothing (output `test: true`, fake ID
> ≥ 2000000000, `live_orders_allowed`). Live orders via the API need an account with at least 3 delivered orders
> (or approval from support).

- **Idempotency key** — map a stable unique value (lead ID, sheet row ID). The same key returns the existing order
  instead of a second one, so Make retries and re-runs are safe. When the field is empty the `Idempotency-Key` header
  is not sent at all (the API also ignores an empty or blank header value), so every run creates a new order. Without
  a key, the API still refuses the same phone + offer within 24 hours (`duplicate_order`, 409), but that is an error,
  not a replay.
- The request body is built from the module's parameters in bulk (their names are the API's body keys).
- The module shows a warning banner in its form; Make an API call warns about `POST /v1/orders` too.

## Webhooks and authenticity

Instant triggers use **dedicated attached webhooks**. Make runs *attach* (`POST /webhooks` with Make's hook URL,
`kind: json`, one event type) when the user **creates the webhook in the module's webhook dialog**; the API returns the
webhook ID and a one-time signing secret, both saved in the webhook data (the secret is masked in logs). Make runs
*detach* (`DELETE /webhooks/{id}`) only when the user **deletes that webhook in Make's Webhooks section**; saving,
turning off or deleting the scenario does not touch the registration. attach/detach use relative URLs and inherit the
Base URL, the `Authorization` header and its log sanitization from the Base. The account allows **10 webhooks**; each
Make webhook uses one.

The API signs each request with `X-Birinchishop-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<t>.<raw body>")`.
**Make's app platform exposes neither the raw request body nor a documented HMAC primitive to the webhook receiver**, so
the signature cannot be verified in Make the way the n8n and Zapier integrations do. Instead:

1. The receiver passes on the whole payload (event ID, type, `api_version`, time, test flag, event data and any field
   added later) **except the order body** (`data.order` is omitted).
2. The instant trigger then re-reads the order with **the user's own API key** (`GET /orders/{id}`); the `order`,
   `status` and `conversion_status` in the output come from that authenticated response. A forged request can at most
   make the scenario re-read one of the account's own real orders; an unknown order ID makes the run fail with
   `order_not_found`.
3. Make hook URLs are long random URLs; treat them as secrets.

`event_status` / `event_conversion_status` / `previous_status` / `type` / `api_version` come from the (unverified)
webhook body; `status` and `conversion_status` are the current, verified ones. The panel's "Send test" button sends order ID 0 and is ignored by the receiver; to test, use a test key
with Create an order and Set a test order status (see [Test plan](#test-plan)).

If you prefer no webhooks (key without `webhooks:manage`, or the 10-webhook limit is used up), use **Watch order
events**: it polls the event feed after the last processed event ID (Make keeps that position), with the order
included. `GET /events` supports only ascending order with an `after` cursor; because every request asks only for
events after the last processed ID, Make's 3200-record limit for ascending triggers does not cause missed events. The
module has no Epoch ("Choose where to start"); the feed keeps 90 days and the first run starts at the oldest kept event,
returning at most *Limit* (default 2) events per run.

## Errors

The Base maps API errors (`{ error: { code, message }, request_id }`) to Make error types; a response without that
body (e.g. a proxy 502) shows "Unexpected response". 400 → `DataError`, 401 → `InvalidAccessTokenError`, 409 →
`DuplicateDataError`, 429/5xx → Make defaults. 403 depends on the code:

| 403 code | Meaning | Make type |
|---|---|---|
| `insufficient_scope` | key lacks the scope the module needs | `InvalidConfigurationError` (scenario stops) |
| `not_available_in_test_mode` | scope not available for test keys (only `ads:write`; no module uses it) | `InvalidConfigurationError` |
| `ip_not_allowed` | key has an IP allowlist that excludes Make | `InvalidConfigurationError` |
| `account_blocked` | partner account is blocked (every request fails) | `InvalidConfigurationError` |
| `test_mode_only` | *Set a test order status* used with a live key | `InvalidConfigurationError` |
| `orders_write_not_allowed` | live order while the account has < 3 delivered orders and no approval | `DataError` |
| anything else / no code | e.g. a proxy 403 | `DataError` |

Another partner's order is never a 403: it is `404 order_not_found`.

## Validate locally

```bash
npm install          # Ajv only
npm run check        # regenerate app/ from tools/generate.mjs, then validate
```

`tools/validate.mjs` (no network) checks:

- every file is valid JSON;
- every section that has a Make editor schema validates against it (Base, Communication of modules/RPCs/connection,
  attach/detach, static and mappable parameters, interface, samples, groups) with the same Ajv settings as Make's tools;
- cross references: modules/webhooks/RPCs point to the existing connection; instant triggers point to an existing
  webhook; webhook receivers never pass on `data.order`; attach/detach use relative URLs and no own Authorization
  header; every `rpc://` exists and every RPC is used (limit ≤ 300); every `parameters.*` / `connection.*` used in IML
  is declared; every function called in IML is a known built-in or a custom function in `app/functions`; detach reads
  only what attach saved; secrets/Authorization are masked in logs; triggers have static parameters only,
  actions/searches mappable only; searches and polling triggers have `iterate`, `limit` and a Limit field (search:
  optional, default 10, last standard field; polling trigger: required); polling trigger has `response.trigger`;
- output keys ↔ interface (a `{{...}}` spread may supply the rest), date-typed outputs are parsed, sample keys and
  types ↔ interface; every module is in exactly one group;
- custom IML functions define their name and pass their own `test.js` (run with `it` / `assert`, like Make);
- no API keys, webhook secrets, e-mails, IP addresses or full phone numbers in the files.

Current result: 118 JSON files + 2 function files, 94 sections schema-validated, 24 without an editor schema (metadata
files and the two webhook receivers, checked by the rules above), 3 function tests, **0 problems**. This does not execute IML or call the API; see
[Test plan](#test-plan).

## Install in Make (step by step, for the owner)

Make has no supported CLI for this: the VS Code "Make Apps Editor" extension is deprecated, and the alternative is the
Make TypeScript SDK / Apps API (scripting with a Make API key) or Make's AI-agent route. The most practical path for a
one-time setup is the **web editor**: create each component and paste the matching file into the matching tab.
Use a Make organization/team for testing, not the production one.

1. **Create the app.** Make → *Custom Apps* (left menu; may be under *More*) → *Create a new app*. From
   `app/metadata.json`: Name `birinchishop` (Make may add a suffix), Label `Birinchishop`, Description, Theme `#D4AF37`,
   Language English, Audience as offered (Global / Countries: Uzbekistan). Upload `assets/icon-512.png` as the logo.
2. **Base.** App → *Base* tab → replace with `app/base.imljson`. Save.
3. **Connection.** *Connections* → *Create a new connection*: Label `Birinchishop`, Type **API Key** (in the current editor the old "Basic connection" is split into the templates API Key / Basic Auth / Other; all are the same basic type, the template code is replaced anyway). Then:
   *Communication* ← `connections/birinchishop/api.imljson`; *Parameters* ←
   `connections/birinchishop/parameters.imljson`. Note the connection's ID (e.g. `birinchishop` or
   `birinchishop-xxxxx`); if it differs from `birinchishop`, nothing in the files has to change, just pick it below.
4. **Webhooks** (twice: `orderCreated`, `orderStatusChanged`). *Webhooks* → *Create a new webhook*: Label from
   `metadata.json`, Type **Dedicated**, Connection = the connection from step 3. Tabs: *Communication* ←
   `webhooks/<name>/api.imljson`; *Parameters* ← `parameters.imljson` (empty `[]`); *Attach* ← `attach.imljson`;
   *Detach* ← `detach.imljson`. Leave *Update* empty.
5. **RPCs** (`listOffers`, `listLinks`). *Remote procedures* → *Create a new RPC*: Name exactly `listOffers` /
   `listLinks` (the modules reference `rpc://listOffers` and `rpc://listLinks`), Label, Connection. *Communication* ←
   `rpcs/<name>/api.imljson`; *Parameters* ← `parameters.imljson`.
6. **Functions** (`parseDateFields`). Custom IML functions are not enabled by default: ask Make's helpdesk to enable
   them for the app if the *Functions* section is missing. *Functions* → *Create a new function*: Name exactly
   `parseDateFields`; *Code* ← `functions/parseDateFields/code.js`; *Test* ← `functions/parseDateFields/test.js`.
   Create it before saving modules that call it.
7. **Modules** (16). *Modules* → *Create a new module* for each folder in `app/modules/`. Take the **type** from
   `metadata.json` → `typeId`: 1 = Trigger (polling), 4 = Action, 9 = Search, 10 = Instant trigger, 12 = Universal
   module (REST). Name = folder name, Label/Description from `metadata.json`, Connection = step 3, and for instant
   triggers Webhook = `hookName`. Tabs:

   | File | Tab |
   |---|---|
   | `api.imljson` | Communication |
   | `parameters.imljson` | Static parameters |
   | `expect.imljson` | Mappable parameters |
   | `interface.imljson` | Interface |
   | `samples.imljson` | Samples |

   For actions, `metadata.json` → `crud` is the action type (create / read / update) where the form asks for it.
8. **Groups** (ordering in the module picker): arrange modules as in `app/groups.json` (triggers first, then
   Search → Get → Create → Update).
9. Build test scenarios (next section). Keep the app **private** until review.

If you later prefer automation: the same sections can be uploaded with the Make TypeScript SDK (`@makehq/sdk`,
`apps.create` → `setSection` per component) using a Make API key with the custom-app scopes; component types and
the audience value must be taken from your Make account. This folder does not include such a script.

## Test plan

Use a **test key** (`bsk_test_...`) connection for everything that writes:

1. Connection: valid key → label "Name (test key)"; wrong key → error shown.
2. Scenario A: *Watch order status changes* (create the webhook in the module → it appears in Dashboard → API →
   Webhooks). The output shows `api_version` and dates with the date icon.
3. Scenario B (the account needs at least one real tracking link; a test key cannot create one, and Search links
   lists only real links): *Search links* → *Create an order* (test key, a real-looking number in the right format,
   idempotency key) → *Set a test order status* (`delivered`). Scenario A must run with `test: true` and the current
   order. Run *Create an order* again with the same idempotency key → same order returned (`Idempotent-Replayed`).
4. *Create an order* twice with the **Idempotency key empty** (test key, two different phone numbers, or the same
   number to see `duplicate_order`) → no `Idempotency-Key` header in the request log, two different order IDs.
5. Delete scenario A's webhook in Make's Webhooks section → the webhook disappears from the panel (turning the
   scenario off or deleting it is not enough). Do the same with *Watch new orders*.
6. *Watch order events*, *Search orders* / *Search offers* / *Search links* with an empty Limit (or one above 100) so
   the logs show page 2 (pagination), *Search orders* with *Updated since* and *Created from/to*, *Get an order*,
   *Get an offer*, the three reports (with *Date from/to*), *Get my account*, *Make an API call* (`/v1/offers`).
7. One scenario that produces an error on purpose (e.g. *Get an order* with ID 1 → 404 `order_not_found`).

## Review and publishing

Make's prerequisites (from the developer docs, *App review → Prerequisites*), and the state of this app:

| Requirement | State |
|---|---|
| Base and connection sanitize secrets | done (`log.sanitize`) |
| Base and connection error handling | done (message with API code and request ID; 401/403/409 typed) |
| Connection URL fails for wrong credentials | done (`GET /me`) |
| Module labels and descriptions per naming conventions | done, sentence case ("Watch new orders", "Create an order", "Search orders", "Get my account") |
| Universal module | done (`makeApiCall`, URL ends before the API version) |
| Correct interface for every module | done (whole API response spread into the output; validated against samples/output) |
| Dates parsed in outputs and formatted in parameters | done (`parseDate`, custom function `parseDateFields`, `formatDate`) |
| Limit + pagination in searches, triggers and RPCs | done (search Limit optional, default 10; polling trigger Limit required, default 2; RPCs limit 300) |
| Each module used in a test scenario, logs without personal data, an error scenario, pagination visible in logs | **owner** — run right before requesting review (logs expire) |

Then *Request review* from the app page. Open points for review: the `/sandbox/...` module (*Set a test order
status*) may need to be hidden in the public version; webhook signature verification is not possible in Make (see
above) — explain the re-read approach to the reviewer.

## License

MIT. `tools/editor-schemas/` © Celonis, Inc., MIT-style licence (see `tools/editor-schemas/LICENSE.md`).
