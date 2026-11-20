#!/usr/bin/env node
// Generates the Make custom app sections in ../app from the definitions below.
// This file is the source of truth: edit it, run `npm run generate`, then `npm run validate`.
// No network access, no dependencies.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const API = 'https://birinchishop.uz/api/v1';
const CONNECTION = 'birinchishop';
const UA = 'birinchishop-make/1.0';

const files = new Map();
const put = (path, data) => files.set(path, `${JSON.stringify(data, null, 2)}\n`);

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
const limit = (def = 100, max = 1000) =>
  uint('limit', 'Limit', { required: true, default: def, validate: { min: 1, max }, help: 'Maximum number of bundles this module returns in one execution.' });
const dayParam = (name, label, help) =>
  text(name, label, { validate: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, help });

const ORDER_STATUSES = {
  new: 'New (waiting for the call center)',
  processing: 'Processing',
  callback: 'Callback (customer asked to be called later)',
  confirmed: 'Confirmed by phone',
  packed: 'Packed',
  shipping: 'Shipping',
  delivered: 'Delivered (payout earned)',
  returned: 'Returned (refused at delivery)',
  cancelled: 'Cancelled (no payout)',
};
const CONVERSIONS = {
  lead: 'Lead (new, processing, callback)',
  approved: 'Approved (confirmed, packed, shipping)',
  sale: 'Sale (delivered)',
  rejected: 'Rejected (returned, cancelled)',
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

put('base.imljson', {
  baseUrl: API,
  headers: {
    Authorization: 'Bearer {{connection.apiKey}}',
    Accept: 'application/json',
    'User-Agent': UA,
  },
  response: {
    error: {
      message: '[{{statusCode}}] {{body.error.message}} (code: {{body.error.code}}, request ID: {{body.request_id}})',
      400: { type: 'DataError', message: '[400] {{body.error.message}} (code: {{body.error.code}}, request ID: {{body.request_id}})' },
      401: { type: 'InvalidAccessTokenError', message: '[401] {{body.error.message}} (code: {{body.error.code}}). Check or recreate the API key in Dashboard → API.' },
      403: { type: 'InvalidConfigurationError', message: '[403] {{body.error.message}} (code: {{body.error.code}}, request ID: {{body.request_id}}). For insufficient_scope, grant the scope to the key in Dashboard → API.' },
      409: { type: 'DuplicateDataError', message: '[409] {{body.error.message}} (code: {{body.error.code}}, request ID: {{body.request_id}}). Do not retry this request.' },
    },
  },
  log: { sanitize: SANITIZE },
});

put('groups.json', [
  { label: 'Orders', modules: ['watchNewOrders', 'watchOrderStatusChanges', 'watchOrderEvents', 'createOrder', 'getOrder', 'searchOrders', 'setTestOrderStatus'] },
  { label: 'Links', modules: ['createLink', 'searchLinks'] },
  { label: 'Offers', modules: ['getOffer', 'searchOffers'] },
  { label: 'Reports', modules: ['getStatistics', 'getCohortReport', 'getAttributionReport', 'getAccount'] },
  { label: 'Other', modules: ['makeApiCall'] },
]);

// ─── Connection ───────────────────────────────────────────────────────

put(`connections/${CONNECTION}/metadata.json`, { type: 'basic', label: 'Birinchishop' });
put(`connections/${CONNECTION}/parameters.imljson`, [
  f('apiKey', 'password', 'API Key', {
    required: true,
    help:
      'Create a key in the [Birinchishop partner panel](https://birinchishop.uz/dashboard/api) (Dashboard → API) and grant `account:read` plus the scopes your scenarios use (`webhooks:manage` for instant triggers). ' +
      'A live key (`bsk_live_...`) acts on your real account: **Create an Order submits a REAL order** that a call center phones. ' +
      'A test key (`bsk_test_...`) reads real data but creates nothing — use it while building scenarios. Do not set an IP allowlist on a key used in Make.',
  }),
]);
put(`connections/${CONNECTION}/api.imljson`, {
  url: `${API}/me`,
  method: 'GET',
  headers: { Authorization: 'Bearer {{parameters.apiKey}}', Accept: 'application/json', 'User-Agent': UA },
  response: {
    metadata: { type: 'text', value: '{{body.data.name}} ({{body.data.api_key.mode}} key)' },
    error: { message: '[{{statusCode}}] {{body.error.message}} (code: {{body.error.code}})' },
  },
  log: { sanitize: SANITIZE },
});

// ─── Webhooks (dedicated, attached) ───────────────────────────────────

/**
 * The webhook receiver keeps only event metadata. It does not pass the unverified order
 * body on: the instant trigger re-reads the order from the API with the user's key.
 * `condition` drops the panel's synthetic "Send test" request (order id 0).
 */
function webhook(name, label, eventType) {
  put(`webhooks/${name}/metadata.json`, { type: 'web', label, accountName: CONNECTION });
  put(`webhooks/${name}/parameters.imljson`, []);
  put(`webhooks/${name}/attach.imljson`, {
    url: `${API}/webhooks`,
    method: 'POST',
    headers: { Authorization: 'Bearer {{connection.apiKey}}', Accept: 'application/json', 'User-Agent': UA },
    type: 'json',
    body: { url: '{{webhook.url}}', kind: 'json', events: [eventType], description: `Make: ${label}` },
    response: {
      data: { externalHookId: '{{body.data.id}}', secret: '{{body.data.secret}}' },
      error: { message: '[{{statusCode}}] {{body.error.message}} (code: {{body.error.code}}). The account can have at most 10 webhooks; remove unused ones in Dashboard → API → Webhooks.' },
    },
    log: { sanitize: [...SANITIZE, 'request.body.url', 'response.body.data.secret', 'response.body.data.url'] },
  });
  put(`webhooks/${name}/detach.imljson`, {
    url: `${API}/webhooks/{{webhook.externalHookId}}`,
    method: 'DELETE',
    headers: { Authorization: 'Bearer {{connection.apiKey}}', Accept: 'application/json', 'User-Agent': UA },
    log: { sanitize: SANITIZE },
  });
  put(`webhooks/${name}/api.imljson`, {
    condition: `{{body.type === '${eventType}' && body.data.order_id > 0}}`,
    respond: { status: 200, type: 'json', body: { received: true } },
    output: {
      event_id: '{{body.id}}',
      type: '{{body.type}}',
      api_version: '{{body.api_version}}',
      created_at: '{{body.created_at}}',
      order_id: '{{body.data.order_id}}',
      status: '{{body.data.status}}',
      previous_status: '{{body.data.previous_status}}',
      test: '{{body.test === true}}',
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
    limit: 500,
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
    limit: 500,
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
const INSTANT_SPEC = [
  text('event_id', 'Event ID'),
  text('type', 'Event type'),
  date('event_created_at', 'Event time'),
  uint('order_id', 'Order ID'),
  text('event_status', 'Status in the event'),
  text('previous_status', 'Previous status'),
  text('status', 'Current status'),
  text('conversion_status', 'Current conversion status'),
  bool('test', 'Test event'),
  coll('order', 'Order (current, read from the API)', ORDER_SPEC),
];
const instantApi = {
  url: '/orders/{{payload.order_id}}',
  method: 'GET',
  response: {
    output: {
      event_id: '{{payload.event_id}}',
      type: '{{payload.type}}',
      event_created_at: '{{payload.created_at}}',
      order_id: '{{payload.order_id}}',
      event_status: '{{payload.status}}',
      previous_status: '{{payload.previous_status}}',
      status: '{{body.data.status}}',
      conversion_status: '{{body.data.conversion_status}}',
      test: '{{payload.test}}',
      order: '{{body.data}}',
    },
  },
};
const instantBanner = {
  name: 'about',
  type: 'banner',
  title: 'Instant trigger',
  text: 'Saving the scenario registers a signed webhook on your account (API key scope `webhooks:manage`, at most 10 per account); turning it off or deleting it removes the webhook. Each event is re-read from the API with your key before it reaches the scenario.',
};

module('watchNewOrders', {
  type: 'instant',
  label: 'Watch New Orders',
  description: 'Triggers when a new order arrives on your account.',
  hookName: 'orderCreated',
  api: instantApi,
  parameters: [instantBanner],
  interface: INSTANT_SPEC,
  samples: {
    event_id: 'evt_778899', type: 'order.created', event_created_at: '2026-11-20T09:15:00.000Z', order_id: 123456,
    event_status: 'new', previous_status: null, status: 'new', conversion_status: 'lead', test: false, order: ORDER_SAMPLE,
  },
});

module('watchOrderStatusChanges', {
  type: 'instant',
  label: 'Watch Order Status Changes',
  description: 'Triggers when an order moves to another status (confirmed, shipping, delivered, returned, cancelled...).',
  hookName: 'orderStatusChanged',
  api: instantApi,
  parameters: [instantBanner],
  interface: INSTANT_SPEC,
  samples: {
    event_id: 'evt_778950', type: 'order.status_changed', event_created_at: '2026-11-22T14:02:00.000Z', order_id: 123456,
    event_status: 'delivered', previous_status: 'shipping', status: 'delivered', conversion_status: 'sale', test: false,
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
  coll('order', 'Order', ORDER_SPEC),
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

module('watchOrderEvents', {
  type: 'trigger',
  crud: 'read',
  label: 'Watch Order Events',
  description: 'Triggers when an order is created or changes status (polling the event feed; no webhook needed).',
  api: {
    url: '/events',
    method: 'GET',
    qs: { after: '{{data.lastId}}', limit: 200, include_order: 'true', type: '{{parameters.type}}' },
    response: {
      iterate: '{{body.data}}',
      limit: '{{parameters.limit}}',
      trigger: { id: '{{item.id}}', type: 'id', order: 'asc' },
      output: '{{item}}',
    },
    pagination: {
      qs: { after: '{{body.meta.next_cursor}}' },
      condition: '{{body.meta.has_more}}',
    },
  },
  parameters: [
    eventTypeParam,
    limit(100, 1000),
    {
      name: 'about',
      type: 'banner',
      title: 'Event feed',
      text: 'Reads `GET /events` in order, continuing after the last processed event. The feed keeps 90 days; the first run starts at the oldest kept event and returns at most Limit events per run. Needs the `events:read` and `orders:read` scopes. Prefer the instant triggers when your key can manage webhooks.',
    },
  ],
  interface: EVENT_SPEC,
  samples: EVENT_SAMPLE,
});

module('createOrder', {
  type: 'action',
  crud: 'create',
  label: 'Create an Order',
  description: 'Creates a REAL cash-on-delivery order for a customer who asked to buy; a call center phones them. Test keys create nothing.',
  api: {
    url: '/orders',
    method: 'POST',
    type: 'json',
    headers: { 'Idempotency-Key': '{{parameters.idempotency_key}}' },
    body: {
      link_id: '{{parameters.link_id}}',
      phone: '{{parameters.phone}}',
      name: '{{parameters.name}}',
      region: '{{parameters.region}}',
      variant_id: '{{parameters.variant_id}}',
      variant_type_id: '{{parameters.variant_type_id}}',
      external_id: '{{parameters.external_id}}',
      click_id: '{{parameters.click_id}}',
      sub1: '{{parameters.sub1}}',
      sub2: '{{parameters.sub2}}',
      sub3: '{{parameters.sub3}}',
      sub4: '{{parameters.sub4}}',
      sub5: '{{parameters.sub5}}',
    },
    response: { output: '{{body.data}}' },
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
    linkSelect({ required: true, help: 'Your tracking link for the offer; it decides the offer and your payout.' }),
    text('phone', 'Customer phone', { required: true, validate: { pattern: '^[+0-9 ()-]{9,20}$' }, help: 'Uzbekistan mobile number, e.g. `+998901234567`.' }),
    text('name', 'Customer name', { validate: { max: 100 }, help: 'Default: "Mijoz" plus the last 4 digits of the phone.' }),
    text('region', 'Region', { validate: { max: 64 } }),
    uint('variant_id', 'Variant ID', { help: 'For offers with variants (see Get an Offer → Variants).' }),
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
      help: 'Strongly recommended: map a stable unique value (lead ID, row ID). Sending the same key again returns the existing order instead of creating a second one, so retries are safe.',
    }),
  ],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('getOrder', {
  type: 'action',
  crud: 'read',
  label: 'Get an Order',
  description: 'Gets an order by ID. The customer phone is always masked.',
  api: { url: '/orders/{{parameters.order_id}}', method: 'GET', response: { output: '{{body.data}}' } },
  expect: [uint('order_id', 'Order ID', { required: true, help: 'Test orders (test keys) are kept for 24 hours.' })],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('searchOrders', {
  type: 'search',
  crud: 'read',
  label: 'Search Orders',
  description: 'Searches your orders by status, dates, offer, link, external ID or click ID.',
  api: {
    url: '/orders',
    method: 'GET',
    qs: {
      status: '{{parameters.status}}',
      conversion_status: '{{parameters.conversion_status}}',
      date_from: '{{parameters.date_from}}',
      date_to: '{{parameters.date_to}}',
      updated_since: '{{parameters.updated_since}}',
      offer_id: '{{parameters.offer_id}}',
      link_id: '{{parameters.link_id}}',
      external_id: '{{parameters.external_id}}',
      click_id: '{{parameters.click_id}}',
      limit: 100,
      page: 1,
    },
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: '{{item}}' },
    pagination: pagePagination,
  },
  expect: [
    f('status', 'select', 'Status', { options: opts(ORDER_STATUSES) }),
    f('conversion_status', 'select', 'Conversion status', { options: opts(CONVERSIONS), help: 'Ignored when Status is set.' }),
    dayParam('date_from', 'Created from', 'First day (Asia/Tashkent), `YYYY-MM-DD`.'),
    dayParam('date_to', 'Created to', 'Last day (Asia/Tashkent), `YYYY-MM-DD`.'),
    date('updated_since', 'Updated since', { help: 'Only orders updated after this time; results are then sorted by update time (oldest first).' }),
    offerSelect({ mode: undefined }),
    linkSelect({ mode: undefined }),
    text('external_id', 'External ID'),
    text('click_id', 'Click ID'),
    limit(100, 10000),
  ],
  interface: ORDER_SPEC,
  samples: ORDER_SAMPLE,
});

module('setTestOrderStatus', {
  type: 'action',
  crud: 'update',
  label: 'Set a Test Order Status',
  description: 'Moves a test order (bsk_test_ key) to another status and sends a signed test event to your webhooks. Works only with test keys.',
  api: {
    url: '/sandbox/orders/{{parameters.order_id}}/status',
    method: 'POST',
    type: 'json',
    body: { status: '{{parameters.status}}' },
    response: { output: '{{body.data}}' },
  },
  expect: [
    uint('order_id', 'Test order ID', { required: true, help: 'ID returned by Create an Order with a test key (≥ 2000000000).' }),
    f('status', 'select', 'New status', { required: true, default: 'delivered', options: opts(Object.fromEntries(Object.entries(ORDER_STATUSES).filter(([k]) => k !== 'new'))) }),
  ],
  interface: [
    coll('order', 'Order', ORDER_SPEC),
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
  label: 'Create a Link',
  description: 'Creates a tracking link for an offer. Test keys create nothing.',
  api: {
    url: '/links',
    method: 'POST',
    type: 'json',
    body: { offer_id: '{{parameters.offer_id}}', name: '{{parameters.name}}' },
    response: { output: '{{body.data}}' },
  },
  expect: [offerSelect({ required: true, mode: undefined }), text('name', 'Link name', { validate: { max: 100 }, help: 'Your label, e.g. "Instagram reels".' })],
  interface: LINK_SPEC,
  samples: LINK_SAMPLE,
});

module('searchLinks', {
  type: 'search',
  crud: 'read',
  label: 'Search Links',
  description: 'Lists your tracking links, optionally for one offer (newest first).',
  api: {
    url: '/links',
    method: 'GET',
    qs: { offer_id: '{{parameters.offer_id}}', limit: 100, page: 1 },
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: '{{item}}' },
    pagination: pagePagination,
  },
  expect: [offerSelect({ mode: undefined }), limit(100, 1000)],
  interface: LINK_SPEC,
  samples: LINK_SAMPLE,
});

module('getOffer', {
  type: 'action',
  crud: 'read',
  label: 'Get an Offer',
  description: 'Gets an offer with its description, images and variants.',
  api: { url: '/offers/{{parameters.offer_id}}', method: 'GET', qs: { lang: '{{parameters.lang}}' }, response: { output: '{{body.data}}' } },
  expect: [offerSelect({ required: true }), f('lang', 'select', 'Language of name and description', { options: opts(LANGS), default: 'uz' })],
  interface: OFFER_FULL_SPEC,
  samples: { ...OFFER_SAMPLE, description: 'Waterproof smart watch...', images: [OFFER_SAMPLE.image_url], variants: [] },
});

module('searchOffers', {
  type: 'search',
  crud: 'read',
  label: 'Search Offers',
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
    response: { iterate: '{{body.data}}', limit: '{{parameters.limit}}', output: '{{item}}' },
    pagination: pagePagination,
  },
  expect: [
    text('search', 'Name contains', { validate: { max: 100 }, help: 'Uzbek, Russian or English; typos are tolerated.' }),
    bool('in_stock_only', 'In stock only', { default: true }),
    uint('min_payout', 'Minimum payout (UZS)'),
    uint('min_sale_rate', 'Minimum sale rate (%)', { validate: { min: 0, max: 100 } }),
    f('sort', 'select', 'Sort', { options: opts(SORTS), default: 'recommended' }),
    f('lang', 'select', 'Language of names', { options: opts(LANGS), default: 'uz' }),
    limit(20, 1000),
  ],
  interface: OFFER_SPEC,
  samples: OFFER_SAMPLE,
});

module('getStatistics', {
  type: 'action',
  crud: 'read',
  label: 'Get Statistics',
  description: 'Gets orders, approvals, deliveries, earnings and clicks for a period (default: last 30 days), with rows per day, offer or link.',
  api: {
    url: '/stats',
    method: 'GET',
    qs: {
      group_by: '{{parameters.group_by}}',
      date_from: '{{parameters.date_from}}',
      date_to: '{{parameters.date_to}}',
      offer_id: '{{parameters.offer_id}}',
      link_id: '{{parameters.link_id}}',
    },
    response: {
      output: {
        group_by: '{{body.meta.group_by}}',
        date_from: '{{body.meta.date_from}}',
        date_to: '{{body.meta.date_to}}',
        timezone: '{{body.meta.timezone}}',
        currency: '{{body.meta.currency}}',
        clicks_since: '{{body.meta.clicks_since}}',
        totals: '{{body.meta.totals}}',
        rows: '{{body.data}}',
      },
    },
  },
  expect: [
    f('group_by', 'select', 'Group rows by', { required: true, default: 'day', options: opts({ day: 'Day', offer: 'Offer', link: 'Link' }) }),
    dayParam('date_from', 'Date from', 'First day (Asia/Tashkent), `YYYY-MM-DD`. Default: 29 days before Date to. Max range 366 days.'),
    dayParam('date_to', 'Date to', 'Last day (Asia/Tashkent), `YYYY-MM-DD`. Default: today.'),
    offerSelect({ mode: undefined, help: 'Only this offer.' }),
    linkSelect({ mode: undefined, help: 'Only this link.' }),
  ],
  interface: [
    text('group_by', 'Grouped by'), text('date_from', 'Date from'), text('date_to', 'Date to'), text('timezone', 'Time zone'),
    text('currency', 'Currency'), date('clicks_since', 'Click tracking since'),
    coll('totals', 'Totals', STATS_NUMBERS),
    arr('rows', 'Rows', { type: 'collection', label: 'Row', spec: [...STATS_ROW, ...STATS_NUMBERS] }),
  ],
  samples: {
    group_by: 'day', date_from: '2026-10-22', date_to: '2026-11-20', timezone: 'Asia/Tashkent', currency: 'UZS', clicks_since: '2026-11-18T00:00:00.000Z',
    totals: { orders: 40, approved: 22, delivered: 15, rejected: 12, pending: 6, approval_rate_percent: 55, delivery_rate_percent: 38, earned: 750000, potential_earnings: 350000, clicks: 1200, unique_clicks: 950 },
    rows: [{ date: '2026-11-20', orders: 2, approved: 1, delivered: 0, rejected: 0, pending: 1, approval_rate_percent: 50, delivery_rate_percent: 0, earned: 0, potential_earnings: 100000, clicks: 60, unique_clicks: 48 }],
  },
});

module('getCohortReport', {
  type: 'action',
  crud: 'read',
  label: 'Get a Cohort Report',
  description: 'Gets weekly order cohorts and the share delivered within 3, 7, 14 and 30 days.',
  api: {
    url: '/stats/cohorts',
    method: 'GET',
    qs: { weeks: '{{parameters.weeks}}', offer_id: '{{parameters.offer_id}}', link_id: '{{parameters.link_id}}', source: '{{parameters.source}}' },
    response: {
      output: {
        weeks: '{{body.meta.weeks}}',
        date_from: '{{body.meta.date_from}}',
        date_to: '{{body.meta.date_to}}',
        timezone: '{{body.meta.timezone}}',
        week_starts_on: '{{body.meta.week_starts_on}}',
        totals: '{{body.meta.totals}}',
        average: '{{body.meta.average}}',
        cohorts: '{{body.data}}',
      },
    },
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
  date('at', 'Time'), text('role', 'Role (first, last, assist, only)'), text('partner', 'Partner (you / other)'), text('kind', 'Kind (link / landing)'),
  uint('link_id', 'Link ID'), text('link_name', 'Link name'), text('landing', 'Landing'), text('source', 'Source'),
  text('utm_source', 'UTM source'), text('utm_medium', 'UTM medium'), text('utm_campaign', 'UTM campaign'),
];
module('getAttributionReport', {
  type: 'action',
  crud: 'read',
  label: 'Get an Attribution Report',
  description: 'Gets the multi-touch attribution report: which of your links were first, last or assisting touches before orders (report only; payouts are not affected).',
  api: {
    url: '/stats/attribution',
    method: 'GET',
    qs: { date_from: '{{parameters.date_from}}', date_to: '{{parameters.date_to}}' },
    response: {
      output: {
        date_from: '{{body.meta.date_from}}',
        date_to: '{{body.meta.date_to}}',
        timezone: '{{body.meta.timezone}}',
        tracking_since: '{{body.data.tracking_since}}',
        lookback_days: '{{body.data.lookback_days}}',
        summary: '{{body.data.summary}}',
        links: '{{body.data.links}}',
        paths: '{{body.data.paths}}',
      },
    },
  },
  expect: [
    dayParam('date_from', 'Date from', 'First day (Asia/Tashkent), `YYYY-MM-DD`. Default: 29 days before Date to.'),
    dayParam('date_to', 'Date to', 'Last day (Asia/Tashkent), `YYYY-MM-DD`. Default: today.'),
  ],
  interface: [
    text('date_from', 'Date from'), text('date_to', 'Date to'), text('timezone', 'Time zone'), date('tracking_since', 'Tracking since'), uint('lookback_days', 'Lookback (days)'),
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
        date('ordered_at', 'Ordered at'), arr('steps', 'Steps', { type: 'collection', label: 'Step', spec: STEP_SPEC }),
      ],
    }),
  ],
  samples: {
    date_from: '2026-10-22', date_to: '2026-11-20', timezone: 'Asia/Tashkent', tracking_since: '2026-11-18T00:00:00.000Z', lookback_days: 30,
    summary: { orders: 40, converted_by_you: 38, multi_touch: 5, with_other_partners: 2, assisted_for_other_partners: 1 },
    links: [{ link_id: 9001, link_name: 'Instagram reels', first_touch_orders: 10, last_touch_orders: 12, assist_orders: 2, single_touch_orders: 20, converted_orders: 30 }],
    paths: [],
  },
});

module('getAccount', {
  type: 'action',
  crud: 'read',
  label: 'Get My Account',
  description: 'Gets your partner account: balance, frozen balance, minimum withdrawal and the API key mode (live or test).',
  api: { url: '/me', method: 'GET', response: { output: '{{body.data}}' } },
  interface: [
    uint('id', 'Account ID'), text('name', 'Name'), text('status', 'Status'), num('balance', 'Balance (UZS)'), num('balance_frozen', 'Frozen balance (UZS)'),
    num('min_withdrawal', 'Minimum withdrawal (UZS)'), text('currency', 'Currency'), date('created_at', 'Created at'),
    coll('api_key', 'API key', [text('name', 'Name'), text('mode', 'Mode (live / test)'), arr('scopes', 'Scopes', { type: 'text' }), date('expires_at', 'Expires at')]),
  ],
  samples: {
    id: 1001, name: 'Partner name', status: 'active', balance: 350000, balance_frozen: 0, min_withdrawal: 50000, currency: 'UZS', created_at: '2026-06-01T10:00:00.000Z',
    api_key: { name: 'Make', mode: 'live', scopes: ['account:read', 'orders:read'], expires_at: null },
  },
});

module('makeApiCall', {
  type: 'universal',
  label: 'Make an API Call',
  description: 'Performs an arbitrary authorized call to the Birinchishop Partner API.',
  api: {
    url: "/{{replace(parameters.url, '/^\\//', emptystring)}}",
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
      help: 'Path relative to `https://birinchishop.uz/api/v1/`, e.g. `/offers`. See https://birinchishop.uz/api/v1/docs. Note: `POST /orders` with a live key creates a REAL order.',
    }),
    f('method', 'select', 'Method', { required: true, default: 'GET', options: opts({ GET: 'GET', POST: 'POST', PATCH: 'PATCH', DELETE: 'DELETE' }) }),
    arr('headers', 'Headers', [text('key', 'Key'), text('value', 'Value')], {
      default: [{ key: 'Content-Type', value: 'application/json' }],
      help: 'Authorization is added automatically.',
    }),
    arr('qs', 'Query String', [text('key', 'Key'), text('value', 'Value')]),
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
  writeFileSync(full, prune(content));
}
console.log(`Wrote ${files.size} files to app/`);
