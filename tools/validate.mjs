#!/usr/bin/env node
// Offline checks of the Make custom app in ../app:
//   1. every file parses as JSON;
//   2. each section validates against Make's editor JSON schemas (tools/editor-schemas, from
//      integromat/vscode-apps-sdk) the way the web editor does;
//   3. cross references: connection / webhook / RPC / group names, parameters used in IML,
//      webhook payload fields used by instant triggers, attach → detach identity,
//      interface ↔ samples ↔ output, required pieces per module type;
//   4. no secrets, e-mails or IP addresses in the files;
//   5. custom IML functions (app/functions/<name>/code.js) define <name> and pass their own tests
//      (test.js, run here with the same `it` / `assert` API as Make's function tests).
// No network access; nothing is changed. Exit code 0 = OK, 1 = problems found.

import { createRequire } from 'node:module';
import assert from 'node:assert';
import vm from 'node:vm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');
const SCHEMAS = join(HERE, 'editor-schemas');

const errors = [];
const notes = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

// ─── 1. Parse ─────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const docs = new Map(); // relative path -> parsed JSON
const functionFiles = new Map(); // relative path -> source (functions/<name>/code.js|test.js)
for (const path of walk(APP).sort()) {
  const rel = relative(APP, path);
  if (/^functions\/[A-Za-z][\w]*\/(code|test)\.js$/.test(rel)) {
    functionFiles.set(rel, readFileSync(path, 'utf8'));
    continue;
  }
  if (!/\.(imljson|json)$/.test(rel)) {
    err(rel, 'unexpected file type');
    continue;
  }
  try {
    docs.set(rel, JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    err(rel, `invalid JSON: ${e.message}`);
  }
}
const get = (rel) => docs.get(rel);
const has = (rel) => docs.has(rel);
const dirsOf = (kind) => (existsSync(join(APP, kind)) ? readdirSync(join(APP, kind)).sort() : []);

// ─── 2. Editor schemas ────────────────────────────────────────────────

const SECTION_SCHEMA = {
  base: 'base.json',
  parameters: 'parameters.json',
  expect: 'parameters.json',
  interface: 'parameters.json',
  samples: 'samples.json',
  epoch: 'epoch.json',
  groups: 'groups.json',
  attach: 'api.json',
  detach: 'api.json',
};
function schemaFor(rel) {
  const section = basename(rel).replace(/\.(imljson|json)$/, '');
  if (section === 'api') return rel.startsWith('webhooks/') ? null : 'api.json';
  return SECTION_SCHEMA[section] || null;
}

let validated = 0;
const notValidated = [];
const require = createRequire(import.meta.url);
let Ajv;
try {
  Ajv = require('ajv');
  Ajv = Ajv.default || Ajv;
} catch {
  err('tools', 'Ajv 8 is missing: run `npm install` in this folder');
}
if (Ajv) {
  // Same settings as Make's own validate script: the schemas do not load with Ajv defaults.
  const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
  for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, name), 'utf8')), name);
  }
  for (const [rel, data] of docs) {
    const schema = schemaFor(rel);
    if (!schema) {
      notValidated.push(rel);
      continue;
    }
    validated += 1;
    const validate = ajv.getSchema(schema);
    if (!validate(data)) {
      for (const e of validate.errors) err(rel, `schema ${schema} ${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`);
    }
  }
}

// ─── helpers for IML references ───────────────────────────────────────

/** All `{{ ... }}` expressions inside a JSON value (keys included). */
function imlExpressions(value, out = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) out.push(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((v) => imlExpressions(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      imlExpressions(k, out);
      imlExpressions(v, out);
    }
  }
  return out;
}
/** Names used as `<root>.<name>` in IML expressions. */
function refs(value, root) {
  const names = new Set();
  const re = new RegExp(`(?<![\\w.])${root}\\.([A-Za-z_][\\w]*)`, 'g');
  for (const expr of imlExpressions(value)) for (const m of expr.matchAll(re)) names.add(m[1]);
  return names;
}
const SPREAD = '{{...}}';
/** Explicit keys of an IML output object; `spread` = it also passes through a whole object. */
function outputKeys(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const keys = Object.keys(output);
  return { keys: new Set(keys.filter((k) => k !== SPREAD)), spread: keys.includes(SPREAD) };
}
/** Field names of a parameter list (banners have no value). */
const fieldNames = (list) => new Set((Array.isArray(list) ? list : []).filter((p) => p && p.type !== 'banner').map((p) => p.name));

