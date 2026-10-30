// @aircloudhq/testing — Air-Flex field policy (#384 ADR-294 decisions 1 to 5 and 7; ADR-122 facet 2), the
// in-memory mirror of flex/src/policy.rs (the grammar, `parse_rule`, the uniform / non-evaluable
// classification of `compile_artifact`) and of the per-row evaluation ADR-294 decision 5 folds into SQL,
// fixed by the shared vectors contracts/flex/v1/field-policy-vectors.json (run by
// test/flex_policy_vectors.test.mjs).
//
// THE RULES OF A ROW. A rule is {field, effect ∈ visible|writable|required, when}. The base layer's rules
// sit at `/` (the declaration's `policy`); an overlay's at its node, strictly below `/`. A row at node N
// is governed by the rules of N's chain — base first, then each overlay from the root down, each node's in
// publish order — so an overlay only adds rules and never relaxes one. `when` is decided per row in
// Kleene logic over the stored row's `record.*` values, the actor's roles effective AT THE ROW'S NODE
// (`actor.roles`), the acting principal's sub and node, the request's surface and the quantized `env.now`;
// a condition that cannot be decided (a field the row does not hold, a rule no longer parsing against the
// entity's fields) decides AGAINST the actor: hidden, not writable, required.
//
// The grammar's declared constants are the generated projection of the vectors' `grammar` block
// (`world.contract.fieldPolicy`), never literals here.
import { CapabilityFailure } from "../errors.js";
import { atOrBelow } from "./authz.js";
import { canonicalize, compareNative, validateOperand, validation } from "./flex-values.js";
import { QUERY_TABLES } from "./flex-query.js";

const ROLE_RE = /^[a-z0-9][a-z0-9_-]*$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** The inputs that are the same for every row a request reaches (`compile_artifact` `uniform`). */
const UNIFORM_READS = ["surface", "env.now", "actor.sub", "actor.org_path"];

class PolicyError extends Error {}
const bad = (m) => new PolicyError(m);

/** Parse a `when` condition against the entity's live `fields` under the grammar `g` (policy.rs parse_cond). */
function parseCond(g, fields, v, depth, n, validOrgPath) {
  if (depth > g.maxDepth) throw bad(`condition depth exceeds the cap ${g.maxDepth}`);
  if (!isObj(v)) throw bad("a condition node must be an object");
  const structural = Object.keys(v).filter((k) => ["and", "or", "not", "ref"].includes(k));
  if (structural.length !== 1) throw bad("a condition node has exactly one of a combinator or 'ref'");
  const key = structural[0];
  if (key !== "ref") {
    if (!g.combinators.includes(key)) throw bad(`combinator '${key}' is outside the policy grammar`);
    if (Object.keys(v).length !== 1) throw bad(`'${key}' node carries other keys`);
    if (!Array.isArray(v[key]) || v[key].length === 0) throw bad(`'${key}' must be a non-empty array`);
    return { [key]: v[key].map((c) => parseCond(g, fields, c, depth + 1, n, validOrgPath)) };
  }
  n.count++;
  if (n.count > g.maxPredicates) throw bad(`condition has more than ${g.maxPredicates} predicates`);
  for (const k of Object.keys(v)) if (!["ref", "op", "value"].includes(k)) throw bad(`unknown condition leaf key '${k}' (a leaf is {ref, op, value})`);
  if (typeof v.ref !== "string") throw bad("a leaf 'ref' must be a string");
  if (typeof v.op !== "string") throw bad("a leaf requires an 'op' string");
  if (!("value" in v)) throw bad("a leaf requires a 'value'");
  const { ref, op, value } = v;
  if (ref.startsWith("record.")) return recordLeaf(fields, ref.slice("record.".length), op, value);
  const textOp = (one, what) => {
    if (op === "eq" || op === "neq") return { op, values: [one(value)] };
    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.length > QUERY_TABLES.MAX_IN_VALUES) throw bad(`${what} in takes a non-empty list`);
      return { op, values: value.map(one) };
    }
    throw bad(`${what} ${op} has no evaluator`);
  };
  if (ref in g.actorOps) {
    if (!g.actorOps[ref].includes(op)) throw bad(`op '${op}' is outside ${ref}'s ops`);
    if (ref === "actor.roles") {
      if (op !== "contains" || typeof value !== "string" || !ROLE_RE.test(value)) throw bad("actor.roles contains a role key");
      return { roles: value };
    }
    if (ref === "actor.sub") {
      return { input: "actor.sub", ...textOp((x) => { if (typeof x !== "string" || x === "") throw bad("actor.sub compares a non-empty string"); return x; }, ref) };
    }
    if (ref === "actor.org_path") {
      return { input: "actor.org_path", ...textOp((x) => { if (!validOrgPath(x)) throw bad("actor.org_path compares an org path"); return x; }, ref) };
    }
    throw bad(`${ref} ${op} has no evaluator in this binary`);
  }
  if (ref === "env.now") {
    if (!g.envNowOps.includes(op)) throw bad(`op '${op}' is outside env.now's ops`);
    const at = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) throw bad("env.now compares an RFC 3339 instant");
    return { now: op, at };
  }
  if (ref === "surface") {
    if (!g.surfaceOps.includes(op)) throw bad(`op '${op}' is outside surface's ops`);
    return { input: "surface", ...textOp((x) => { if (!g.surfaces.includes(x)) throw bad(`${JSON.stringify(x)} is not a declared surface`); return x; }, "surface") };
  }
  throw bad(`'${ref}' is outside the policy namespaces (record.*, actor.roles|sub|org_path, env.now, surface)`);
}

