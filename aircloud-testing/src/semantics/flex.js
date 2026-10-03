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
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import { admit } from "./quota.js";
import {
  canonicalize, FIELD_TYPES, ID_RE, jsonbForm, parseConfig, SLUG_RE, validateValue, validation,
} from "./flex-values.js";
import { parseQuery, runQuery } from "./flex-query.js";

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
  return { name: v.name, displayName, type: v.type, config, parsed, required };
}

function fieldDoc(f) {
  return { id: f.id, name: f.name, display_name: f.displayName, type: f.type, config: f.config, required: f.required };
}

export function createFlexState(world) {
  let tx = 0;
  const entities = new Map(); // live entities by name
  const records = new Map(); // tenant-wide live records by id: { id, entityId, data }

  function liveFields(e) {
    return e.fields.filter((f) => !f.deleted).sort((a, b) => a.tx - b.tx || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  function entityDoc(e) {
    return { id: e.id, name: e.name, display_name: e.displayName, fields: liveFields(e).map(fieldDoc) };
  }
  function resolveEntity(name) {
    const e = entities.get(name);
    if (!e) throw notFound(`entity '${name}' not found`);
    return e;
  }
  function recordsOf(e) {
    return [...records.values()].filter((r) => r.entityId === e.id);
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
  function validateCreate(fields, data) {
    if (!isObj(data)) throw validation("record 'data' must be a JSON object");
    for (const name of Object.keys(data)) if (!fields.some((f) => f.name === name)) throw validation(`unknown field '${name}'`, name);
    const out = {};
    for (const f of fields) {
      if (!(f.name in data)) {
        if (f.required) throw validation(`required field '${f.name}' is missing`, f.name);
        continue;
      }
      const v = data[f.name];
      if (v === null) {
        if (f.required) throw validation(`required field '${f.name}' must not be null`, f.name);
        continue;
      }
      validateValue(f, v);
      out[f.name] = canonicalize(f, v);
    }
    return out;
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
        validateValue(f, v);
        set[name] = canonicalize(f, v);
      }
    }
    return { set, clear };
  }
  function checkRelationTargets(e, data) {
    for (const f of liveFields(e)) {
      if (f.type !== "relation" || !(f.name in data)) continue;
      const target = records.get(data[f.name]);
      if (!target) throw validation("relation target record is not visible", f.name);
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

  const state = {
    // ── the WIT surface (called by the binder) ──────────────────────────────────────────
    query(entityName, queryJson) {
      const body = parseBody(queryJson);
      const e = resolveEntity(entityName);
      const q = parseQuery(liveFields(e), body);
      admit(world, FLEX_METERS.query, 1, "flex");
      return JSON.stringify(runQuery(q, recordsOf(e)));
    },
    getRecord(entityName, id) {
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      const e = resolveEntity(entityName);
      const r = records.get(rid);
      if (!r || r.entityId !== e.id) throw notFound("record not found");
      return JSON.stringify(serializeRecord(e, r));
    },
    createRecord(entityName, recordJson) {
      const body = parseBody(recordJson);
      const e = resolveEntity(entityName);
      const data = validateCreate(liveFields(e), recordData(body));
      admit(world, FLEX_METERS.recordCreate, 1, "flex");
      checkRelationTargets(e, data);
      tx++;
      const r = { id: world.newId(), entityId: e.id, data: jsonbForm(data) };
      records.set(r.id, r);
      return JSON.stringify(serializeRecord(e, r));
    },
    updateRecord(entityName, id, patchJson) {
      const body = parseBody(patchJson);
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      const e = resolveEntity(entityName);
      const plan = validatePatch(liveFields(e), recordData(body));
      const r = records.get(rid);
      if (!r) throw notFound("record not found");
      const merged = { ...r.data, ...plan.set };
      for (const k of plan.clear) delete merged[k];
      const stored = jsonbForm(merged);
      // A PATCH that changes nothing is decided BEFORE the wallet (exec.rs patch_record_tx, #645).
      if (JSON.stringify(stored) === JSON.stringify(r.data)) return JSON.stringify(serializeRecord(e, r));
      checkRelationTargets(e, plan.set);
      admit(world, FLEX_METERS.recordUpdate, 1, "flex");
      tx++;
      r.data = stored;
      return JSON.stringify(serializeRecord(e, r));
    },
    deleteRecord(entityName, id) {
      const rid = parseUuid(id);
      if (rid === null) throw notFound("record not found");
      resolveEntity(entityName);
      admit(world, FLEX_METERS.recordDelete, 1, "flex");
      if (!records.has(rid)) throw notFound("record not found");
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
      admit(world, FLEX_METERS.entityCreate, 1, "flex");
      if (entities.has(name)) throw nameConflict();
      tx++;
      const e = { id: world.newId(), name, displayName, fields: [] };
      e.fields = insertFields(e, specs);
      entities.set(name, e);
      // The create response lists fields in REQUEST order (exec.rs create_entity); a later
      // get-entity orders them by (created_at, name).
      return JSON.stringify({ id: e.id, name, display_name: displayName, fields: e.fields.map(fieldDoc) });
    },
    listEntities() {
      const list = [...entities.values()]
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
      const e = resolveEntity(entityName);
      const f = liveFields(e).find((x) => x.name === fieldName);
      if (!f) throw notFound(`field '${fieldName}' not found`);
      // The PATCH response omits display_name (exec.rs patch_field's RETURNING list).
      const doc = () => JSON.stringify({ id: f.id, name: f.name, type: f.type, config: f.config, required: f.required });
      // A PATCH that changes nothing is decided BEFORE the wallet (exec.rs patch_field, #645).
      const noop = (displayName === undefined || displayName === f.displayName)
        && (required === undefined || required === f.required);
      if (noop) return doc();
      admit(world, FLEX_METERS.fieldUpdate, 1, "flex");
      if (displayName !== undefined) f.displayName = displayName;
      if (required !== undefined) f.required = required;
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
