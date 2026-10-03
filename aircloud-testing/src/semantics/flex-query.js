// @aircloudhq/testing — the Air-Flex I5 query grammar, evaluated in memory.
//
// Parse rules, caps and messages mirror flex/src/ast.rs (parse_query and friends); evaluation
// mirrors the SQL flex/src/sqlgen.rs compiles, INCLUDING SQL three-valued logic: a comparison
// against an absent/null field is UNKNOWN, `NOT UNKNOWN` is UNKNOWN, and only TRUE rows return —
// so `{"not": {"field": "x", "op": "eq", "value": 1}}` does not match a row without `x`, exactly as
// the chokepoint behaves. Order is (sort keys NULLS LAST in both directions, then id ASC); the
// keyset cursor pages strictly after the boundary row in that total order.
import { CapabilityFailure } from "../errors.js";
import {
  avgDecimals, canonicalize, compareNative, formatDatetimeMicros, formatDecimal, parseDatetime,
  parseDecimal, sumDecimals, validateValue, validation,
} from "./flex-values.js";

const MAX_FILTER_DEPTH = 4;
const MAX_PREDICATES = 32;
const MAX_IN_VALUES = 64;
const MAX_SORT_KEYS = 3;
const MAX_FTS_LEN = 1024;
const MIN_VECTOR_K = 1;
const MAX_VECTOR_K = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_GROUPS = 1000;
const QUERY_KEYS = ["filter", "sort", "limit", "cursor", "search", "aggregate"];

const OP_MATRIX = {
  text: ["eq", "neq", "in", "contains", "is_null"],
  integer: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null"],
  decimal: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null"],
  datetime: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null"],
  boolean: ["eq", "neq", "is_null"],
  relation: ["eq", "neq", "in", "is_null"],
  json: ["is_null"],
  file: ["is_null"],
  vector: ["is_null"],
};
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "is_null"];
const SORTABLE = ["text", "integer", "decimal", "datetime", "date"];
const AGG_FNS = ["count", "sum", "avg", "min", "max"];
const GROUP_BY_TYPES = ["text", "integer", "boolean", "date", "relation"];

export const QUERY_TABLES = { OP_MATRIX, SORTABLE, GROUP_BY_TYPES };