function recordLeaf(fields, name, op, value) {
  const f = fields.find((x) => x.name === name);
  if (!f) throw bad(`record.${name} is not a field of the entity`);
  if (!(QUERY_TABLES.OP_MATRIX[f.type] ?? []).includes(op)) throw bad(`op '${op}' is not legal on record.${name} (type '${f.type}')`);
  const operand = (x) => {
    try {
      validateOperand(f, x);
      return canonicalize(f, x);
    } catch (e) {
      if (e instanceof CapabilityFailure) throw bad(`record.${name}: ${e.detail}`);
      throw e;
    }
  };
  if (op === "is_null") {
    if (typeof value !== "boolean") throw bad("is_null takes a boolean");
    return { field: f, op, value };
  }
  if (op === "in") {
    if (!Array.isArray(value) || value.length > QUERY_TABLES.MAX_IN_VALUES) throw bad("'in' takes a bounded list");
    return { field: f, op, value: value.map(operand) };
  }
  return { field: f, op, value: operand(value) };
}

/** The namespaces a parsed condition reads. */
function reads(c, out = new Set()) {
  if (c.and || c.or) for (const x of c.and ?? c.or) reads(x, out);
  else if (c.field) out.add("record");
  else if (c.roles) out.add("actor.roles");
  else if (c.now) out.add("env.now");
  else out.add(c.input);
  return out;
}

/**
 * The namespaces a compiled rule reads, in `order` (requests.json `$defs.policy_reads`, the compiler's
 * `reads`); a non-evaluable rule (`cond: null`) reads nothing it can be decided on.
 */
export function ruleReads(r, order) {
  if (r.cond === null) return [];
  const got = reads(r.cond);
  return order.filter((x) => got.has(x));
}

/**
 * Parse one authored rule {field, effect, when} against the entity's live `fields` — the shape `node`
 * stores — or refuse with flex.validation (an overlay; the declaration-time equivalent is the release's
 * schema.policy_invalid).
 */
export function parseRule(g, fields, v, node, validOrgPath) {
  try {
    if (!isObj(v)) throw bad("a policy rule must be an object");
    for (const k of Object.keys(v)) if (!["field", "effect", "when"].includes(k)) throw bad(`unknown policy rule key '${k}'`);
    if (typeof v.field !== "string") throw bad("a policy rule requires a 'field' string");
    if (!fields.some((f) => f.name === v.field)) throw bad(`policy rule names '${v.field}', a field the entity does not declare`);
    if (typeof v.effect !== "string" || !g.effects.includes(v.effect)) throw bad(`unknown policy effect '${String(v.effect)}'`);
    if (!("when" in v)) throw bad("a policy rule requires a 'when' condition");
    parseCond(g, fields, v.when, 1, { count: 0 }, validOrgPath);
    return { field: v.field, effect: v.effect, when: v.when, node };
  } catch (e) {
    if (e instanceof PolicyError) throw validation(e.message);
    throw e;
  }
}

/**
 * The rules governing a row at `node`, parsed against the entity's live `fields`: base first, then each
 * overlay from the root down, each node's in publish order. A rule whose field is no longer live governs
 * nothing; one whose condition no longer parses is non-evaluable (`cond: null`).
 */
export function rulesAt(g, rules, fields, node, validOrgPath) {
  const depth = (p) => (p === "/" ? 0 : p.split("/").length - 1);
  return rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => atOrBelow(node, r.node) && fields.some((f) => f.name === r.field))
    .sort((a, b) => depth(a.r.node) - depth(b.r.node) || a.i - b.i)
    .map(({ r }) => {
      let cond = null;
      try {
        cond = parseCond(g, fields, r.when, 1, { count: 0 }, validOrgPath);
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
      }
      const uniform = cond !== null && [...reads(cond)].every((x) => UNIFORM_READS.includes(x));
      return { ...r, cond, uniform };
    });
}

/** `env.now` read quantized down to a multiple of the grammar's quantum (invariant e). */
export function quantizedNow(g, nowMs) {
  const q = g.envNowQuantumSeconds * 1000;
  return Math.floor(nowMs / q) * q;
}

