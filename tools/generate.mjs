#!/usr/bin/env node
// Generates the Make custom app sections in ../app from the definitions below.
// This file is the source of truth: edit it, run `npm run generate`, then `npm run validate`.
// No network access, no dependencies.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const API = 'https://birinchishop.uz/api/v1';
const API_ROOT = 'https://birinchishop.uz/api'; // universal module: the user's path starts with the version (/v1/...)
const CONNECTION = 'birinchishop';
const UA = 'birinchishop-make/1.0';

const files = new Map();
const put = (path, data) => files.set(path, `${JSON.stringify(data, null, 2)}\n`);

// ─── Dates in the output ──────────────────────────────────────────────
// The API returns timestamps as ISO 8601 UTC strings (e.g. 2026-11-20T09:15:00.000Z) and
// date-only values as YYYY-MM-DD (those stay text). Top-level timestamps are parsed with
// parseDate. Nested ones (inside `order`, `api_key`, `paths[]`) cannot be overridden key by key
// without a custom IML function (not available on our Make plan), so they stay ISO 8601 strings
// and are typed as text in the interface.
const DATE_FMT = 'YYYY-MM-DDTHH:mm:ssZ';
const parsed = (expr) => `{{parseDate(${expr}, '${DATE_FMT}')}}`;
/** Whole object as returned by the API, with its timestamps parsed. */
function withDates(src, dateKeys) {
  const omitted = dateKeys.map((k) => `'${k}'`).join(', ');
  return {
    '{{...}}': `{{omit(${src}, ${omitted})}}`,
    ...Object.fromEntries(dateKeys.map((k) => [k, parsed(`${src}.${k}`)])),
  };
}
/** Optional date parameter → formatted string, or not sent at all when empty. */
const fmtParam = (name, format) => `{{if(parameters.${name}, formatDate(parameters.${name}, '${format}'), undefined)}}`;

// ─── Field helpers (Make parameter definitions) ───────────────────────

const f = (name, type, label, extra = {}) => ({ name, type, label, ...extra });
const text = (name, label, extra) => f(name, 'text', label, extra);
const uint = (name, label, extra) => f(name, 'uinteger', label, extra);
const num = (name, label, extra) => f(name, 'number', label, extra);
const bool = (name, label, extra) => f(name, 'boolean', label, extra);
const date = (name, label, extra) => f(name, 'date', label, extra);
const coll = (name, label, spec, extra) => f(name, 'collection', label, { spec, ...extra });
const arr = (name, label, spec, extra) => f(name, 'array', label, { spec, ...extra });
const opts = (map) => Object.entries(map).map(([value, label]) => ({ label, value }));
// Search modules: optional (empty = all results), default 10. Polling trigger: required, default 2.
const searchLimit = () =>
  uint('limit', 'Limit', { default: 10, validate: { min: 1 }, help: 'Maximum number of bundles this module returns in one execution. Leave empty to return all results.' });
const triggerLimit = () =>
  uint('limit', 'Limit', { required: true, default: 2, validate: { min: 1 }, help: 'Maximum number of bundles this module returns in one execution.' });
// Day filters of the API are calendar days (Asia/Tashkent), sent as YYYY-MM-DD.
const dayParam = (name, label, help) => date(name, label, { help, time: false });

const ORDER_STATUSES = {
  new: 'New (waiting for the call center)',
  processing: 'Processing',
  callback: 'Callback (customer asked to be called later)',
  confirmed: 'Confirmed by phone',
  packed: 'Packed',
  shipping: 'Shipping',
  delivered: 'Delivered (payout earned)',
  returned: 'Returned (refused at delivery)',
  cancelled: 'Canceled (no payout)',
};
const CONVERSIONS = {
  lead: 'Lead (new, processing, callback)',
  approved: 'Approved (confirmed, packed, shipping)',
  sale: 'Sale (delivered)',
  rejected: 'Rejected (returned, canceled)',
};
const SORTS = {
  recommended: 'Recommended',
  best_selling: 'Best selling (highest sale rate)',
  highest_payout: 'Highest payout',
  highest_lead_bonus: 'Highest lead bonus',
  highest_stock: 'Highest stock',
  newest: 'Newest',
};
const LANGS = { uz: 'Uzbek (original)', ru: 'Russian', en: 'English' };
const SOURCES = { link: 'Tracking link', landing: 'Landing page', meta_ads: 'Meta ads', panel: 'Partner panel', api: 'API' };

const offerSelect = (extra = {}) =>
  f('offer_id', 'select', 'Offer', { options: 'rpc://listOffers', mode: 'edit', help: 'In-stock offers are listed; you can also map an offer ID.', ...extra });
const linkSelect = (extra = {}) =>
  f('link_id', 'select', 'Link', { options: 'rpc://listLinks', mode: 'edit', help: 'One of your tracking links; you can also map a link ID.', ...extra });
// `select` stores whatever the user picks or maps; the API validates integers itself.

// ─── Output interfaces ────────────────────────────────────────────────

const ORDER_SPEC = [
  uint('id', 'Order ID'),
  text('status', 'Status'),
  text('conversion_status', 'Conversion status'),
  date('created_at', 'Created at'),
  date('updated_at', 'Updated at'),
  coll('offer', 'Offer', [uint('id', 'Offer ID'), text('name', 'Offer name')]),
  coll('link', 'Link', [uint('id', 'Link ID'), text('name', 'Link name')]),
  coll('variant', 'Variant', [uint('id', 'Variant ID'), text('name', 'Variant name'), uint('type_id', 'Variant type ID'), text('type_name', 'Variant type name')]),
  coll('customer', 'Customer', [text('name', 'Name'), text('phone_masked', 'Phone (masked)'), text('region', 'Region')]),
  num('customer_price', 'Customer price (UZS)'),
  num('payout', 'Payout (UZS)'),
  text('payout_status', 'Payout status'),
  text('currency', 'Currency'),
  text('delivery_date', 'Expected delivery date (YYYY-MM-DD)'),
  text('operator_note', 'Call center note'),
  text('courier_note', 'Courier note'),
  text('source', 'Source'),
  num('sale_chance_percent', 'Sale chance (%)'),
  coll('tracking', 'Tracking', [
    text('click_id', 'Click ID'), text('sub1', 'Sub1'), text('sub2', 'Sub2'), text('sub3', 'Sub3'),
    text('sub4', 'Sub4'), text('sub5', 'Sub5'), text('external_id', 'External ID'),
  ]),
  bool('test', 'Test order (nothing real)'),
  bool('live_orders_allowed', 'Live orders allowed (test keys only)'),
];

