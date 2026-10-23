// @aircloudhq/testing — Air-Flex (flex-query / flex-mutate / flex-schema) in memory.
//
// The guest reaches Flex through the functions host, which forwards each call to the flex-jit
// chokepoint (functions/src/caps_flex.rs) and returns the chokepoint's response BODY as the WIT
// string — or `"{}"` for a 204 — and passes a flex error envelope through verbatim. This module is
// that chokepoint, in memory: the request order (body cap → parse → resolve → validate → admit →
// write), the documents it returns (flex/src/exec.rs field_doc, serialize_record, to_doc) and the
// refusals it answers (contracts/flex/v1/errors.json codes, flex-jit messages).
//
// One environment's data per world: the double stands in for the environment the function under
// test runs in (ADR-111 isolates environments by data, and a unit test runs in one).
//
// WHO ACTS, AND WHERE (ADR-257). Every call resolves its acting principal through the one resolution
// (./acting.js): the bearer the function's Flex calls carry — `world.flex.bearer`, the function runtime's
// service account at `/` unless a test sets another — and, for an invocation serving a signed-in end user
// (`world.principal.signIn`), the host's end-user assertion. The session runs at the acting end user's node
// (decision 7), else the bearer's. Records are stored at the session's node; a session reads its node and
// below, plus the rows of a `shared` entity stored at a strict ancestor (SELECT only). An entity declaring
// `owner` scopes an acting end user without a bypass role to the records it owns (decision 4): create forces
// the owner to its sub, changing the owner is flex.forbidden, another's record is flex.not_found. An edge
// is visible when its source's row is, and, to an acting end user, only when both endpoints are. An entity
// declaring `write_roles` (ADR-279) refuses a create, update or delete by an acting end user holding none of
// the operation's roles with flex.role_required, before any record is read; the tenant is never checked. The
// behaviour is the shared vectors' (contracts/flex/v1/{owner-policy,org-scope,acting-principal,write-roles}-
// vectors.json, test/flex_owner_vectors.test.mjs).
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import { admit } from "./quota.js";
import {
  canonicalize, FIELD_TYPES, formatDatetimeMicros, ID_RE, jsonbForm, parseConfig, parseDefault, SLUG_RE,
  validateDefault, validateValue, validation,
} from "./flex-values.js";
import { dateAt, parseZone, ZONE_NAME_RE } from "./flex-zone.js";
import { parseQuery, runQuery } from "./flex-query.js";
import { atOrBelow, resolveActingPrincipal } from "./acting.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_SCHEMA_WRITER, productRoot, productSchemaFile } from "./i18n.js";

const MAX_BODY = 256 * 1024;
const RESERVED_ENTITY_PREFIX = "sys_";

// The gated meters each operation is admitted under (flex/src/exec.rs `self.admit(...)` sites).
export const FLEX_METERS = {
  query: "flex.query",
  recordCreate: "flex.record.create",
  recordUpdate: "flex.record.update",
  recordDelete: "flex.record.delete",
  entityCreate: "flex.entity.create",
  entityUpdate: "flex.entity.update",
  entityDelete: "flex.entity.delete",
  fieldCreate: "flex.field.create",
  fieldUpdate: "flex.field.update",
  fieldDelete: "flex.field.delete",
};

function notFound(message) {
  return new CapabilityFailure("flex.not_found", message, {});
}

function forbidden(message) {
  return new CapabilityFailure("flex.forbidden", message, {});
}

/** ADR-279 decision 3: the refusal names the rule; its details depend on the entity and operation only. */
function roleRequired(entity, operation, required) {
  return new CapabilityFailure("flex.role_required", `${operation} on '${entity}' requires one of the roles ${JSON.stringify(required)}`, {
    entity, operation, rule: `write_roles.${operation}`, required: [...required],
  });
}

// The record writes write_roles names (flex/src/converge.rs WRITE_OPERATIONS) and the role-key grammar.
const WRITE_OPERATIONS = ["create", "update", "delete"];
const ROLE_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** A declared `write_roles` as {create, update, delete} lists (absent and null are empty), or a refusal. */
function parseWriteRoles(name, w) {
  const out = { create: [], update: [], delete: [] };
  if (w === undefined || w === null) return out;
  if (!isObj(w)) throw validation(`entity '${name}': 'write_roles' must be an object of create, update and delete`);
  for (const [op, list] of Object.entries(w)) {
    if (!WRITE_OPERATIONS.includes(op)) throw validation(`unknown key '${op}' in entity '${name}' write_roles (allowed: ${WRITE_OPERATIONS.join(", ")})`);
    if (list === null) continue;
    if (!Array.isArray(list) || list.some((k, i) => typeof k !== "string" || !ROLE_KEY_RE.test(k) || list.indexOf(k) !== i)) {
      throw validation(`entity '${name}': 'write_roles.${op}' must be distinct role keys (^[a-z0-9][a-z0-9_-]*$)`);
    }
    out[op] = [...list];
  }
  return out;
}