/** Decide `c` (Kleene: true | false | null) over `ctx` = {data, roles, sub, orgPath, surface, nowQ}. */
function decide(c, ctx) {
  if (c.and) {
    let unknown = false;
    for (const x of c.and) {
      const r = decide(x, ctx);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (c.or) {
    let unknown = false;
    for (const x of c.or) {
      const r = decide(x, ctx);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (c.roles) return ctx.roles.includes(c.roles);
  if (c.now) {
    const { nowQ } = ctx;
    return { lt: nowQ < c.at, lte: nowQ <= c.at, gt: nowQ > c.at, gte: nowQ >= c.at }[c.now] ?? null;
  }
  if (c.input) {
    const v = c.input === "surface" ? ctx.surface : c.input === "actor.sub" ? ctx.sub : ctx.orgPath;
    if (typeof v !== "string") return null;
    return c.op === "eq" ? c.values[0] === v : c.op === "neq" ? c.values[0] !== v : c.values.includes(v);
  }
  const v = ctx.data?.[c.field.name];
  const present = v !== undefined && v !== null;
  if (c.op === "is_null") return c.value ? !present : present;
  if (!present) return null;
  try {
    validateOperand(c.field, v);
  } catch {
    return null; // a stored value of the wrong type is undecidable — against the actor
  }
  if (c.op === "contains") return String(v).includes(c.value);
  if (c.op === "in") return c.value.some((x) => compareNative(c.field.type, v, x) === 0);
  const k = compareNative(c.field.type, v, c.value);
  return { eq: k === 0, neq: k !== 0, gt: k > 0, gte: k >= 0, lt: k < 0, lte: k <= 0 }[c.op] ?? null;
}

/** Whether rule `r` holds over `ctx` — an undecidable or non-evaluable rule decides against the actor. */
export function holds(r, ctx) {
  const v = r.cond === null ? null : decide(r.cond, ctx);
  return v === null ? r.effect === "required" : v;
}

/**
 * The rules that bind a request on `surface` (#384 run decision D117; the grammar's `unbound_effects`):
 * `import` — repository-declared data, the Builder's own authority — is bound by neither `visible` nor
 * `writable`; `required` binds every surface. Unbound rules are not evaluated at all.
 */
export function bindingRules(g, rules, surface) {
  const unbound = g.unboundEffects[surface] ?? [];
  return rules.filter((r) => !unbound.includes(r.effect));
}

/** The fields a row hides from the actor: a field any `visible` rule of the row's chain does not admit. */
export function hiddenFields(rules, ctx) {
  const hidden = new Set();
  for (const r of rules) if (r.effect === "visible" && !holds(r, ctx)) hidden.add(r.field);
  return hidden;
}

/** The refusal naming a rule (flex.forbidden, details.rule = {field, effect, node}). */
export function ruleRefusal(r, why) {
  return new CapabilityFailure("flex.forbidden", `${why} (rule ${r.effect} on '${r.field}' at ${r.node})`, {
    rule: { field: r.field, effect: r.effect, node: r.node },
  });
}

/**
 * ADR-294 decision 5: a query term on a field a BASE-LAYER rule hides on inputs that are the same for every
 * row (its condition reads only surface, env.now, actor.sub and actor.org_path) is refused up front;
 * every other hidden term takes the per-row fold. `terms` are the field names the query names.
 */
export function refuseHiddenTerms(baseRules, terms, ctx) {
  for (const field of terms) {
    const r = baseRules.find((x) => x.node === "/" && x.field === field && x.effect === "visible" && x.uniform && !holds(x, ctx));
    if (r) throw ruleRefusal(r, `'${field}' is hidden for this whole request`);
  }
}

/** The field names a parsed query names in a filter, sort, aggregate or vector term. */
export function queryTerms(q) {
  const out = [];
  const walk = (n) => {
    if (n.and || n.or) (n.and ?? n.or).forEach(walk);
    else if (n.not) walk(n.not);
    else out.push(n.leaf.field.name);
  };
  if (q.filter) walk(q.filter);
  for (const k of q.sort) out.push(k.field.name);
  if (q.aggregate?.field) out.push(q.aggregate.field.name);
  if (q.aggregate?.groupBy) out.push(q.aggregate.groupBy.name);
  if (q.search?.vector) out.push(q.search.vector.field);
  return out;
}

/**
 * The write effects at a row (ADR-294 decision 5): every `writable` rule of the row's chain whose field the
 * write CHANGES must hold over `before` (the stored row; on create, the submitted row) — the first failing
 * rule in chain order is named; then every `required` rule holding over `after` (the row the write would
 * produce) requires its field there (flex.validation naming it).
 */
export function checkWrite(rules, changed, before, after) {
  for (const r of rules) {
    if (r.effect === "writable" && changed.has(r.field) && !holds(r, before)) throw ruleRefusal(r, `'${r.field}' is not writable here`);
  }
  for (const r of rules) {
    if (r.effect !== "required" || !holds(r, after)) continue;
    const v = after.data[r.field];
    if (v === undefined || v === null) throw validation(`'${r.field}' is required here (rule required at ${r.node})`, r.field);
  }
}