// The same order nested in another output (triggers, Set a test order status): its timestamps
// stay ISO 8601 strings, so they are typed as text.
const isoText = (name, label) => text(name, `${label} (ISO 8601, UTC)`);
const NESTED_ORDER_SPEC = ORDER_SPEC.map((p) =>
  p.name === 'created_at' || p.name === 'updated_at' ? isoText(p.name, p.label) : p);

const ORDER_SAMPLE = {
  id: 123456,
  status: 'new',
  conversion_status: 'lead',
  created_at: '2026-11-20T09:15:00.000Z',
  updated_at: '2026-11-20T09:15:00.000Z',
  offer: { id: 512, name: 'Smart watch X8' },
  link: { id: 9001, name: 'Instagram reels' },
  variant: null,
  customer: { name: 'Mijoz 4567', phone_masked: '+998 ** *** 45 67', region: 'Toshkent shahri' },
  customer_price: 199000,
  payout: 50000,
  payout_status: 'pending',
  currency: 'UZS',
  delivery_date: null,
  operator_note: null,
  courier_note: null,
  source: 'api',
  sale_chance_percent: null,
  tracking: { click_id: 'abc123', sub1: 'campaign-1', sub2: null, sub3: null, sub4: null, sub5: null, external_id: 'lead-42' },
};

const OFFER_SPEC = [
  uint('id', 'Offer ID'),
  text('name', 'Name'),
  num('customer_price', 'Customer price (UZS)'),
  bool('customer_price_is_minimum', 'Price is a minimum (variants)'),
  num('payout', 'Payout (UZS)'),
  bool('payout_is_minimum', 'Payout is a minimum (variants)'),
  num('lead_bonus', 'Lead bonus (UZS)'),
  text('currency', 'Currency'),
  bool('in_stock', 'In stock'),
  uint('stock', 'Stock'),
  num('sale_rate_percent', 'Sale rate (%)'),
  text('sale_rate_tier', 'Sale rate tier'),
  text('payment_type', 'Payment type'),
  f('image_url', 'url', 'Image URL'),
  f('video_url', 'url', 'Video URL'),
  bool('has_variants', 'Has variants'),
  date('created_at', 'Created at'),
];
const OFFER_FULL_SPEC = [
  ...OFFER_SPEC,
  text('description', 'Description'),
  arr('images', 'Images', { type: 'url', label: 'Image URL' }),
  arr('variants', 'Variants', {
    type: 'collection',
    label: 'Variant',
    spec: [
      uint('id', 'Variant ID'), text('name', 'Name'), num('customer_price', 'Customer price (UZS)'), num('payout', 'Payout (UZS)'),
      bool('in_stock', 'In stock'), f('image_url', 'url', 'Image URL'),
      arr('types', 'Types', { type: 'collection', label: 'Type', spec: [uint('id', 'Variant type ID'), text('name', 'Name'), bool('in_stock', 'In stock')] }),
    ],
  }),
];
const OFFER_SAMPLE = {
  id: 512,
  name: 'Smart watch X8',
  customer_price: 199000,
  customer_price_is_minimum: false,
  payout: 50000,
  payout_is_minimum: false,
  lead_bonus: 0,
  currency: 'UZS',
  in_stock: true,
  stock: 140,
  sale_rate_percent: 38,
  sale_rate_tier: 'good',
  payment_type: 'after_delivery',
  image_url: 'https://birinchishop.uz/uploads/offers/sample.jpg',
  video_url: null,
  has_variants: false,
  created_at: '2026-10-01T08:00:00.000Z',
};

const LINK_SPEC = [
  uint('id', 'Link ID'),
  text('name', 'Name'),
  uint('offer_id', 'Offer ID'),
  text('offer_name', 'Offer name'),
  bool('offer_active', 'Offer active'),
  f('url', 'url', 'Link URL'),
  text('tracking_url_template', 'Tracking URL template'),
  uint('clicks', 'Clicks'),
  uint('orders', 'Orders'),
  uint('delivered', 'Delivered orders'),
  date('created_at', 'Created at'),
  bool('test', 'Test link (nothing created)'),
];
const LINK_SAMPLE = {
  id: 9001,
  name: 'Instagram reels',
  offer_id: 512,
  offer_name: 'Smart watch X8',
  offer_active: true,
  url: 'https://birinchishop.uz/l/AbC123',
  tracking_url_template: 'https://birinchishop.uz/l/AbC123?click_id={click_id}&sub1={sub1}&sub2={sub2}&sub3={sub3}&sub4={sub4}&sub5={sub5}',
  clicks: 0,
  orders: 0,
  delivered: 0,
  created_at: '2026-11-20T09:00:00.000Z',
};

const STATS_ROW = [
  text('date', 'Date'), uint('offer_id', 'Offer ID'), text('offer_name', 'Offer name'), uint('link_id', 'Link ID'), text('link_name', 'Link name'),
];
const STATS_NUMBERS = [
  uint('orders', 'Orders'), uint('approved', 'Approved'), uint('delivered', 'Delivered'), uint('rejected', 'Rejected'), uint('pending', 'Pending'),
  num('approval_rate_percent', 'Approval rate (%)'), num('delivery_rate_percent', 'Delivery rate (%)'),
  num('earned', 'Earned (UZS)'), num('potential_earnings', 'Potential earnings (UZS)'),
  uint('clicks', 'Clicks (bots excluded)'), uint('unique_clicks', 'Unique clicks'),
];