function unauthenticated(message) {
  return new CapabilityFailure("flex.unauthenticated", message, {});
}

/** `node` is a strict ancestor of `of`. */
function strictAncestor(node, of) {
  return node !== of && atOrBelow(of, node);
}

/** The bearer a function's Flex calls carry: the function runtime's service account at the root (ADR-242). */
export const RUNTIME_BEARER = Object.freeze({ plane: "service", sub: "function-runtime", roles: null, org_path: "/" });

function nameConflict() {
  return new CapabilityFailure("flex.name_conflict", "a live record with that name already exists", {});
}

function parseBody(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) throw validation(`request body exceeds ${MAX_BODY} bytes`);
  if (text.length === 0) return {};
  try { return JSON.parse(text); } catch (e) { throw validation(`invalid JSON body: ${e.message}`); }
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Uuid::parse_str's accepted spellings → canonical lowercase hyphenated, or null. */
function parseUuid(s) {
  let hex = s.trim();
  if (/^urn:uuid:/i.test(hex)) hex = hex.slice(9);
  if (hex.startsWith("{") && hex.endsWith("}")) hex = hex.slice(1, -1);
  let flat;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hex)) flat = hex.replace(/-/g, "");
  else if (/^[0-9a-f]{32}$/i.test(hex)) flat = hex;
  else return null;
  flat = flat.toLowerCase();
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20)}`;
}

function parseNewField(v) {
  if (!isObj(v)) throw validation("field spec must be an object");
  if (typeof v.name !== "string") throw validation("field 'name' is required");
  if (!SLUG_RE.test(v.name)) throw validation(`'${v.name}' is not a valid API name (grammar ^[a-z][a-z0-9_]{0,62}$)`);
  const displayName = typeof v.display_name === "string" ? v.display_name : v.name;
  if (typeof v.type !== "string") throw validation("field 'type' is required");
  if (!FIELD_TYPES.includes(v.type)) throw validation(`unknown field type '${v.type}'`);
  const config = "config" in v ? v.config : {};
  const parsed = parseConfig(v.type, config);
  const required = typeof v.required === "boolean" ? v.required : false;
  // ADR-259 decision 3: the tagged default, judged against the field it is declared on.
  const dflt = "default" in v ? scopedTo("default", () => validateDefault({ type: v.type, parsed }, parseDefault(v.default))) : null;
  return { name: v.name, displayName, type: v.type, config, parsed, required, default: dflt };
}

/** Run `fn`, scoping a flex.validation refusal to `field` (details.fields.<field>). */
function scopedTo(field, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CapabilityFailure && e.code === "flex.validation") throw validation(e.detail, field);
    throw e;
  }
}

/** The I5 field doc; `default` only when the field has one (ADR-259 decision 3). */
function fieldDoc(f) {
  const doc = { id: f.id, name: f.name, display_name: f.displayName, type: f.type, config: f.config, required: f.required };
  if (f.default) doc.default = f.default;
  return doc;
}

export function createFlexState(world) {
  let tx = 0;
  let zone = null; // the declared product time zone {name, rules} (ADR-259), set by declare()
  const entities = new Map(); // live entities by name
  const records = new Map(); // tenant-wide live records by id: { id, entityId, data, orgPath, key }

  /** The request's session: its node and, when one acts, the end user (ADR-257 decisions 2, 7). */
  function session() {
    const p = world.principal.current();
    const assertion = p ? { sub: p.sub, roles: p.roles, org_path: p.orgPath, act: p.act ?? null } : null;
    const acting = resolveActingPrincipal(state.bearer, assertion);
    if (acting.acting === "end_user" && acting.source === "assertion" && !atOrBelow(acting.org_path, state.bearer.org_path)) {
      throw unauthenticated("end-user assertion: org_path is outside the bearer's node");
    }
    return { node: acting.org_path, endUser: acting.acting === "end_user" ? { sub: acting.sub, roles: acting.roles } : null };
  }
  /** The end user this entity's owner policy scopes in session `s`, or null (no owner, tenant, bypass). */
  function ownerScope(e, s) {
    if (!e.owner || !s.endUser) return null;
    if (s.endUser.roles.some((r) => e.ownerBypassRoles.includes(r))) return null;
    return s.endUser.sub;
  }
  /** ADR-279 decision 3 (the executor's check): an acting end user holds one of `operation`'s roles. */
  function requireWriteRole(e, operation, s) {
    const required = e.writeRoles?.[operation] ?? [];
    if (!s.endUser || required.length === 0 || s.endUser.roles.some((r) => required.includes(r))) return;
    throw roleRequired(e.name, operation, required);
  }
  function ownerAdmits(e, r, s) {
    const sub = ownerScope(e, s);
    return sub === null || r.data[e.owner] === sub;
  }
  /** A row `s` reads: its node and below, a shared entity's strict-ancestor rows, the owner policy. */
  function readable(r, s) {
    const e = entityById(r.entityId);
    const placed = atOrBelow(r.orgPath, s.node) || (e.shared && strictAncestor(r.orgPath, s.node));
    return placed && ownerAdmits(e, r, s);
  }
  /** A row `s` writes: its node and below only (a shared ancestor row stays read-only), the owner policy. */
  function writable(r, s) {
    return atOrBelow(r.orgPath, s.node) && ownerAdmits(entityById(r.entityId), r, s);
  }
  function entityById(id) {
    for (const e of entities.values()) if (e.id === id) return e;
    throw new Error(`@aircloudhq/testing defect: no entity ${id}`);
  }

  function liveFields(e) {
    return e.fields.filter((f) => !f.deleted).sort((a, b) => a.tx - b.tx || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  function entityDoc(e) {
    return { id: e.id, name: e.name, display_name: e.displayName, fields: liveFields(e).map(fieldDoc) };
  }
  /** The base layer at `/` resolves at every node; an overlay only at its own node (decision 7). */
  function resolveEntity(name, s = session()) {
    const e = entities.get(name);
    if (!e || (e.orgPath !== "/" && e.orgPath !== s.node)) throw notFound(`entity '${name}' not found`);
    return e;
  }
  function recordsOf(e, s) {
    return [...records.values()].filter((r) => r.entityId === e.id && (s === undefined || readable(r, s)));
  }
  function serializeRecord(e, r) {
    const fields = liveFields(e);
    const out = {};
    for (const [k, v] of Object.entries(r.data)) {
      const f = fields.find((x) => x.name === k);
      out[k] = f ? canonicalize(f, v) : v;
    }
    return { id: r.id, data: out };
  }
  // One written field value, validated and canonicalized; a refusal is scoped to the field
  // (details.fields.<field>), as flex-jit's write_value does (#664 item 19).
  function writeValue(f, v) {
    try {
      validateValue(f, v);
      return canonicalize(f, v);
    } catch (e) {
      if (e instanceof CapabilityFailure && e.code === "flex.validation" && !e.details.fields) throw validation(e.detail, f.name);
      throw e;
    }
  }
  // ADR-259 decision 4 (ast.rs validate_record_create): an ABSENT field takes its default before the
  // required check — a literal filled and judged as a write, a generator queued for the insert; an
  // explicit null never takes one.
  function validateCreate(fields, data) {
    if (!isObj(data)) throw validation("record 'data' must be a JSON object");
    for (const name of Object.keys(data)) if (!fields.some((f) => f.name === name)) throw validation(`unknown field '${name}'`, name);
    const out = {};
    const generated = [];
    for (const f of fields) {
      if (!(f.name in data)) {
        if (f.default && "value" in f.default) out[f.name] = writeValue(f, f.default.value);
        else if (f.default) generated.push([f.name, f.default.generator]);
        else if (f.required) throw validation(`required field '${f.name}' is missing`, f.name);
        continue;
      }
      const v = data[f.name];
      if (v === null) {
        if (f.required) throw validation(`required field '${f.name}' must not be null`, f.name);
        continue;
      }
      out[f.name] = writeValue(f, v);
    }
    return { data: out, generated };
  }
  /**
   * Fill a create's generated defaults at ONE instant (exec.rs fill_generated): `now` is the world
   * clock's instant in canonical UTC, `today` its date in the declared product time zone; an environment
   * no declaration has converged has no zone, and a `today` default there refuses the create.
   */
  function fillGenerated(data, generated) {
    const ms = world.clock.nowMs();
    for (const [name, g] of generated) {
      if (g === "now") {
        data[name] = formatDatetimeMicros(BigInt(ms) * 1000n);
      } else {
        if (!zone) {
          throw validation("the 'today' default needs the product time zone, which PUT /v1/schema declares; this environment has no declaration", name);
        }
        data[name] = dateAt(zone.rules, Math.floor(ms / 1000));
      }
    }
    return data;
  }
  function validatePatch(fields, data) {
    if (!isObj(data)) throw validation("PATCH 'data' must be a JSON object");
    const set = {};
    const clear = [];
    for (const [name, v] of Object.entries(data)) {
      const f = fields.find((x) => x.name === name);
      if (!f) throw validation(`unknown field '${name}'`, name);
      if (v === null) {
        if (f.required) throw validation(`cannot clear required field '${name}' (null on a required field)`, name);
        clear.push(name);
      } else {
        set[name] = writeValue(f, v);
      }
    }
    return { set, clear };
  }
  function checkRelationTargets(e, data, s) {
    for (const f of liveFields(e)) {
      if (f.type !== "relation" || !(f.name in data)) continue;
      const target = records.get(data[f.name]);
      if (!target || !readable(target, s)) throw validation("relation target record is not visible", f.name);
      if (target.entityId !== f.parsed.targetEntityId) {
        throw validation("relation target belongs to a different entity than config.target_entity_id", f.name);
      }
    }
  }
  function recordData(body) {
    if (!isObj(body) || !("data" in body)) throw validation("record body requires a 'data' object");
    return body.data;
  }
  function insertFields(entity, specs) {
    const names = new Set(entity.fields.filter((f) => !f.deleted).map((f) => f.name));
    for (const s of specs) {
      if (names.has(s.name)) throw nameConflict();
      names.add(s.name);
    }
    return specs.map((s) => ({ ...s, id: world.newId(), tx, deleted: false }));
  }

  /**
   * A declared field's default, judged against the field as DECLARED (an enum's against its declared live
   * values), canonical; null when it declares none. A refusal is scoped to `<entity>.<field>`.
   */
  function declaredDefault(f, at) {
    if (f.default === undefined || f.default === null) return null;
    const parsed = f.type === "enum" ? parseConfig("enum", enumConfig(f)) : {};
    return scopedTo(at, () => validateDefault({ type: f.type, parsed }, parseDefault(f.default)));
  }
  /** The lists of a declared enum field as its config (`removed_values` absent ≡ none). */
  function enumConfig(f) {
    return { values: f.values ?? null, removed_values: f.removed_values ?? [] };
  }
  /**
   * The update ops a declaration makes on the LIVE base layer, or the refusal — decided before any change
   * (converge.rs `plan`: immutable changes first, then omissions). Each op carries its `apply`.
   */
  function planUpdates(declared) {
    const immutable = [];
    const omitted = [];
    const ops = [];
    for (const [name, d] of [...declared].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const e = entities.get(name);
      if (!e || d.removed) continue;
      for (const [n, f] of Object.entries(d.fields ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const x = liveFields(e).find((y) => y.name === n);
        if (!x) continue;
        if (x.type !== f.type) {
          immutable.push({ entity: name, field: n, attribute: "type", live: x.type, declared: f.type });
          continue;
        }
        if (f.removed) continue;
        // ADR-259 decision 5: adding, changing and clearing a default is one `update_default` (after
        // the field's enum lists, as converge.rs orders them).
        const wantDefault = declaredDefault(f, `${name}.${n}`);
        const defaultOp = JSON.stringify(wantDefault) === JSON.stringify(x.default ?? null) ? null : {
          op: "update_default", entity: name, field: n, apply: () => { x.default = wantDefault; },
        };
        if (x.type !== "enum") {
          if (defaultOp) ops.push(defaultOp);
          continue;
        }
        const want = enumConfig(f);
        const declaredValues = [...want.values, ...want.removed_values];
        for (const value of [...x.parsed.values, ...x.parsed.removedValues]) {
          if (!declaredValues.includes(value)) omitted.push({ entity: name, field: n, value });
        }
        const same = JSON.stringify(want.values) === JSON.stringify(x.parsed.values)
          && JSON.stringify(want.removed_values) === JSON.stringify(x.parsed.removedValues);
        if (!same) {
          ops.push({
            op: "update_enum_values", entity: name, field: n,
            apply: () => {
              x.config = { ...x.config, values: want.values, removed_values: want.removed_values };
              x.parsed = parseConfig("enum", want);
            },
          });
        }
        if (defaultOp) ops.push(defaultOp);
      }
    }
    const refuse = (code, list, what) => {
      if (list.length === 0) return;
      const names = list.map((v) => `${v.entity}.${v.field}${v.value ? ` value '${v.value}'` : ""}`).join(", ");
      throw new CapabilityFailure(code, `${what}: ${names}`, { ...list[0], violations: list });
    };
    refuse("flex.immutable_field", immutable, "the declaration changes an immutable attribute");
    refuse("flex.schema_omitted_live", omitted,
      "live base-layer entities or fields are absent from the declaration (removal is an explicit `removed = true`)");
    return ops;
  }

  const state = {
    // ── the WIT surface (called by the binder) ──────────────────────────────────────────
    query(entityName, queryJson) {
      const body = parseBody(queryJson);
      const s = session();
      const e = resolveEntity(entityName, s);
      const q = parseQuery(liveFields(e), body, world.contract.flexQueryLimit);
      admit(world, FLEX_METERS.query, 1, "flex");
      return JSON.stringify(runQuery(q, recordsOf(e, s)));
    },
    getRecord(entityName, id) {
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      const s = session();
      const e = resolveEntity(entityName, s);
      const r = records.get(rid);
      if (!r || r.entityId !== e.id || !readable(r, s)) throw notFound("record not found");
      return JSON.stringify(serializeRecord(e, r));
    },
    createRecord(entityName, recordJson) {
      const body = parseBody(recordJson);
      const s = session();
      const e = resolveEntity(entityName, s);
      const created = validateCreate(liveFields(e), recordData(body));
      requireWriteRole(e, "create", s);
      admit(world, FLEX_METERS.recordCreate, 1, "flex");
      const data = fillGenerated(created.data, created.generated);
      // Decision 4: an owner-scoped end user's create is owned by it, whatever the client sent.
      const sub = ownerScope(e, s);
      if (sub !== null) data[e.owner] = sub;
      checkRelationTargets(e, data, s);
      tx++;
      const r = { id: world.newId(), entityId: e.id, data: jsonbForm(data), orgPath: s.node, key: null };
      records.set(r.id, r);
      return JSON.stringify(serializeRecord(e, r));
    },
    updateRecord(entityName, id, patchJson) {
      const body = parseBody(patchJson);
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      const s = session();
      const e = resolveEntity(entityName, s);
      const plan = validatePatch(liveFields(e), recordData(body));
      requireWriteRole(e, "update", s);
      const r = records.get(rid);
      if (!r || r.entityId !== e.id || !writable(r, s)) throw notFound("record not found");
      // Decision 4: an owner-scoped end user cannot hand its record to another (or to none); restating
      // its own sub is not a change.
      const sub = ownerScope(e, s);
      if (sub !== null && (plan.clear.includes(e.owner) || (e.owner in plan.set && plan.set[e.owner] !== sub))) {
        throw forbidden(`the owner field '${e.owner}' cannot be changed by an owner-scoped end user`);
      }
      const merged = { ...r.data, ...plan.set };
      for (const k of plan.clear) delete merged[k];
      const stored = jsonbForm(merged);
      // A PATCH that changes nothing is decided BEFORE the wallet (exec.rs patch_record_tx, #645).
      if (JSON.stringify(stored) === JSON.stringify(r.data)) return JSON.stringify(serializeRecord(e, r));
      checkRelationTargets(e, plan.set, s);
      admit(world, FLEX_METERS.recordUpdate, 1, "flex");
      tx++;
      r.data = stored;
      return JSON.stringify(serializeRecord(e, r));
    },
    deleteRecord(entityName, id) {
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      const s = session();
      const e = resolveEntity(entityName, s);
      requireWriteRole(e, "delete", s);
      admit(world, FLEX_METERS.recordDelete, 1, "flex");
      const r = records.get(rid);
      if (!r || r.entityId !== e.id || !writable(r, s)) throw notFound("record not found");
      tx++;
      records.delete(rid);
      return "{}";
    },
    createEntity(entityJson) {
      const body = parseBody(entityJson);
      if (!isObj(body)) throw validation("entity body must be an object");
      if (typeof body.name !== "string") throw validation("entity 'name' is required");
      const name = body.name;
      if (!SLUG_RE.test(name)) throw validation(`'${name}' is not a valid API name (grammar ^[a-z][a-z0-9_]{0,62}$)`);
      if (name.startsWith(RESERVED_ENTITY_PREFIX)) {
        throw validation(`entity name '${name}' uses the reserved '${RESERVED_ENTITY_PREFIX}' prefix`, "name");
      }
      const displayName = typeof body.display_name === "string" ? body.display_name : name;
      if (!Array.isArray(body.fields)) throw validation("entity 'fields' array is required");
      const specs = body.fields.map(parseNewField);
      const s = session();
      admit(world, FLEX_METERS.entityCreate, 1, "flex");
      if (entities.has(name)) throw nameConflict();
      tx++;
      // An entity created through the API is a layer at the session's node: the base layer at `/`, an
      // org overlay below it. Owner and shared are base-layer declarations only (declare).
      const e = { id: world.newId(), name, displayName, fields: [], orgPath: s.node, owner: null, ownerBypassRoles: [], shared: false };
      e.fields = insertFields(e, specs);
      entities.set(name, e);
      // The create response lists fields in REQUEST order (exec.rs create_entity); a later
      // get-entity orders them by (created_at, name).
      return JSON.stringify({ id: e.id, name, display_name: displayName, fields: e.fields.map(fieldDoc) });
    },
    listEntities() {
      const s = session();
      const list = [...entities.values()]
        .filter((e) => e.orgPath === "/" || e.orgPath === s.node)
        .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
        .map((e) => ({ id: e.id, name: e.name, display_name: e.displayName }));
      return JSON.stringify({ entities: list });
    },
    getEntity(name) {
      return JSON.stringify(entityDoc(resolveEntity(name)));
    },
    deleteEntity(name) {
      const e = resolveEntity(name);
      admit(world, FLEX_METERS.entityDelete, 1, "flex");
      tx++;
      entities.delete(e.name);
      return "{}";
    },
    addField(entityName, fieldJson) {
      const body = parseBody(fieldJson);
      const e = resolveEntity(entityName);
      const spec = parseNewField(body);
      admit(world, FLEX_METERS.fieldCreate, 1, "flex");
      tx++;
      const [f] = insertFields(e, [spec]);
      e.fields.push(f);
      return JSON.stringify(fieldDoc(f));
    },
    updateField(entityName, fieldName, patchJson) {
      const body = parseBody(patchJson);
      if (!isObj(body)) throw validation("field patch body must be an object");
      if ("type" in body || "config" in body) {
        throw new CapabilityFailure("flex.immutable_field", "field type/config.dims/config.target_entity_id are immutable", {});
      }
      const displayName = typeof body.display_name === "string" ? body.display_name : undefined;
      const required = typeof body.required === "boolean" ? body.required : undefined;
      for (const k of Object.keys(body)) {
        if (!["display_name", "required", "default"].includes(k)) throw validation(`unknown key '${k}' in the field patch body`);
      }
      const e = resolveEntity(entityName);
      const f = liveFields(e).find((x) => x.name === fieldName);
      if (!f) throw notFound(`field '${fieldName}' not found`);
      // ADR-259 decision 3: null clears the default; a default is judged against the field as it stands,
      // and the owner field takes none.
      let dflt;
      if ("default" in body) {
        if (body.default === null) {
          dflt = null;
        } else {
          const d = scopedTo("default", () => parseDefault(body.default));
          if (e.owner === fieldName) throw validation("the owner field takes no default (ADR-259 decision 2)", "default");
          dflt = scopedTo("default", () => validateDefault(f, d));
        }
      }
      // The PATCH response omits display_name (exec.rs patch_field's RETURNING list).
      const doc = () => {
        const out = { id: f.id, name: f.name, type: f.type, config: f.config, required: f.required };
        if (f.default) out.default = f.default;
        return JSON.stringify(out);
      };
      // A PATCH that changes nothing is decided BEFORE the wallet (exec.rs patch_field, #645).
      const noop = (displayName === undefined || displayName === f.displayName)
        && (required === undefined || required === f.required)
        && (dflt === undefined || JSON.stringify(dflt) === JSON.stringify(f.default ?? null));
      if (noop) return doc();
      admit(world, FLEX_METERS.fieldUpdate, 1, "flex");
      if (displayName !== undefined) f.displayName = displayName;
      if (required !== undefined) f.required = required;
      if (dflt !== undefined) f.default = dflt;
      return doc();
    },
    updateEntity(name, patchJson) {
      const body = parseBody(patchJson);
      if (!isObj(body)) throw validation("entity patch body must be an object");
      if ("name" in body || "fields" in body) {
        throw new CapabilityFailure("flex.immutable_field",
          "an entity's name is immutable and its fields change through /fields", {});
      }
      let displayName;
      if ("display_name" in body) {
        if (typeof body.display_name !== "string" || body.display_name === "") {
          throw validation("display_name must be a non-empty string", "display_name");
        }
        displayName = body.display_name;
      }
      const e = resolveEntity(name);
      // A PATCH that changes nothing is decided BEFORE the wallet (exec.rs patch_entity, #645).
      if (displayName === undefined || displayName === e.displayName) return JSON.stringify(entityDoc(e));
      admit(world, FLEX_METERS.entityUpdate, 1, "flex");
      e.displayName = displayName;
      return JSON.stringify(entityDoc(e));
    },
    removeField(entityName, fieldName) {
      const e = resolveEntity(entityName);
      admit(world, FLEX_METERS.fieldDelete, 1, "flex");
      const f = liveFields(e).find((x) => x.name === fieldName);
      if (!f) throw notFound(`field '${fieldName}' not found`);
      tx++;
      f.deleted = true;
      return "{}";
    },

    // ── the test-author API (never reachable from a guest) ──────────────────────────────
    /**
     * The bearer the function's Flex calls carry: the runtime's service account at `/`. A test may set
     * another ({plane, sub, roles, org_path}) — an `end_user` bearer, or a service account of an org node.
     */
    bearer: RUNTIME_BEARER,
    /**
     * Converge the base layer as the release's PUT /v1/schema does (ADR-217 D4): `declaration` is
     * {entities: {<name>: {display_name, owner, owner_bypass_roles, shared, write_roles, fields: {<field>: {type,
     * required, display_name, target, dims, values, removed_values, default}}}}, time_zone,
     * time_zone_rules} — the shape db/schema/*.toml compiles to (the zone and its rules from the release's
     * locale bundle, required — ADR-259 decision 1, R35). A default converges as one `update_default`. Owner and shared are declared here only (ADR-257 decision 1); an entity not yet live is
     * created at `/`. An enum's value lists converge as flex/src/converge.rs plans them (ADR-258 decision
     * 4): adding, reordering, restoring and tombstoning a value is one `update_enum_values`; a value the
     * environment knows that both declared lists omit is flex.schema_omitted_live naming it; a type change
     * is flex.immutable_field — every refusal decided before anything changes. Returns {applied} for the
     * update ops it makes, per entity then per field by name (the create ops a first declaration makes
     * are not reported).
     */
    declare(declaration) {
      if (!isObj(declaration) || !isObj(declaration.entities)) throw validation("a schema declaration carries 'entities'");
      const saved = world.quota.suspend();
      try {
        const declared = Object.entries(declaration.entities);
        // #748: an entity created through the API is a layer at the session's node (createEntity), a
        // schema-converged one the base layer at `/` (converge.rs BASE_LAYER). A test that defined the
        // entity at a signed-in node and then declares the schema would converge over another node's
        // layer — the silent overlay that hid the schema from every other node. Refused before any change.
        for (const [name] of declared) {
          const live = entities.get(name);
          if (live && live.orgPath !== "/") {
            throw new DoubleMisuseError(`flex.declare: entity '${name}' was created at ${live.orgPath} by defineEntity (an API-created entity is a layer at the signed-in node), and the schema declares it at / — declare a schema entity only through declareFromSchema, never also with defineEntity`);
          }
        }
        for (const [name, d] of declared) {
          if (d.owner_bypass_roles && !d.owner) throw validation(`entity '${name}': owner_bypass_roles is valid only with owner`);
          if (d.owner && d.shared) throw validation(`entity '${name}': an owned entity cannot be shared`);
          parseWriteRoles(name, d.write_roles);
          const fields = Object.entries(d.fields ?? {});
          if (d.owner) {
            const f = fields.find(([n]) => n === d.owner);
            if (!f) throw validation(`entity '${name}': owner '${d.owner}' names no field`);
            // ADR-283 decision 7: the owner holds one line, the end user's sub.
            if (f[1].type !== "string") throw validation(`entity '${name}': owner '${d.owner}' is not a string field`);
          }
          for (const [n, f] of fields) {
            const lists = (f.values ?? null) !== null || (f.removed_values ?? null) !== null;
            if (f.type !== "enum" && lists) throw validation("'values' and 'removed_values' are only legal on an enum", `${name}.${n}`);
            if (f.type === "enum") {
              try { parseConfig("enum", enumConfig(f)); } catch (e) { throw validation(e.detail, `${name}.${n}`); }
            }
            declaredDefault(f, `${name}.${n}`);
          }
        }
        // ADR-259 decision 1 (R35): the product time zone and its rules, required.
        if (typeof declaration.time_zone !== "string") {
          throw validation("the declaration requires 'time_zone', the product time zone (ADR-259)", "time_zone");
        }
        if (!ZONE_NAME_RE.test(declaration.time_zone)) {
          throw validation(`'${declaration.time_zone}' is not a zone name (grammar ^[A-Za-z0-9_+./-]+$)`, "time_zone");
        }
        if (declaration.time_zone_rules === undefined || declaration.time_zone_rules === null) {
          throw validation("the declaration requires 'time_zone_rules', the zone's rules from the release's locale bundle", "time_zone_rules");
        }
        const rules = parseZone(declaration.time_zone_rules);
        // ADR-259 decision 2: the owner field takes no default (converge.rs plan, after parsing).
        for (const [name, d] of declared) {
          const f = d.owner ? (d.fields ?? {})[d.owner] : undefined;
          if (f && f.default !== undefined && f.default !== null) {
            throw validation("the owner field takes no default (ADR-259 decision 2)", `${name}.${d.owner}`);
          }
        }
        const applied = planUpdates(declared);
        const spec = (n, f) => ({
          name: n, type: f.type, required: f.required ?? false, ...(f.display_name ? { display_name: f.display_name } : {}),
          config: f.type === "relation" ? { target_entity_id: entities.get(f.target)?.id ?? null }
            : f.type === "vector" ? { dims: f.dims }
            : f.type === "enum" ? enumConfig(f) : {},
          ...(f.default === undefined || f.default === null ? {} : { default: f.default }),
        });
        // Entities first (a relation names its target by entity), then their relation fields.
        for (const [name, d] of declared) {
          let e = entities.get(name);
          if (!e) {
            const plain = Object.entries(d.fields ?? {}).filter(([, f]) => f.type !== "relation").map(([n, f]) => spec(n, f));
            state.createEntity(JSON.stringify({ name, ...(d.display_name ? { display_name: d.display_name } : {}), fields: plain }));
            e = entities.get(name);
            e.orgPath = "/";
          }
          e.owner = d.owner ?? null;
          e.ownerBypassRoles = [...(d.owner_bypass_roles ?? [])];
          e.shared = d.shared === true;
          e.writeRoles = parseWriteRoles(name, d.write_roles);
        }
        for (const [name, d] of declared) {
          const e = entities.get(name);
          for (const [n, f] of Object.entries(d.fields ?? {})) {
            if (liveFields(e).some((x) => x.name === n)) continue;
            if (f.type === "relation" && !entities.has(f.target)) throw validation(`relation '${name}.${n}' targets no entity '${f.target}'`, n);
            state.addField(name, JSON.stringify(spec(n, f)));
          }
        }
        for (const u of applied) u.apply();
        zone = { name: declaration.time_zone, rules };
        return { applied: applied.map(({ op, entity, field }) => ({ op, entity, field })) };
      } finally {
        world.quota.resume(saved);
      }
    },
    /**
     * Converge the base layer to the product's compiled schema (#755 D15): the PUT /v1/schema declaration
     * `aircloud test prepare` writes from db/schema/*.toml (the grammar's one parser, Rails' db/schema.rb)
     * and the release's tests part mounts — read from the product the working directory sits in, at
     * productSchemaFile. Every schema entity is created at `/` (converge.rs BASE_LAYER), whatever node a
     * test signed in at; owner, owner_bypass_roles, shared and defaults are the declared ones (declare).
     * `testEntities` ({<name>: {fields: {<field>: {type, …}}, …}}) declares test-only entities beside the
     * schema's, in the same base layer — a name the schema declares is a misuse, never an override.
     */
    declareFromSchema(testEntities = {}) {
      const root = productRoot(process.cwd());
      if (root === null) {
        throw new DoubleMisuseError("flex.declareFromSchema: not inside a product (no aircloud.toml at or above the working directory)");
      }
      const rel = productSchemaFile(root);
      const file = join(root, rel);
      if (!existsSync(file)) {
        throw new DoubleMisuseError(`flex.declareFromSchema: no compiled schema at ${rel} — run \`${PRODUCT_SCHEMA_WRITER}\` in the product (npm test's pretest and \`aircloud test\` run it)`);
      }
      let declaration;
      try {
        declaration = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw new DoubleMisuseError(`flex.declareFromSchema: ${rel} is not JSON (${e.message}) — rerun \`${PRODUCT_SCHEMA_WRITER}\``);
      }
      if (!isObj(testEntities)) throw new DoubleMisuseError("flex.declareFromSchema: test entities are {<name>: {fields: {…}}}");
      const schemaEntities = isObj(declaration.entities) ? declaration.entities : {};
      for (const name of Object.keys(testEntities)) {
        if (Object.hasOwn(schemaEntities, name)) {
          throw new DoubleMisuseError(`flex.declareFromSchema: test entity '${name}' is declared by db/schema/${name}.toml — a test converges to the schema, never to a copy of it`);
        }
      }
      return state.declare({ ...declaration, entities: { ...schemaEntities, ...testEntities } });
    },
    /**
     * PUT /v1/entities/{entity}/records/by-key/{key} — the seed surface (ADR-217 D6): create or replace the
     * record holding natural key `key`. An acting end user is refused (flex.forbidden, ADR-257 decision 4).
     * Returns {created, record}.
     */
    upsertByKey(entityName, key, data) {
      const s = session();
      if (s.endUser) throw forbidden("the keyed upsert is a seed surface; an acting end user cannot use it");
      if (typeof key !== "string" || !SLUG_RE.test(key)) throw validation(`'${String(key)}' is not a valid key`, "key");
      const e = resolveEntity(entityName, s);
      const existing = [...records.values()].find((r) => r.entityId === e.id && r.key === key && writable(r, s));
      const saved = world.quota.suspend();
      try {
        if (existing) {
          return { created: false, record: JSON.parse(state.updateRecord(entityName, existing.id, JSON.stringify({ data }))) };
        }
        const record = JSON.parse(state.createRecord(entityName, JSON.stringify({ data })));
        records.get(record.id).key = key;
        return { created: true, record };
      } finally {
        world.quota.resume(saved);
      }
    },
    /**
     * The relation edges (flex.sys_edges) the current session sees pointing `to` a record or leaving it
     * (`from`) — the count. An edge lives at its source's node: visible when that row's placement is (the
     * node and below, or a shared entity's strict ancestor) and, to an acting end user, only when both
     * endpoints are readable (ADR-257 decisions 4, 7).
     */
    edges({ to, from } = {}) {
      const s = session();
      let n = 0;
      for (const src of records.values()) {
        const e = entityById(src.entityId);
        const placed = atOrBelow(src.orgPath, s.node) || (e.shared && strictAncestor(src.orgPath, s.node));
        if (!placed) continue;
        for (const f of liveFields(e)) {
          if (f.type !== "relation" || typeof src.data[f.name] !== "string") continue;
          const dst = records.get(src.data[f.name]);
          if (!dst || (to !== undefined && dst.id !== to) || (from !== undefined && src.id !== from)) continue;
          if (s.endUser && !(readable(src, s) && readable(dst, s))) continue;
          n++;
        }
      }
      return n;
    },
    /** Declare an entity exactly as create-entity would (same validation); returns its doc. */
    defineEntity(spec) {
      return JSON.parse(state.createEntityUnmetered(spec));
    },
    createEntityUnmetered(spec) {
      const saved = world.quota.suspend();
      try { return state.createEntity(JSON.stringify(spec)); } finally { world.quota.resume(saved); }
    },
    /** Seed one record through the create path (validation included); returns the record doc. */
    insert(entityName, data) {
      const saved = world.quota.suspend();
      try { return JSON.parse(state.createRecord(entityName, JSON.stringify({ data }))); } finally { world.quota.resume(saved); }
    },
    /** The live records of an entity, as record docs, in id order. */
    records(entityName) {
      const e = entities.get(entityName);
      if (!e) throw new DoubleMisuseError(`flex.records: no entity '${entityName}'`);
      return recordsOf(e).sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => serializeRecord(e, r));
    },
    entityNames() {
      return [...entities.keys()].sort();
    },
  };
  return state;
}

export { ID_RE };