function complexity(message) {
  return new CapabilityFailure("flex.complexity_cap", message, {});
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function resolveField(fields, name) {
  const f = fields.find((x) => x.name === name);
  if (!f) throw validation(`unknown field '${name}'`, name);
  return f;
}

// ── parse ──────────────────────────────────────────────────────────────────────────────
export function parseQuery(fields, body) {
  if (!isObj(body)) throw validation("query body must be a JSON object");
  for (const k of Object.keys(body)) if (!QUERY_KEYS.includes(k)) throw validation(`unknown query key '${k}'`);

  const search = "search" in body ? parseSearch(fields, body.search) : null;
  const filter = "filter" in body ? parseFilter(fields, body.filter, 1, { n: 0 }) : null;
  const aggregate = "aggregate" in body ? parseAggregate(fields, body.aggregate) : null;
  const sort = "sort" in body ? parseSort(fields, body.sort) : [];

  let limit = DEFAULT_LIMIT;
  if ("limit" in body) {
    const n = body.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw validation("limit must be an integer 1..=200", "limit");
    if (n < MIN_LIMIT || n > MAX_LIMIT) throw validation(`limit ${n} out of range ${MIN_LIMIT}..=${MAX_LIMIT}`, "limit");
    limit = n;
  }
  let cursor = null;
  if ("cursor" in body) {
    if (typeof body.cursor !== "string") throw validation("cursor must be a string", "cursor");
    cursor = decodeCursor(body.cursor, sort);
  }
  if (aggregate) {
    if (sort.length > 0) throw validation("aggregate is incompatible with sort");
    if (cursor) throw validation("aggregate is incompatible with cursor");
  }
  if (search && search.vector) {
    if (sort.length > 0) throw validation("search.vector is incompatible with sort");
    if (cursor) throw validation("search.vector is incompatible with cursor");
    if (aggregate) throw validation("search.vector is incompatible with aggregate");
  }
  return { filter, sort, limit, cursor, aggregate, search };
}

function parseSearch(fields, v) {
  if (!isObj(v)) throw validation("search must be a JSON object");
  for (const k of Object.keys(v)) if (k !== "fts" && k !== "vector") throw validation(`unknown search key '${k}'`);
  let fts = null;
  if ("fts" in v) {
    if (typeof v.fts !== "string") throw validation("search.fts must be a string", "fts");
    if (v.fts.length === 0) throw validation("search.fts must be non-empty", "fts");
    if (Buffer.byteLength(v.fts, "utf8") > MAX_FTS_LEN) throw validation(`search.fts exceeds ${MAX_FTS_LEN} bytes`, "fts");
    fts = v.fts;
  }
  const vector = "vector" in v ? parseVector(fields, v.vector) : null;
  if (fts === null && vector === null) throw validation("search must carry at least one of 'fts' or 'vector'");
  return { fts, vector };
}

function parseVector(fields, v) {
  if (!isObj(v)) throw validation("search.vector must be a JSON object");
  for (const k of Object.keys(v)) if (!["field", "query", "metric", "k"].includes(k)) throw validation(`unknown search.vector key '${k}'`);
  if (typeof v.field !== "string") throw validation("search.vector 'field' must be a string");
  const f = resolveField(fields, v.field);
  if (f.type !== "vector") throw validation(`search.vector requires a vector-typed field, got '${f.type}'`, v.field);
  if (typeof v.metric !== "string") throw validation("search.vector 'metric' must be a string");
  if (v.metric !== "cosine") throw validation(`search.vector metric '${v.metric}' is not supported (v1: 'cosine' only)`, v.field);
  if (!Array.isArray(v.query)) throw validation("search.vector 'query' must be an array of numbers");
  if (v.query.length !== f.parsed.dims) {
    throw validation(`search.vector query length ${v.query.length} != declared dims ${f.parsed.dims}`, v.field);
  }
  v.query.forEach((el, i) => {
    if (typeof el !== "number") throw validation(`search.vector query element ${i} is not a number`, v.field);
  });
  if (typeof v.k !== "number" || !Number.isInteger(v.k) || v.k < 0) throw validation("search.vector 'k' must be an integer 1..=100");
  if (v.k < MIN_VECTOR_K || v.k > MAX_VECTOR_K) throw validation(`search.vector k ${v.k} out of range ${MIN_VECTOR_K}..=${MAX_VECTOR_K}`);
  return { field: f.name, query: v.query, k: v.k };
}

function parseFilter(fields, v, depth, predicates) {
  if (depth > MAX_FILTER_DEPTH) throw complexity(`filter depth exceeds max ${MAX_FILTER_DEPTH}`);
  if (!isObj(v)) throw validation("filter node must be a JSON object");
  const n = ["and", "or", "not", "field"].filter((k) => k in v).length;
  if (n !== 1) throw validation("filter node must have exactly one of 'and', 'or', 'not', or 'field'");
  for (const comb of ["and", "or"]) {
    if (comb in v) {
      const list = v[comb];
      if (!Array.isArray(list)) throw validation(`'${comb}' must be an array of filters`);
      if (list.length === 0) throw validation(`'${comb}' must contain at least one filter`);
      return { [comb]: list.map((c) => parseFilter(fields, c, depth + 1, predicates)) };
    }
  }
  if ("not" in v) return { not: parseFilter(fields, v.not, depth + 1, predicates) };
  return { leaf: parseLeaf(fields, v, predicates) };
}

function parseLeaf(fields, obj, predicates) {
  predicates.n++;
  if (predicates.n > MAX_PREDICATES) throw complexity(`filter has more than ${MAX_PREDICATES} predicates`);
  for (const k of Object.keys(obj)) if (!["field", "op", "value"].includes(k)) throw validation(`unknown leaf key '${k}'`);
  if (typeof obj.field !== "string") throw validation("leaf 'field' must be a string");
  if (typeof obj.op !== "string") throw validation("leaf 'op' must be a string");
  if (!("value" in obj)) throw validation("leaf requires a 'value'");
  const f = resolveField(fields, obj.field);
  if (!OPS.includes(obj.op)) throw validation(`unknown filter op '${obj.op}'`);
  if (!OP_MATRIX[f.type].includes(obj.op)) throw validation(`op '${obj.op}' is not legal on type '${f.type}'`, obj.field);
  const value = obj.value;
  if (obj.op === "is_null") {
    if (typeof value !== "boolean") throw validation("is_null 'value' must be a boolean", obj.field);
    return { field: f, op: "is_null", value };
  }
  if (obj.op === "in") {
    if (!Array.isArray(value)) throw validation("'in' value must be an array", obj.field);
    if (value.length > MAX_IN_VALUES) throw validation(`'in' list exceeds ${MAX_IN_VALUES} values`, obj.field);
    return { field: f, op: "in", value: value.map((el) => { validateValue(f, el); return canonicalize(f, el); }) };
  }
  validateValue(f, value);
  return { field: f, op: obj.op, value: canonicalize(f, value) };
}

function parseSort(fields, v) {
  if (!Array.isArray(v)) throw validation("sort must be an array");
  if (v.length > MAX_SORT_KEYS) throw validation(`sort has more than ${MAX_SORT_KEYS} keys`);
  return v.map((entry) => {
    if (!isObj(entry)) throw validation("sort key must be an object");
    for (const k of Object.keys(entry)) if (k !== "field" && k !== "dir") throw validation(`unknown sort key '${k}'`);
    if (typeof entry.field !== "string") throw validation("sort 'field' must be a string");
    let dir = "asc";
    if ("dir" in entry) {
      if (typeof entry.dir !== "string") throw validation("sort 'dir' must be a string");
      if (entry.dir !== "asc" && entry.dir !== "desc") throw validation(`sort dir must be 'asc' or 'desc', got '${entry.dir}'`);
      dir = entry.dir;
    }
    const f = resolveField(fields, entry.field);
    if (!SORTABLE.includes(f.type)) throw validation(`type '${f.type}' is not sortable`, entry.field);
    return { field: f, dir };
  });
}

function parseAggregate(fields, v) {
  if (!isObj(v)) throw validation("aggregate must be an object");
  for (const k of Object.keys(v)) if (!["fn", "field", "group_by"].includes(k)) throw validation(`unknown aggregate key '${k}'`);
  if (typeof v.fn !== "string") throw validation("aggregate 'fn' must be a string");
  if (!AGG_FNS.includes(v.fn)) throw validation(`unknown aggregate fn '${v.fn}'`);
  let field = null;
  if ("field" in v) {
    if (typeof v.field !== "string") throw validation("aggregate 'field' must be a string");
    field = resolveField(fields, v.field);
    const legal = v.fn === "count" ? true
      : v.fn === "sum" || v.fn === "avg" ? ["integer", "decimal"].includes(field.type)
      : SORTABLE.includes(field.type);
    if (!legal) throw validation(`aggregate '${v.fn}' is not legal on type '${field.type}'`, v.field);
  } else if (v.fn !== "count") {
    throw validation(`aggregate '${v.fn}' requires a 'field'`);
  }
  let groupBy = null;
  if ("group_by" in v) {
    if (typeof v.group_by !== "string") throw validation("aggregate 'group_by' must be a string");
    groupBy = resolveField(fields, v.group_by);
    if (!GROUP_BY_TYPES.includes(groupBy.type)) {
      throw validation(`group_by is not legal on type '${groupBy.type}' (bounded-cardinality types only)`, v.group_by);
    }
  }
  return { fn: v.fn, field, groupBy };
}

// ── cursor ─────────────────────────────────────────────────────────────────────────────
function sortSignature(sort) {
  return sort.map((k) => `${k.field.name}:${k.dir}`).join(",");
}

export function encodeCursor(sort, row) {
  const keys = sort.map((k) => {
    const v = row.data[k.field.name];
    return v === undefined || v === null ? null : canonicalize(k.field, v);
  });
  // serde_json's default map is ordered by key; the wire form is opaque either way.
  const json = JSON.stringify({ id: row.id, k: keys, s: sortSignature(sort), v: 1 });
  return Buffer.from(json, "utf8").toString("base64");
}

function decodeCursor(token, sort) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token) || token.length % 4 !== 0) throw validation("cursor is not valid base64", "cursor");
  let obj;
  try { obj = JSON.parse(Buffer.from(token, "base64").toString("utf8")); } catch { throw validation("cursor is not valid JSON", "cursor"); }
  if (!isObj(obj)) throw validation("cursor must be a JSON object", "cursor");
  if (typeof obj.s !== "string") throw validation("cursor missing sort signature", "cursor");
  if (obj.s !== sortSignature(sort)) throw validation("cursor does not match the request's sort spec", "cursor");
  if (!Array.isArray(obj.k)) throw validation("cursor missing keys array", "cursor");
  if (obj.k.length !== sort.length) throw validation("cursor key count does not match the sort spec", "cursor");
  if (typeof obj.id !== "string") throw validation("cursor missing id", "cursor");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.id)) throw validation("cursor id is not a UUID", "cursor");
  return { keys: obj.k, id: obj.id.toLowerCase() };
}