const windowsSpec = (label) =>
  coll('delivered_within_days', label, ['3', '7', '14', '30'].map((d) =>
    coll(d, `Within ${d} days`, [uint('delivered', 'Delivered'), num('rate_percent', 'Rate (%)'), uint('orders', 'Orders (average only)')])));

// ─── Common request parts ─────────────────────────────────────────────

const SANITIZE = ['request.headers.authorization'];
const pagePagination = {
  qs: { page: '{{pagination.page}}' },
  condition: '{{body.meta.page < body.meta.total_pages}}',
};

// ─── App-level sections ───────────────────────────────────────────────

put('metadata.json', {
  name: 'birinchishop',
  label: 'Birinchishop',
  description: 'Birinchishop is a cash-on-delivery CPA affiliate network in Uzbekistan: partners promote products and earn a fixed payout for every delivered order.',
  theme: '#D4AF37',
  language: 'en',
  countries: ['uz'],
  website: 'https://birinchishop.uz',
  docs: 'https://birinchishop.uz/api/v1/docs',
  private: true,
});

// Error text: the API always answers { error: { code, message }, request_id }; a proxy error
// (e.g. 502) has no such body, so every part has a fallback.
const ERR_MSG = "{{ifempty(body.error.message, 'Unexpected response')}}";
const ERR_CODE = "{{ifempty(body.error.code, 'none')}}";
const ERR_REQ = "{{ifempty(body.request_id, 'none')}}";
const errText = (status) => `[${status}] ${ERR_MSG} (code: ${ERR_CODE}, request ID: ${ERR_REQ})`;
// 403 codes that mean the key/account setup is wrong for EVERY run (scenario should stop);
// any other 403 (orders_write_not_allowed, or an unknown/proxy 403) concerns this request only.
const CONFIG_403 = ['insufficient_scope', 'not_available_in_test_mode', 'ip_not_allowed', 'account_blocked', 'test_mode_only'];
const type403 = `{{if(${CONFIG_403.map((c) => `body.error.code === '${c}'`).join(' || ')}, 'InvalidConfigurationError', 'DataError')}}`;

put('base.imljson', {
  baseUrl: API,
  headers: {
    Authorization: 'Bearer {{connection.apiKey}}',
    Accept: 'application/json',
    'User-Agent': UA,
  },
  response: {
    error: {
      message: errText('{{statusCode}}'),
      400: { type: 'DataError', message: errText(400) },
      401: { type: 'InvalidAccessTokenError', message: `[401] ${ERR_MSG} (code: ${ERR_CODE}). Check or recreate the API key in Dashboard → API.` },
      403: { type: type403, message: `${errText(403)}. For insufficient_scope, grant the scope to the key in Dashboard → API.` },
      409: { type: 'DuplicateDataError', message: `${errText(409)}. Do not retry this request.` },
    },
  },
  log: { sanitize: SANITIZE },
});

// Within a group: triggers (instant first), then Search → Get → Create → Update.
put('groups.json', [
  { label: 'Orders', modules: ['watchNewOrders', 'watchOrderStatusChanges', 'watchOrderEvents', 'searchOrders', 'getOrder', 'createOrder', 'setTestOrderStatus'] },
  { label: 'Links', modules: ['searchLinks', 'createLink'] },
  { label: 'Offers', modules: ['searchOffers', 'getOffer'] },
  { label: 'Reports', modules: ['getStatistics', 'getCohortReport', 'getAttributionReport', 'getAccount'] },
  { label: 'Other', modules: ['makeApiCall'] },
]);

// ─── Connection ───────────────────────────────────────────────────────

put(`connections/${CONNECTION}/metadata.json`, { type: 'basic', label: 'Birinchishop' });
put(`connections/${CONNECTION}/parameters.imljson`, [
  f('apiKey', 'password', 'API key', {
    required: true,
    help:
      'Create a key in the [Birinchishop partner panel](https://birinchishop.uz/dashboard/api) (Dashboard → API) and grant `account:read` plus the scopes your scenarios use (`webhooks:manage` for instant triggers). ' +
      'A live key (`bsk_live_...`) acts on your real account: **Create an order submits a REAL order** that a call center phones. ' +
      'A test key (`bsk_test_...`) reads real data but creates nothing — use it while building scenarios. Do not set an IP allowlist on a key used in Make.',
  }),
]);
put(`connections/${CONNECTION}/api.imljson`, {
  url: `${API}/me`,
  method: 'GET',
  headers: { Authorization: 'Bearer {{parameters.apiKey}}', Accept: 'application/json', 'User-Agent': UA },
  response: {
    metadata: { type: 'text', value: '{{body.data.name}} ({{body.data.api_key.mode}} key)' },
    error: { message: `[{{statusCode}}] ${ERR_MSG} (code: ${ERR_CODE})` },
  },
  log: { sanitize: SANITIZE },
});

// ─── Webhooks (dedicated, attached) ───────────────────────────────────

/**
 * The webhook receiver passes on the whole payload EXCEPT the unverified order body
 * (`data.order`): the instant trigger re-reads the order from the API with the user's key.
 * `condition` drops the panel's synthetic "Send test" request (order id 0).
 * attach/detach inherit the base URL, Authorization header and its log sanitization from the Base.
 */
function webhook(name, label, eventType) {
  put(`webhooks/${name}/metadata.json`, { type: 'web', label, accountName: CONNECTION });
  put(`webhooks/${name}/parameters.imljson`, []);
  put(`webhooks/${name}/attach.imljson`, {
    url: '/webhooks',
    method: 'POST',
    type: 'json',
    body: { url: '{{webhook.url}}', kind: 'json', events: [eventType], description: `Make: ${label}` },
    response: {
      data: { externalHookId: '{{body.data.id}}', secret: '{{body.data.secret}}' },
      error: { message: `[{{statusCode}}] ${ERR_MSG} (code: ${ERR_CODE}). The account can have at most 10 webhooks; remove unused ones in Dashboard → API → Webhooks.` },
    },
    log: { sanitize: ['request.body.url', 'response.body.data.secret', 'response.body.data.url'] },
  });
  put(`webhooks/${name}/detach.imljson`, {
    url: '/webhooks/{{webhook.externalHookId}}',
    method: 'DELETE',
  });
  put(`webhooks/${name}/api.imljson`, {
    condition: `{{body.type === '${eventType}' && body.data.order_id > 0}}`,
    respond: { status: 200, type: 'json', body: { received: true } },
    output: {
      '{{...}}': "{{omit(body, 'data')}}",
      data: "{{omit(body.data, 'order')}}",
    },
  });
}
webhook('orderCreated', 'Birinchishop: order created', 'order.created');
webhook('orderStatusChanged', 'Birinchishop: order status changed', 'order.status_changed');