// ─── 3. Cross references ──────────────────────────────────────────────

const connections = dirsOf('connections');
const webhooks = dirsOf('webhooks');
const rpcs = dirsOf('rpcs');
const modules = dirsOf('modules');

for (const required of ['base.imljson', 'groups.json', 'metadata.json']) if (!has(required)) err(required, 'missing');
if (connections.length !== 1) err('connections', `expected exactly one connection, found ${connections.length}`);

// Connection: parameters used by its own api and by connection.* elsewhere
const connParams = new Set();
for (const c of connections) {
  const params = get(`connections/${c}/parameters.imljson`);
  const api = get(`connections/${c}/api.imljson`);
  if (!params || !api) err(`connections/${c}`, 'needs parameters.imljson and api.imljson');
  fieldNames(params).forEach((n) => connParams.add(n));
  for (const n of refs(api, 'parameters')) if (!fieldNames(params).has(n)) err(`connections/${c}/api.imljson`, `uses parameters.${n}, not defined`);
  const sanitize = (api && api.log && api.log.sanitize) || [];
  if (!sanitize.includes('request.headers.authorization')) err(`connections/${c}/api.imljson`, 'Authorization header is not sanitized in logs');
  const meta = get(`connections/${c}/metadata.json`);
  if (!meta || !meta.type) err(`connections/${c}/metadata.json`, 'missing type');
}
for (const [rel, data] of docs) {
  for (const n of refs(data, 'connection')) if (!connParams.has(n)) err(rel, `uses connection.${n}, not a connection parameter`);
}
const base = get('base.imljson') || {};
if (!((base.log && base.log.sanitize) || []).includes('request.headers.authorization')) err('base.imljson', 'Authorization header is not sanitized in logs');

// Webhooks: linked connection, attach → detach identity, sanitized secret, receiver output
const webhookOutputs = new Map();
for (const w of webhooks) {
  const dir = `webhooks/${w}`;
  const meta = get(`${dir}/metadata.json`) || {};
  if (!connections.includes(meta.accountName)) err(`${dir}/metadata.json`, `accountName "${meta.accountName}" is not a connection`);
  const attach = get(`${dir}/attach.imljson`);
  const detach = get(`${dir}/detach.imljson`);
  const receiver = get(`${dir}/api.imljson`);
  if (!attach || !detach || !receiver) {
    err(dir, 'needs attach, detach and api (receiver)');
    continue;
  }
  if (!JSON.stringify(attach.body || {}).includes('{{webhook.url}}')) err(`${dir}/attach.imljson`, 'does not send {{webhook.url}}');
  // attach/detach are RPCs: they inherit base URL, Authorization and its sanitization from the Base
  for (const [part, label] of [[attach, 'attach'], [detach, 'detach']]) {
    const hdrs = Object.keys(part.headers || {}).map((h) => h.toLowerCase());
    if (hdrs.includes('authorization')) err(`${dir}/${label}.imljson`, 'repeats the Authorization header; it is inherited from the Base');
    if (/^https?:/.test(part.url || '')) err(`${dir}/${label}.imljson`, 'use a URL relative to the Base');
  }
  const saved = new Set(Object.keys((attach.response && attach.response.data) || {}));
  for (const n of refs(detach, 'webhook')) if (!saved.has(n)) err(`${dir}/detach.imljson`, `uses webhook.${n}, attach does not save it in response.data`);
  if (!refs(detach, 'webhook').size) err(`${dir}/detach.imljson`, 'does not reference the saved remote webhook id');
  const san = (attach.log && attach.log.sanitize) || [];
  if (saved.has('secret') && !san.some((s) => s.includes('secret'))) err(`${dir}/attach.imljson`, 'the returned secret is not sanitized in logs');
  if (receiver.respond && !(receiver.respond.status >= 200 && receiver.respond.status < 300)) err(`${dir}/api.imljson`, 'accepted deliveries must answer 2xx');
  if (receiver.verification) notes.push(`${dir}: verification block present (challenge only)`);
  const out = outputKeys(receiver.output);
  webhookOutputs.set(w, out);
  if (out && out.spread) notes.push(`${dir}: receiver output spreads the payload; payload.* fields outside its explicit keys are not checked`);
  if (out && !/omit\(body\.data,\s*'order'\)/.test(JSON.stringify(receiver.output))) err(`${dir}/api.imljson`, 'must not pass on the unverified order body (omit data.order)');
  const wp = fieldNames(get(`${dir}/parameters.imljson`));
  for (const part of [attach, detach, receiver]) for (const n of refs(part, 'parameters')) if (!wp.has(n)) err(dir, `uses parameters.${n}, not a webhook parameter`);
}