// ── evaluate ───────────────────────────────────────────────────────────────────────────
const present = (v) => v !== undefined && v !== null;

/** SQL 3VL: returns true | false | null (UNKNOWN). */
function evalFilter(node, data) {
  if (node.and) {
    let unknown = false;
    for (const c of node.and) {
      const r = evalFilter(c, data);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (node.or) {
    let unknown = false;
    for (const c of node.or) {
      const r = evalFilter(c, data);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (node.not) {
    const r = evalFilter(node.not, data);
    return r === null ? null : !r;
  }
  const { field, op, value } = node.leaf;
  const v = data[field.name];
  if (op === "is_null") return value ? !present(v) : present(v);
  if (!present(v)) return null;
  if (op === "contains") return String(v).includes(value);
  if (op === "in") return value.length === 0 ? false : value.some((x) => compareNative(field.type, v, x) === 0);
  const c = compareNative(field.type, v, value);
  switch (op) {
    case "eq": return c === 0;
    case "neq": return c !== 0;
    case "gt": return c > 0;
    case "gte": return c >= 0;
    case "lt": return c < 0;
    case "lte": return c <= 0;
    default: throw new Error(`@aircloudhq/testing: unhandled op ${op}`);
  }
}

function rowCompare(sort, a, b) {
  for (const k of sort) {
    const x = a[k.field.name];
    const y = b[k.field.name];
    const px = present(x);
    const py = present(y);
    if (!px && !py) continue;
    if (!px) return 1; // NULLS LAST in both directions
    if (!py) return -1;
    const c = compareNative(k.field.type, x, y);
    if (c !== 0) return k.dir === "asc" ? c : -c;
  }
  return 0;
}

function orderRows(sort, rows) {
  return [...rows].sort((a, b) => rowCompare(sort, a.data, b.data) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── full-text: jsonb_to_tsvector('simple', data, '["string"]') @@ websearch_to_tsquery ──────
// The 'simple' configuration lowercases and never stems; tokens are runs of letters and digits.
function tokens(s) {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function stringValues(v, out) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringValues(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringValues(x, out));
  return out;
}

/** websearch syntax: words (AND), "quoted phrases", `or`, `-negation`. */
function parseWebsearch(q) {
  const clauses = [[]]; // OR of ANDs
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[3] && m[3].toLowerCase() === "or") { clauses.push([]); continue; }
    const neg = m[1] === "-" || (m[3] && m[3].startsWith("-") && m[3].length > 1);
    const text = m[2] !== undefined ? m[2] : m[3].replace(/^-/, "");
    const toks = tokens(text);
    if (toks.length === 0) continue;
    clauses[clauses.length - 1].push({ neg, toks });
  }
  return clauses.filter((c) => c.length > 0);
}

function ftsMatch(q, data) {
  const docs = stringValues(data, []).map(tokens);
  const has = (toks) => docs.some((d) => {
    for (let i = 0; i + toks.length <= d.length; i++) {
      if (toks.every((t, j) => d[i + j] === t)) return true;
    }
    return false;
  });
  const clauses = parseWebsearch(q);
  if (clauses.length === 0) return false;
  return clauses.some((c) => c.every(({ neg, toks }) => (neg ? !has(toks) : has(toks))));
}

function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Run a parsed query over the entity's live records → the I5 response body object. */
export function runQuery(q, records) {
  let rows = records.filter((r) => {
    if (q.search && q.search.fts !== null && !ftsMatch(q.search.fts, r.data)) return false;
    return q.filter ? evalFilter(q.filter, r.data) === true : true;
  });

  if (q.aggregate) return runAggregate(q.aggregate, rows);

  if (q.search && q.search.vector) {
    const { field, query, k } = q.search.vector;
    const scored = rows.map((r) => ({ r, d: present(r.data[field]) ? cosineDistance(r.data[field], query) : null }));
    // pgvector ORDER BY ASC: numbers, then NaN, then NULL (NULLS LAST); ties by id.
    const rank = (x) => (x.d === null ? 2 : Number.isNaN(x.d) ? 1 : 0);
    scored.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.d - b.d : 0) || (a.r.id < b.r.id ? -1 : 1));
    return { records: scored.slice(0, k).map((x) => ({ id: x.r.id, data: x.r.data })), cursor: null };
  }

  rows = orderRows(q.sort, rows);
  if (q.cursor) {
    const boundary = { id: q.cursor.id, data: Object.fromEntries(q.sort.map((k, i) => [k.field.name, q.cursor.keys[i]])) };
    rows = rows.filter((r) => {
      const c = rowCompare(q.sort, r.data, boundary.data);
      return c > 0 || (c === 0 && r.id > boundary.id);
    });
  }
  const hasNext = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    records: page.map((r) => ({ id: r.id, data: r.data })),
    cursor: hasNext ? encodeCursor(q.sort, page[page.length - 1]) : null,
  };
}

function aggValue(agg, rows) {
  const { fn, field } = agg;
  if (fn === "count") return field ? rows.filter((r) => present(r.data[field.name])).length : rows.length;
  const vals = rows.map((r) => r.data[field.name]).filter(present);
  if (vals.length === 0) return null;
  if (fn === "sum") return formatDecimal(sumDecimals(vals.map((v) => parseDecimal(String(v)))));
  if (fn === "avg") return avgDecimals(vals.map((v) => parseDecimal(String(v))));
  const pick = vals.reduce((best, v) => {
    const c = compareNative(field.type, v, best);
    return (fn === "min" ? c < 0 : c > 0) ? v : best;
  });
  switch (field.type) {
    case "integer": return pick;
    case "decimal": return formatDecimal(parseDecimal(pick));
    case "datetime": return formatDatetimeMicros(parseDatetime(pick));
    default: return pick;
  }
}

function runAggregate(agg, rows) {
  if (!agg.groupBy) return { aggregate: { value: aggValue(agg, rows) } };
  const groups = [];
  for (const r of rows) {
    const g = present(r.data[agg.groupBy.name]) ? r.data[agg.groupBy.name] : null;
    let bucket = groups.find((b) => (b.group === null || g === null ? b.group === g : compareNative(agg.groupBy.type, b.group, g) === 0));
    if (!bucket) { bucket = { group: g, rows: [] }; groups.push(bucket); }
    bucket.rows.push(r);
  }
  if (groups.length > MAX_GROUPS) throw complexity(`grouped aggregate exceeds the max of ${MAX_GROUPS} distinct groups`);
  return { aggregate: { groups: groups.map((b) => ({ group: b.group, value: aggValue(agg, b.rows) })) } };
}