// ─── RPCs (dropdowns) ─────────────────────────────────────────────────

put('rpcs/listOffers/metadata.json', { label: 'List offers', accountName: CONNECTION });
put('rpcs/listOffers/parameters.imljson', []);
put('rpcs/listOffers/api.imljson', {
  url: '/offers',
  method: 'GET',
  qs: { in_stock_only: 'true', sort: 'recommended', limit: 100, page: 1 },
  response: {
    iterate: '{{body.data}}',
    limit: 300,
    output: { label: '{{item.name}} — payout {{item.payout}} UZS (#{{item.id}})', value: '{{item.id}}' },
  },
  pagination: pagePagination,
});

put('rpcs/listLinks/metadata.json', { label: 'List links', accountName: CONNECTION });
put('rpcs/listLinks/parameters.imljson', []);
put('rpcs/listLinks/api.imljson', {
  url: '/links',
  method: 'GET',
  qs: { limit: 100, page: 1 },
  response: {
    iterate: '{{body.data}}',
    limit: 300,
    output: { label: '{{item.name}} — {{item.offer_name}} (#{{item.id}})', value: '{{item.id}}' },
  },
  pagination: pagePagination,
});

// ─── Modules ──────────────────────────────────────────────────────────

const TYPE = { trigger: 1, action: 4, search: 9, instant: 10, universal: 12 };

function module(name, { type, crud = null, label, description, hookName = null, api, parameters = [], expect = [], interface: iface, samples, epoch }) {
  put(`modules/${name}/metadata.json`, {
    label, description, typeId: TYPE[type], crud, accountName: CONNECTION, hookName, public: true,
  });
  put(`modules/${name}/api.imljson`, api);
  put(`modules/${name}/parameters.imljson`, parameters);
  put(`modules/${name}/expect.imljson`, expect);
  put(`modules/${name}/interface.imljson`, iface);
  put(`modules/${name}/samples.imljson`, samples);
  if (epoch) put(`modules/${name}/epoch.imljson`, epoch);
}

// Instant triggers: one enrichment request re-reads the order with the user's key.
// The webhook payload is spread into the output (api_version and any field added later),
// except `id`, `created_at`, `test` and `data`, which keep their established output names below.
// The order itself (and its current status) always comes from the authenticated API response.
const INSTANT_SPEC = [
  text('event_id', 'Event ID'),
  text('type', 'Event type'),
  text('api_version', 'API version'),
  date('event_created_at', 'Event time'),
  uint('order_id', 'Order ID'),
  text('event_status', 'Status in the event'),
  text('event_conversion_status', 'Conversion status in the event'),
  text('previous_status', 'Previous status'),
  text('status', 'Current status'),
  text('conversion_status', 'Current conversion status'),
  bool('test', 'Test event'),
  coll('order', 'Order (current, read from the API)', NESTED_ORDER_SPEC),
];
const instantApi = {
  url: '/orders/{{payload.data.order_id}}',
  method: 'GET',
  response: {
    output: {
      '{{...}}': "{{omit(payload, 'id', 'created_at', 'test', 'data')}}",
      event_id: '{{payload.id}}',
      event_created_at: parsed('payload.created_at'),
      order_id: '{{payload.data.order_id}}',
      event_status: '{{payload.data.status}}',
      event_conversion_status: '{{payload.data.conversion_status}}',
      previous_status: '{{payload.data.previous_status}}',
      status: '{{body.data.status}}',
      conversion_status: '{{body.data.conversion_status}}',
      test: '{{payload.test === true}}',
      order: '{{body.data}}',
    },
  },
};
const instantBanner = {
  name: 'about',
  type: 'banner',
  title: 'Instant trigger',
  text: 'Creating the webhook registers it on your account (API key scope `webhooks:manage`, at most 10 per account). To remove the registration, delete the webhook in Make\'s Webhooks section. Each event is re-read from the API with your key before it reaches the scenario.',
};

module('watchNewOrders', {
  type: 'instant',
  label: 'Watch new orders',
  description: 'Triggers when a new order arrives on your account.',
  hookName: 'orderCreated',
  api: instantApi,
  parameters: [instantBanner],
  interface: INSTANT_SPEC,
  samples: {
    event_id: 'evt_778899', type: 'order.created', api_version: 'v1', event_created_at: '2026-11-20T09:15:00.000Z', order_id: 123456,
    event_status: 'new', event_conversion_status: 'lead', previous_status: null, status: 'new', conversion_status: 'lead', test: false, order: ORDER_SAMPLE,
  },
});

module('watchOrderStatusChanges', {
  type: 'instant',
  label: 'Watch order status changes',
  description: 'Triggers when an order moves to another status (confirmed, shipping, delivered, returned, canceled...).',
  hookName: 'orderStatusChanged',
  api: instantApi,
  parameters: [instantBanner],
  interface: INSTANT_SPEC,
  samples: {
    event_id: 'evt_778950', type: 'order.status_changed', api_version: 'v1', event_created_at: '2026-11-22T14:02:00.000Z', order_id: 123456,
    event_status: 'delivered', event_conversion_status: 'sale', previous_status: 'shipping', status: 'delivered', conversion_status: 'sale', test: false,
    order: { ...ORDER_SAMPLE, status: 'delivered', conversion_status: 'sale', updated_at: '2026-11-22T14:02:00.000Z' },
  },
});