// RPCs
for (const r of rpcs) {
  const dir = `rpcs/${r}`;
  const meta = get(`${dir}/metadata.json`) || {};
  if (!connections.includes(meta.accountName)) err(`${dir}/metadata.json`, `accountName "${meta.accountName}" is not a connection`);
  const api = get(`${dir}/api.imljson`);
  if (!api) err(dir, 'missing api.imljson');
  const out = api && api.response && api.response.output;
  if (!out || out.label === undefined || out.value === undefined) err(`${dir}/api.imljson`, 'options RPC must output {label, value}');
  const rpcLimit = api && api.response && api.response.limit;
  if (!rpcLimit) err(`${dir}/api.imljson`, 'options RPC should have a bounded response.limit');
  else if (typeof rpcLimit === 'number' && rpcLimit > 300) err(`${dir}/api.imljson`, `response.limit ${rpcLimit} > 300 (Make: at most 3 requests / 300 records)`);
}

// Modules
const TYPE = { 1: 'trigger', 4: 'action', 9: 'search', 10: 'instant', 12: 'universal' };
function checkInterfaceSample(dir, iface, sample, path = '') {
  if (!Array.isArray(iface) || !sample || typeof sample !== 'object' || Array.isArray(sample)) return;
  const names = new Map(iface.map((p) => [p.name, p]));
  for (const [k, v] of Object.entries(sample)) {
    const field = names.get(k);
    if (!field) {
      err(`${dir}/samples.imljson`, `sample key "${path}${k}" is not in the interface`);
      continue;
    }
    if (v === null) continue;
    if (field.type === 'collection' && Array.isArray(field.spec) && field.spec.length) checkInterfaceSample(dir, field.spec, v, `${path}${k}.`);
    if (['uinteger', 'number', 'integer'].includes(field.type) && typeof v !== 'number') err(`${dir}/samples.imljson`, `"${path}${k}" should be a number`);
    if (field.type === 'boolean' && typeof v !== 'boolean') err(`${dir}/samples.imljson`, `"${path}${k}" should be a boolean`);
    if (field.type === 'date' && Number.isNaN(Date.parse(v))) err(`${dir}/samples.imljson`, `"${path}${k}" should be an ISO date`);
    if (field.type === 'array' && !Array.isArray(v)) err(`${dir}/samples.imljson`, `"${path}${k}" should be an array`);
  }
}