const EVENT_SPEC = [
  uint('id', 'Event ID'),
  text('type', 'Event type'),
  date('created_at', 'Event time'),
  uint('order_id', 'Order ID'),
  text('status', 'Status'),
  text('previous_status', 'Previous status'),
  text('conversion_status', 'Conversion status'),
  coll('order', 'Order', NESTED_ORDER_SPEC),
];
const EVENT_SAMPLE = {
  id: 778950, type: 'order.status_changed', created_at: '2026-11-22T14:02:00.000Z', order_id: 123456,
  status: 'delivered', previous_status: 'shipping', conversion_status: 'sale',
  order: { ...ORDER_SAMPLE, status: 'delivered', conversion_status: 'sale' },
};
const eventTypeParam = f('type', 'select', 'Event type', {
  options: opts({ 'order.created': 'Order created', 'order.status_changed': 'Order status changed' }),
  help: 'Leave empty for both.',
});

// GET /events supports only ascending order with an `after` cursor (no descending order).
// The cursor is the last processed event ID (data.lastId), so every request returns only
// events newer than the last run: the 3200-record limit of ascending order does not apply.
module('watchOrderEvents', {
  type: 'trigger',
  crud: 'read',
  label: 'Watch order events',
  description: 'Triggers when an order is created or changes status (polling the event feed; no webhook needed).',
  api: {
    url: '/events',
    method: 'GET',
    qs: { after: '{{data.lastId}}', limit: 200, include_order: 'true', type: '{{parameters.type}}' },
    response: {
      iterate: '{{body.data}}',
      limit: '{{parameters.limit}}',
      trigger: { id: '{{item.id}}', type: 'id', order: 'asc' },
      output: withDates('item', ['created_at']),
    },
    pagination: {
      qs: { after: '{{body.meta.next_cursor}}' },
      condition: '{{body.meta.has_more}}',
    },
  },
  parameters: [
    eventTypeParam,
    triggerLimit(),
    {
      name: 'about',
      type: 'banner',
      title: 'Event feed',
      text: 'Reads `GET /events` oldest first and continues after the last event this module processed, so each run gets only newer events (at most Limit per run). The feed keeps 90 days; the first run starts at the oldest kept event. Needs the `events:read` and `orders:read` scopes. Prefer the instant triggers when your key can manage webhooks.',
    },
  ],
  interface: EVENT_SPEC,
  samples: EVENT_SAMPLE,
});

module('createOrder', {
  type: 'action',
  crud: 'create',
  label: 'Create an order',
  description: 'Creates a REAL cash-on-delivery order for a customer who asked to buy; a call center phones them. Test keys create nothing.',
  api: {
    url: '/orders',
    method: 'POST',
    type: 'json',
    // The header is not sent at all when the field is empty (no key = no idempotency).
    headers: { 'Idempotency-Key': '{{ifempty(parameters.idempotency_key, undefined)}}' },
    // Parameter names are the API's body keys; the banner is never submitted.
    body: { '{{...}}': "{{omit(parameters, 'idempotency_key')}}" },
    response: { output: withDates('body.data', ['created_at', 'updated_at']) },
  },
  expect: [
    {
      name: 'warning',
      type: 'banner',
      title: 'This creates a REAL order',
      text:
        'With a live key a call center phones the customer and a courier delivers the product (cash on delivery). Send only real customers who asked to order, with their correct phone number. ' +
        '**Never send test, sample or fake orders — the account gets blocked.** Build and test with a test key (`bsk_test_...`): it runs every check but creates nothing.',
    },
    linkSelect({ required: true, mode: undefined, help: 'Your tracking link for the offer; it decides the offer and your payout.' }),
    text('phone', 'Customer phone', { required: true, validate: { pattern: '^[+0-9 ()-]{9,20}$' }, help: 'Uzbekistan mobile number, e.g. `+998901234567`.' }),
    text('name', 'Customer name', { validate: { max: 100 }, help: 'Default: "Mijoz" plus the last 4 digits of the phone.' }),
    text('region', 'Region', { validate: { max: 64 } }),
    uint('variant_id', 'Variant ID', { help: 'For offers with variants (see Get an offer → Variants).' }),
    uint('variant_type_id', 'Variant type ID', { help: 'Required when the chosen variant has types (e.g. size).' }),
    text('external_id', 'External ID', { validate: { pattern: '^[A-Za-z0-9._:-]*$', max: 128 }, help: 'Your own lead ID; returned in events and searchable.' }),
    text('click_id', 'Click ID', { validate: { max: 255 }, help: 'Tracker click ID; returned in events and postbacks.' }),
    text('sub1', 'Sub1', { advanced: true }),
    text('sub2', 'Sub2', { advanced: true }),
    text('sub3', 'Sub3', { advanced: true }),
    text('sub4', 'Sub4', { advanced: true }),
    text('sub5', 'Sub5', { advanced: true }),
    text('idempotency_key', 'Idempotency key', {
      validate: { pattern: '^[A-Za-z0-9._:-]*$', max: 128 },
      help: 'Strongly recommended: map a stable unique value (lead ID, row ID). Sending the same key again returns the existing order instead of creating a second one, so retries are safe. Left empty, no key is sent and every run creates a new order.',
    }),
  ],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('getOrder', {
  type: 'action',
  crud: 'read',
  label: 'Get an order',
  description: 'Gets an order by ID. The customer phone is always masked.',
  api: { url: '/orders/{{parameters.order_id}}', method: 'GET', response: { output: withDates('body.data', ['created_at', 'updated_at']) } },
  expect: [uint('order_id', 'Order ID', { required: true, help: 'Test orders (test keys) are kept for 24 hours.' })],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('searchOrders', {
  type: 'search',
  crud: 'read',
  label: 'Search orders',
  description: 'Searches your orders by status, dates, offer, link, external ID or click ID.',
  api: {
    url: '/orders',
    method: 'GET',
    qs: {
      status: '{{parameters.status}}',
      conversion_status: '{{parameters.conversion_status}}',
      date_from: fmtParam('date_from', 'YYYY-MM-DD'),
      date_to: fmtParam('date_to', 'YYYY-MM-DD'),
      updated_since: fmtParam('updated_since', DATE_FMT),
      offer_id: '{{parameters.offer_id}}',
      link_id: '{{parameters.link_id}}',
      external_id: '{{parameters.external_id}}',
      click_id: '{{parameters.click_id}}',
      limit: 100,
      page: 1,
    },
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: withDates('item', ['created_at', 'updated_at']) },
    pagination: pagePagination,
  },
  expect: [
    f('status', 'select', 'Status', { options: opts(ORDER_STATUSES) }),
    f('conversion_status', 'select', 'Conversion status', { options: opts(CONVERSIONS), help: 'Ignored when Status is set.' }),
    dayParam('date_from', 'Created from', 'First day (Asia/Tashkent); only the date part is used.'),
    dayParam('date_to', 'Created to', 'Last day (Asia/Tashkent); only the date part is used.'),
    date('updated_since', 'Updated since', { help: 'Only orders updated after this time; results are then sorted by update time (oldest first).' }),
    offerSelect({ mode: undefined }),
    linkSelect({ mode: undefined }),
    text('external_id', 'External ID'),
    text('click_id', 'Click ID'),
    searchLimit(),
  ],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('setTestOrderStatus', {
  type: 'action',
  crud: 'update',
  label: 'Set a test order status',
  description: 'Moves a test order (bsk_test_ key) to another status and sends a signed test event to your webhooks. Works only with test keys.',
  api: {
    url: '/sandbox/orders/{{parameters.order_id}}/status',
    method: 'POST',
    type: 'json',
    body: { status: '{{parameters.status}}' },
    response: { output: '{{body.data}}' },
  },
  expect: [
    uint('order_id', 'Test order ID', { required: true, help: 'ID returned by Create an order with a test key (≥ 2000000000).' }),
    f('status', 'select', 'New status', { required: true, default: 'delivered', options: opts(Object.fromEntries(Object.entries(ORDER_STATUSES).filter(([k]) => k !== 'new'))) }),
  ],
  interface: [
    coll('order', 'Order', NESTED_ORDER_SPEC),
    text('previous_status', 'Previous status'),
    coll('webhooks', 'Webhooks', [uint('matched', 'Matched'), uint('sent', 'Sent'), uint('skipped_rate_limit', 'Skipped (rate limit)')]),
  ],
  samples: {
    order: { ...ORDER_SAMPLE, id: 2000000123, status: 'delivered', conversion_status: 'sale', payout_status: 'earned', test: true },
    previous_status: 'new',
    webhooks: { matched: 1, sent: 1, skipped_rate_limit: 0 },
  },
});

module('createLink', {
  type: 'action',
  crud: 'create',
  label: 'Create a link',
  description: 'Creates a tracking link for an offer. Test keys create nothing.',
  api: {
    url: '/links',
    method: 'POST',
    type: 'json',
    body: { offer_id: '{{parameters.offer_id}}', name: '{{parameters.name}}' },
    response: { output: withDates('body.data', ['created_at']) },
  },
  expect: [offerSelect({ required: true, mode: undefined }), text('name', 'Link name', { validate: { max: 100 }, help: 'Your label, e.g. "Instagram reels".' })],
  interface: LINK_SPEC,
  samples: LINK_SAMPLE,
});

module('searchLinks', {
  type: 'search',
  crud: 'read',
  label: 'Search links',
  description: 'Lists your tracking links, optionally for one offer (newest first).',
  api: {
    url: '/links',
    method: 'GET',
    qs: { offer_id: '{{parameters.offer_id}}', limit: 100, page: 1 },
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: withDates('item', ['created_at']) },
    pagination: pagePagination,
  },
  expect: [offerSelect({ mode: undefined }), searchLimit()],
  interface: LINK_SPEC,
  samples: LINK_SAMPLE,
});

module('getOffer', {
  type: 'action',
  crud: 'read',
  label: 'Get an offer',
  description: 'Gets an offer with its description, images and variants.',
  api: { url: '/offers/{{parameters.offer_id}}', method: 'GET', qs: { lang: '{{parameters.lang}}' }, response: { output: withDates('body.data', ['created_at']) } },
  expect: [offerSelect({ required: true }), f('lang', 'select', 'Language of name and description', { options: opts(LANGS), default: 'uz' })],
  interface: OFFER_FULL_SPEC,
  samples: { ...OFFER_SAMPLE, description: 'Waterproof smart watch...', images: [OFFER_SAMPLE.image_url], variants: [] },
});

module('searchOffers', {
  type: 'search',
  crud: 'read',
  label: 'Search offers',
  description: 'Searches offers by name, payout, sale rate and stock.',
  api: {
    url: '/offers',
    method: 'GET',
    qs: {
      search: '{{parameters.search}}',
      in_stock_only: '{{parameters.in_stock_only}}',
      min_payout: '{{parameters.min_payout}}',
      min_sale_rate: '{{parameters.min_sale_rate}}',
      sort: '{{parameters.sort}}',
      lang: '{{parameters.lang}}',
      limit: 100,
      page: 1,
    },
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: withDates('item', ['created_at']) },
    pagination: pagePagination,
  },
  expect: [
    text('search', 'Name contains', { validate: { max: 100 }, help: 'Uzbek, Russian or English; typos are tolerated.' }),
    bool('in_stock_only', 'In stock only', { default: true }),
    uint('min_payout', 'Minimum payout (UZS)'),
    uint('min_sale_rate', 'Minimum sale rate (%)', { validate: { min: 0, max: 100 } }),
    f('sort', 'select', 'Sort', { options: opts(SORTS), default: 'recommended' }),
    f('lang', 'select', 'Language of names', { options: opts(LANGS), default: 'uz' }),
    searchLimit(),
  ],
  interface: OFFER_SPEC,
  samples: OFFER_SAMPLE,
});

module('getStatistics', {
  type: 'action',
  crud: 'read',
  label: 'Get statistics',
  description: 'Gets orders, approvals, deliveries, earnings and clicks for a period (default: last 30 days), with rows per day, offer or link.',
  api: {
    url: '/stats',
    method: 'GET',
    qs: {
      group_by: '{{parameters.group_by}}',
      date_from: fmtParam('date_from', 'YYYY-MM-DD'),
      date_to: fmtParam('date_to', 'YYYY-MM-DD'),
      offer_id: '{{parameters.offer_id}}',
      link_id: '{{parameters.link_id}}',
    },
    // meta (group_by, dates, timezone, currency, clicks_since, totals) as returned; clicks_since is a
    // date only (YYYY-MM-DD), so it stays text.
    response: { output: { '{{...}}': '{{body.meta}}', rows: '{{body.data}}' } },
  },
  expect: [
    f('group_by', 'select', 'Group rows by', { required: true, default: 'day', options: opts({ day: 'Day', offer: 'Offer', link: 'Link' }) }),
    dayParam('date_from', 'Date from', 'First day (Asia/Tashkent); only the date part is used. Default: 29 days before Date to. Max range 366 days.'),
    dayParam('date_to', 'Date to', 'Last day (Asia/Tashkent); only the date part is used. Default: today.'),
    offerSelect({ mode: undefined, help: 'Only this offer.' }),
    linkSelect({ mode: undefined, help: 'Only this link.' }),
  ],
  interface: [
    text('group_by', 'Grouped by'), text('date_from', 'Date from'), text('date_to', 'Date to'), text('timezone', 'Time zone'),
    text('currency', 'Currency'), text('clicks_since', 'Click tracking since (YYYY-MM-DD)'),
    coll('totals', 'Totals', STATS_NUMBERS),
    arr('rows', 'Rows', { type: 'collection', label: 'Row', spec: [...STATS_ROW, ...STATS_NUMBERS] }),
  ],
  samples: {
    group_by: 'day', date_from: '2026-10-22', date_to: '2026-11-20', timezone: 'Asia/Tashkent', currency: 'UZS', clicks_since: '2026-11-18',
    totals: { orders: 40, approved: 22, delivered: 15, rejected: 12, pending: 6, approval_rate_percent: 55, delivery_rate_percent: 38, earned: 750000, potential_earnings: 350000, clicks: 1200, unique_clicks: 950 },
    rows: [{ date: '2026-11-20', orders: 2, approved: 1, delivered: 0, rejected: 0, pending: 1, approval_rate_percent: 50, delivery_rate_percent: 0, earned: 0, potential_earnings: 100000, clicks: 60, unique_clicks: 48 }],
  },
});

module('getCohortReport', {
  type: 'action',
  crud: 'read',
  label: 'Get a cohort report',
  description: 'Gets weekly order cohorts and the share delivered within 3, 7, 14 and 30 days.',
  api: {
    url: '/stats/cohorts',
    method: 'GET',
    qs: { weeks: '{{parameters.weeks}}', offer_id: '{{parameters.offer_id}}', link_id: '{{parameters.link_id}}', source: '{{parameters.source}}' },
    response: { output: { '{{...}}': '{{body.meta}}', cohorts: '{{body.data}}' } },
  },
  expect: [
    uint('weeks', 'Weeks', { default: 12, validate: { min: 1, max: 52 } }),
    offerSelect({ mode: undefined, help: 'Only this offer.' }),
    linkSelect({ mode: undefined, help: 'Only this link.' }),
    f('source', 'select', 'Order source', { options: opts(SOURCES) }),
  ],
  interface: [
    uint('weeks', 'Weeks'), text('date_from', 'Date from'), text('date_to', 'Date to'), text('timezone', 'Time zone'), text('week_starts_on', 'Week starts on'),
    coll('totals', 'Totals', [uint('orders', 'Orders'), uint('delivered', 'Delivered'), num('delivered_rate_percent', 'Delivered rate (%)'), uint('in_progress', 'In progress')]),
    { ...windowsSpec('Average (complete cohorts only)'), name: 'average' },
    arr('cohorts', 'Cohorts', {
      type: 'collection',
      label: 'Cohort',
      spec: [
        text('week_start', 'Week start'), text('week_end', 'Week end'), bool('complete', 'Week complete'),
        uint('orders', 'Orders'), uint('delivered', 'Delivered'), num('delivered_rate_percent', 'Delivered rate (%)'), uint('in_progress', 'In progress'),
        windowsSpec('Delivered within (empty = not enough time passed)'),
      ],
    }),
  ],
  samples: {
    weeks: 12, date_from: '2026-08-31', date_to: '2026-11-22', timezone: 'Asia/Tashkent', week_starts_on: 'monday',
    totals: { orders: 300, delivered: 96, delivered_rate_percent: 32, in_progress: 20 },
    average: { 3: { delivered: 40, rate_percent: 14 }, 7: { delivered: 80, rate_percent: 28 }, 14: { delivered: 90, rate_percent: 31 }, 30: { delivered: 94, rate_percent: 32 } },
    cohorts: [{
      week_start: '2026-11-02', week_end: '2026-11-08', complete: true, orders: 25, delivered: 8, delivered_rate_percent: 32, in_progress: 1,
      delivered_within_days: { 3: { delivered: 3, rate_percent: 12 }, 7: { delivered: 7, rate_percent: 28 }, 14: { delivered: 8, rate_percent: 32 }, 30: null },
    }],
  },
});

const STEP_SPEC = [
  isoText('at', 'Time'), text('role', 'Role (first, last, assist, only)'), text('partner', 'Partner (you / other)'), text('kind', 'Kind (link / landing)'),
  uint('link_id', 'Link ID'), text('link_name', 'Link name'), text('landing', 'Landing'), text('source', 'Source'),
  text('utm_source', 'UTM source'), text('utm_medium', 'UTM medium'), text('utm_campaign', 'UTM campaign'),
];
module('getAttributionReport', {
  type: 'action',
  crud: 'read',
  label: 'Get an attribution report',
  description: 'Gets the multi-touch attribution report: which of your links were first, last or assisting touches before orders (report only; payouts are not affected).',
  api: {
    url: '/stats/attribution',
    method: 'GET',
    qs: { date_from: fmtParam('date_from', 'YYYY-MM-DD'), date_to: fmtParam('date_to', 'YYYY-MM-DD') },
    // body.data as returned (tracking_since is a date only; paths[].ordered_at and paths[].steps[].at
    // are nested ISO 8601 strings, typed as text). The three meta fields are added by name.
    response: {
      output: {
        '{{...}}': '{{body.data}}',
        date_from: '{{body.meta.date_from}}',
        date_to: '{{body.meta.date_to}}',
        timezone: '{{body.meta.timezone}}',
      },
    },
  },
  expect: [
    dayParam('date_from', 'Date from', 'First day (Asia/Tashkent); only the date part is used. Default: 29 days before Date to.'),
    dayParam('date_to', 'Date to', 'Last day (Asia/Tashkent); only the date part is used. Default: today.'),
  ],
  interface: [
    text('date_from', 'Date from'), text('date_to', 'Date to'), text('timezone', 'Time zone'), text('tracking_since', 'Tracking since (YYYY-MM-DD)'), uint('lookback_days', 'Lookback (days)'),
    coll('summary', 'Summary', [
      uint('orders', 'Orders'), uint('converted_by_you', 'Converted by you'), uint('multi_touch', 'Multi-touch orders'),
      uint('with_other_partners', 'With other partners'), uint('assisted_for_other_partners', 'Assisted for other partners'),
    ]),
    arr('links', 'Links', {
      type: 'collection', label: 'Link',
      spec: [
        uint('link_id', 'Link ID'), text('link_name', 'Link name'), uint('first_touch_orders', 'First touch'), uint('last_touch_orders', 'Last touch'),
        uint('assist_orders', 'Assist'), uint('single_touch_orders', 'Single touch'), uint('converted_orders', 'Converted'),
      ],
    }),
    arr('paths', 'Sample paths', {
      type: 'collection', label: 'Path',
      spec: [
        uint('order_id', 'Order ID'), bool('yours', 'Your order'), text('status', 'Status'), uint('offer_id', 'Offer ID'), text('offer_name', 'Offer name'),
        isoText('ordered_at', 'Ordered at'), arr('steps', 'Steps', { type: 'collection', label: 'Step', spec: STEP_SPEC }),
      ],
    }),
  ],
  samples: {
    date_from: '2026-10-22', date_to: '2026-11-20', timezone: 'Asia/Tashkent', tracking_since: '2026-11-18', lookback_days: 30,
    summary: { orders: 40, converted_by_you: 38, multi_touch: 5, with_other_partners: 2, assisted_for_other_partners: 1 },
    links: [{ link_id: 9001, link_name: 'Instagram reels', first_touch_orders: 10, last_touch_orders: 12, assist_orders: 2, single_touch_orders: 20, converted_orders: 30 }],
    paths: [],
  },
});

module('getAccount', {
  type: 'action',
  crud: 'read',
  label: 'Get my account',
  description: 'Gets your partner account: balance, frozen balance, minimum withdrawal and the API key mode (live or test).',
  api: { url: '/me', method: 'GET', response: { output: withDates('body.data', ['created_at']) } },
  interface: [
    uint('id', 'Account ID'), text('name', 'Name'), text('status', 'Status'), num('balance', 'Balance (UZS)'), num('balance_frozen', 'Frozen balance (UZS)'),
    num('min_withdrawal', 'Minimum withdrawal (UZS)'), text('currency', 'Currency'), date('created_at', 'Created at'),
    coll('api_key', 'API key', [text('name', 'Name'), text('mode', 'Mode (live / test)'), arr('scopes', 'Scopes', { type: 'text' }), isoText('expires_at', 'Expires at')]),
  ],
  samples: {
    id: 1001, name: 'Partner name', status: 'active', balance: 350000, balance_frozen: 0, min_withdrawal: 50000, currency: 'UZS', created_at: '2026-06-01T10:00:00.000Z',
    api_key: { name: 'Make', mode: 'live', scopes: ['account:read', 'orders:read'], expires_at: null },
  },
});

module('makeApiCall', {
  type: 'universal',
  label: 'Make an API call',
  description: 'Performs an arbitrary authorized API call.',
  api: {
    // Ends before the API version, so any version can be called; Base headers, errors and sanitization still apply.
    url: `${API_ROOT}/{{parameters.url}}`,
    method: '{{parameters.method}}',
    headers: { '{{...}}': "{{toCollection(parameters.headers, 'key', 'value')}}" },
    qs: { '{{...}}': "{{toCollection(parameters.qs, 'key', 'value')}}" },
    body: '{{parameters.body}}',
    type: 'text',
    response: { output: { body: '{{body}}', headers: '{{headers}}', statusCode: '{{statusCode}}' } },
  },
  expect: [
    text('url', 'URL', {
      required: true,
      help: 'Enter a path relative to `https://birinchishop.uz/api`. For example: `/v1/offers`. See https://birinchishop.uz/api/v1/docs. Note: `POST /v1/orders` with a live key creates a REAL order.',
    }),
    f('method', 'select', 'Method', { required: true, default: 'GET', options: opts({ GET: 'GET', POST: 'POST', PATCH: 'PATCH', DELETE: 'DELETE' }) }),
    arr('headers', 'Headers', [text('key', 'Key'), text('value', 'Value')], {
      default: [{ key: 'Content-Type', value: 'application/json' }],
      help: "You don't have to add authorization headers; we already did that for you.",
    }),
    arr('qs', 'Query string', [text('key', 'Key'), text('value', 'Value')]),
    f('body', 'any', 'Body', { help: 'JSON text for POST/PATCH.' }),
  ],
  interface: [f('body', 'any', 'Body'), coll('headers', 'Headers', []), num('statusCode', 'Status code')],
  samples: { body: { data: { id: 1001, name: 'Partner name' }, request_id: 'req_sample' }, headers: { 'content-type': 'application/json' }, statusCode: 200 },
});

// ─── Write ────────────────────────────────────────────────────────────

/** Drops `undefined` values (e.g. `mode: undefined` overrides) before writing. */
const prune = (text) => JSON.stringify(JSON.parse(text), null, 2) + '\n';

rmSync(ROOT, { recursive: true, force: true });
for (const [path, content] of files) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, path.endsWith('.js') ? content : prune(content));
}
console.log(`Wrote ${files.size} files to app/`);