const rpcRefs = new Set();
for (const m of modules) {
  const dir = `modules/${m}`;
  const meta = get(`${dir}/metadata.json`);
  const api = get(`${dir}/api.imljson`);
  const params = get(`${dir}/parameters.imljson`) || [];
  const expect = get(`${dir}/expect.imljson`) || [];
  const iface = get(`${dir}/interface.imljson`);
  const samples = get(`${dir}/samples.imljson`);
  if (!meta || !api || !iface || samples === undefined) {
    err(dir, 'needs metadata, api, interface and samples');
    continue;
  }
  const kind = TYPE[meta.typeId];
  if (!kind) err(`${dir}/metadata.json`, `unknown typeId ${meta.typeId}`);
  if (!meta.label || !meta.description) err(`${dir}/metadata.json`, 'label and description are required');
  if (!connections.includes(meta.accountName)) err(`${dir}/metadata.json`, `accountName "${meta.accountName}" is not a connection`);

  const declared = new Set([...fieldNames(params), ...fieldNames(expect)]);
  for (const n of refs(api, 'parameters')) if (!declared.has(n)) err(`${dir}/api.imljson`, `uses parameters.${n}, not declared`);
  for (const p of [...params, ...expect]) {
    if (p && typeof p.options === 'string' && p.options.startsWith('rpc://')) {
      const name = p.options.slice('rpc://'.length);
      rpcRefs.add(name);
      if (!rpcs.includes(name)) err(dir, `field ${p.name} uses ${p.options}, no such RPC`);
    }
  }

  if (kind === 'trigger' || kind === 'instant') {
    if (expect.length) err(`${dir}/expect.imljson`, 'triggers take static parameters only');
  } else if (params.length) {
    err(`${dir}/parameters.imljson`, 'actions/searches should use mappable parameters (expect)');
  }
  if (kind === 'instant') {
    if (!webhooks.includes(meta.hookName)) err(`${dir}/metadata.json`, `hookName "${meta.hookName}" is not a webhook`);
    const out = webhookOutputs.get(meta.hookName);
    if (out && !out.spread) for (const n of refs(api, 'payload')) if (!out.keys.has(n)) err(`${dir}/api.imljson`, `uses payload.${n}, webhook ${meta.hookName} does not output it`);
    if (api.pagination || (api.response && api.response.iterate)) err(`${dir}/api.imljson`, 'instant trigger communication cannot iterate or paginate');
  } else if (meta.hookName) {
    err(`${dir}/metadata.json`, 'only instant triggers have a hookName');
  }
  if (kind === 'trigger') {
    const t = api.response && api.response.trigger;
    if (!t || !t.id || !t.type || !t.order) err(`${dir}/api.imljson`, 'polling trigger needs response.trigger {id, type, order}');
  }
  if (kind === 'search' || kind === 'trigger') {
    if (!api.response || !api.response.iterate) err(`${dir}/api.imljson`, 'needs response.iterate');
    if (!api.response || !api.response.limit) err(`${dir}/api.imljson`, 'needs response.limit');
    if (!declared.has('limit')) err(dir, 'needs a Limit parameter');
    const fields = (kind === 'trigger' ? params : expect).filter((p) => p && p.type !== 'banner');
    const lim = fields.find((p) => p.name === 'limit');
    if (lim) {
      if (lim.advanced) err(dir, 'Limit must not be advanced');
      if (kind === 'trigger' && !lim.required) err(dir, 'polling trigger Limit must be required');
      if (kind === 'search') {
        if (lim.required) err(dir, 'search Limit must not be required (empty = all results)');
        if (lim.default !== 10) err(dir, 'search Limit should default to 10');
        const standard = fields.filter((p) => !p.advanced);
        if (standard[standard.length - 1] !== lim) err(dir, 'Limit should be the last standard (non-advanced) field');
      }
    }
    if (!api.pagination) notes.push(`${dir}: no pagination`);
  }

  // interface ↔ output ↔ samples
  const ifaceNames = new Set(iface.map((p) => p.name));
  const output = api.response && api.response.output;
  const outKeys = outputKeys(output);
  if (outKeys) {
    for (const k of outKeys.keys) if (!ifaceNames.has(k)) err(`${dir}/api.imljson`, `output "${k}" is not in the interface`);
    if (!outKeys.spread) for (const k of ifaceNames) if (!outKeys.keys.has(k)) err(`${dir}/interface.imljson`, `"${k}" is not produced by the output`);
  }
  // date-typed outputs must be parsed (parseDate / parseDateFields), not passed as API strings
  const dateFields = iface.filter((p) => p.type === 'date').map((p) => p.name);
  if (dateFields.length && typeof output === 'string' && !/parseDate(Fields)?\(/.test(output)) {
    err(`${dir}/api.imljson`, `outputs date fields (${dateFields.join(', ')}) without parsing them`);
  }
  if (dateFields.length && outKeys) {
    for (const k of dateFields) {
      const v = output[k];
      if (v !== undefined && !/parseDate(Fields)?\(/.test(String(v))) err(`${dir}/api.imljson`, `date field "${k}" is output without parseDate`);
      if (v === undefined && outKeys.spread && !new RegExp(`omit\\([^)]*'${k}'`).test(output[SPREAD])) err(`${dir}/api.imljson`, `date field "${k}" comes from the spread unparsed (omit it and parse it)`);
    }
  }
  checkInterfaceSample(dir, iface, samples);
}

for (const r of rpcs) if (!rpcRefs.has(r)) err(`rpcs/${r}`, 'not used by any module');

// ─── 5. Custom IML functions ──────────────────────────────────────────

const functions = dirsOf('functions');
for (const name of functions) {
  const code = functionFiles.get(`functions/${name}/code.js`);
  const test = functionFiles.get(`functions/${name}/test.js`);
  if (!code) {
    err(`functions/${name}`, 'missing code.js');
    continue;
  }
  if (!new RegExp(`^function ${name}\\(`, 'm').test(code)) err(`functions/${name}/code.js`, `must define function ${name}(...)`);
  if (!test) {
    err(`functions/${name}`, 'missing test.js');
    continue;
  }
  // Same API as Make's function tests: it(name, fn) + assert. Only built-ins, no require/process.
  const results = [];
  const ctx = vm.createContext({ assert, debug: () => {}, it: (title, fn) => results.push([title, fn]) });
  try {
    vm.runInContext(`${code}\n${test}`, ctx, { timeout: 10000 });
    for (const [title, fn] of results) {
      try {
        fn();
      } catch (e) {
        err(`functions/${name}/test.js`, `"${title}" failed: ${e.message}`);
      }
    }
    if (!results.length) err(`functions/${name}/test.js`, 'has no it(...) tests');
    else notes.push(`functions/${name}: ${results.length} test(s) run`);
  } catch (e) {
    err(`functions/${name}`, `does not run: ${e.message}`);
  }
}
// Every function called in IML is a Make built-in we use or a custom function of this app.
const BUILTIN_IML = new Set(['if', 'ifempty', 'omit', 'pick', 'parseDate', 'formatDate', 'toCollection', 'replace', 'length', 'contains', 'get', 'join', 'merge', 'first', 'last', 'map', 'keys', 'toString', 'parseNumber', 'trim', 'lower', 'upper', 'encodeURL', 'addDays', 'now']);
for (const [rel, data] of docs) {
  for (const expr of imlExpressions(data)) {
    for (const m of expr.replace(/'[^']*'/g, "''").matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\(/g)) {
      const fn = m[1];
      if (!BUILTIN_IML.has(fn) && !functions.includes(fn)) err(rel, `calls ${fn}(), neither a known IML built-in nor a custom function in app/functions`);
    }
  }
}

// groups
const grouped = new Map();
for (const g of get('groups.json') || []) {
  for (const m of g.modules || []) {
    if (!modules.includes(m)) err('groups.json', `module "${m}" does not exist`);
    if (grouped.has(m)) err('groups.json', `module "${m}" is in two groups`);
    grouped.set(m, g.label);
  }
}
for (const m of modules) if (!grouped.has(m)) err('groups.json', `module "${m}" is in no group`);

// ─── 4. Secrets and private data ──────────────────────────────────────

const SECRET_PATTERNS = [
  [/bsk_(live|test)_[A-Za-z0-9]{8,}/, 'API key'],
  [/whsec_[A-Za-z0-9_-]{8,}/, 'webhook secret'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'e-mail address'],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'IP address'],
  [/\+?998\d{9}\b/, 'full phone number'],
];
const scanTargets = [...walk(APP), join(HERE, 'generate.mjs'), join(HERE, '..', 'README.md')].filter(existsSync);
for (const path of scanTargets) {
  const text = readFileSync(path, 'utf8');
  for (const [re, what] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m && !/^\+?998901234567$/.test(m[0])) err(relative(join(HERE, '..'), path), `looks like a ${what}: ${m[0]}`);
  }
}

// ─── Report ───────────────────────────────────────────────────────────

console.log(`Parsed ${docs.size} JSON files and ${functionFiles.size} function files: ${connections.length} connection, ${webhooks.length} webhooks, ${rpcs.length} RPCs, ${functions.length} custom IML function(s), ${modules.length} modules.`);
console.log(`Editor-schema validated: ${validated} sections; without an editor schema (checked by the rules above only): ${notValidated.length}.`);
for (const n of notes) console.log(`note: ${n}`);
if (errors.length) {
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`${errors.length} problem(s).`);
  process.exit(1);
}
console.log('OK: no problems found.');
